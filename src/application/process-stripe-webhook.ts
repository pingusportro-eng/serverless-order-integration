import type { PaymentRepository } from './payment-repository.js';
import type { OrderRepository } from './order-repository.js';
import { OrderVersionConflictError } from './order-repository.js';
import type { StripePaymentClient, StripePaymentIntentSnapshot } from './stripe-payment-client.js';
import {
  StripeWebhookReconciliationError,
  type StripeWebhookEventRecord,
  type StripeWebhookOrderMutation,
  type StripeWebhookRepository,
} from './stripe-webhook-repository.js';
import type { Order } from '../domain/order.js';
import { applyOrderStatusChange } from '../domain/order-status-transition.js';
import { applyPaymentStatusChange } from '../domain/payment-status-transition.js';

const MAX_CONCURRENT_WRITE_ATTEMPTS = 3;

export const SUPPORTED_STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.canceled',
] as const;

export type SupportedStripeWebhookEventType = (typeof SUPPORTED_STRIPE_WEBHOOK_EVENTS)[number];

export interface ProcessStripeWebhookDependencies {
  readonly repository: StripeWebhookRepository & PaymentRepository & OrderRepository;
  readonly stripeClient: StripePaymentClient;
  readonly now?: () => Date;
}

export interface ProcessStripeWebhookCommand {
  readonly eventId: string;
  readonly eventType: SupportedStripeWebhookEventType;
  readonly stripePaymentIntentId: string;
  readonly eventFingerprint: string;
  readonly correlationId: string;
}

export type ProcessStripeWebhookResult =
  | { readonly outcome: 'applied' | 'ignored'; readonly order: Order }
  | {
      readonly outcome: 'reconciliation_required';
      readonly reasonCode: string;
      readonly recorded: boolean;
      readonly order?: Order;
    };

type ProposedChange =
  | {
      readonly outcome: 'APPLIED';
      readonly order: Order;
      readonly mutation: StripeWebhookOrderMutation;
    }
  | { readonly outcome: 'IGNORED' }
  | { readonly outcome: 'RECONCILIATION_REQUIRED'; readonly reasonCode: string };

function sameMoney(order: Order, snapshot: StripePaymentIntentSnapshot): boolean {
  return (
    order.payment?.amount.amountMinor === snapshot.amount.amountMinor &&
    order.payment.amount.currency === snapshot.amount.currency
  );
}

function reconciliation(reasonCode: string): ProposedChange {
  return { outcome: 'RECONCILIATION_REQUIRED', reasonCode };
}

function paymentChangedOrder(
  current: Order,
  snapshot: StripePaymentIntentSnapshot,
  changedAt: string,
): Order {
  if (current.payment === undefined) {
    throw new StripeWebhookReconciliationError('PAYMENT_VALUE_MISSING');
  }
  if (snapshot.status === 'NOT_STARTED') {
    throw new StripeWebhookReconciliationError('INVALID_STRIPE_STATUS');
  }
  const payment = applyPaymentStatusChange(
    current.payment,
    {
      targetStatus: snapshot.status,
      stripePaymentIntentId: snapshot.stripePaymentIntentId,
      ...(snapshot.lastFailureReasonCode === undefined
        ? {}
        : {
            lastFailure: {
              reasonCode: snapshot.lastFailureReasonCode,
              occurredAt: changedAt,
            },
          }),
    },
    changedAt,
  );
  if (payment === current.payment) {
    return current;
  }
  return {
    ...current,
    payment,
    updatedAt: changedAt,
    version: current.version + 1,
  };
}

function statusChangedOrder(
  current: Order,
  snapshot: StripePaymentIntentSnapshot,
  changedAt: string,
): Order {
  const paymentOrder = paymentChangedOrder(current, snapshot, changedAt);
  if (paymentOrder.payment === undefined) {
    throw new StripeWebhookReconciliationError('PAYMENT_VALUE_MISSING');
  }
  const base: Order = { ...current, payment: paymentOrder.payment };
  return applyOrderStatusChange(
    base,
    { targetStatus: snapshot.status === 'SUCCEEDED' ? 'PENDING_SUBMISSION' : 'CANCELLED' },
    changedAt,
  );
}

function proposeChange(
  current: Order,
  snapshot: StripePaymentIntentSnapshot,
  changedAt: string,
): ProposedChange {
  if (current.merchantId !== snapshot.merchantId || current.orderId !== snapshot.orderId) {
    return reconciliation('OWNERSHIP_MISMATCH');
  }
  if (!sameMoney(current, snapshot)) {
    return reconciliation('AMOUNT_OR_CURRENCY_MISMATCH');
  }
  const storedIntentId = current.payment?.stripePaymentIntentId;
  if (storedIntentId !== undefined && storedIntentId !== snapshot.stripePaymentIntentId) {
    return reconciliation('PAYMENT_INTENT_MAPPING_CONFLICT');
  }

  if (current.status !== 'AWAITING_PAYMENT') {
    if (
      current.payment?.status === snapshot.status &&
      current.payment.stripePaymentIntentId === snapshot.stripePaymentIntentId
    ) {
      return { outcome: 'IGNORED' };
    }
    return reconciliation('ORDER_ALREADY_PROGRESSED');
  }

  try {
    const changedOrder =
      snapshot.status === 'SUCCEEDED' || snapshot.status === 'CANCELLED'
        ? statusChangedOrder(current, snapshot, changedAt)
        : paymentChangedOrder(current, snapshot, changedAt);
    if (changedOrder === current) {
      return { outcome: 'IGNORED' };
    }
    const mutation: StripeWebhookOrderMutation =
      changedOrder.status === current.status
        ? {
            kind: 'ORDER_PAYMENT_CHANGED',
            previousPaymentStatus: current.payment?.status ?? 'NOT_STARTED',
            correlationId: '',
            causationId: '',
          }
        : {
            kind: 'ORDER_STATUS_CHANGED',
            previousStatus: current.status,
            correlationId: '',
            causationId: '',
          };
    return { outcome: 'APPLIED', order: changedOrder, mutation };
  } catch (error: unknown) {
    if (error instanceof StripeWebhookReconciliationError) {
      return reconciliation(error.reasonCode);
    }
    throw error;
  }
}

function tracedMutation(
  mutation: StripeWebhookOrderMutation,
  command: ProcessStripeWebhookCommand,
): StripeWebhookOrderMutation {
  return { ...mutation, correlationId: command.correlationId, causationId: command.eventId };
}

async function resolveOrder(
  repository: ProcessStripeWebhookDependencies['repository'],
  snapshot: StripePaymentIntentSnapshot,
): Promise<{ readonly order?: Order; readonly ensureMapping: boolean }> {
  const mappedOrder = await repository.getByStripePaymentIntentId(snapshot.stripePaymentIntentId);
  if (mappedOrder !== undefined) {
    return { order: mappedOrder, ensureMapping: false };
  }
  const order = await repository.get(snapshot.merchantId, snapshot.orderId);
  return {
    ...(order === undefined ? {} : { order }),
    ensureMapping: true,
  };
}

export async function processStripeWebhook(
  dependencies: ProcessStripeWebhookDependencies,
  command: ProcessStripeWebhookCommand,
): Promise<ProcessStripeWebhookResult> {
  const snapshot = await dependencies.stripeClient.retrievePaymentIntent(
    command.stripePaymentIntentId,
  );
  const processedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const event: StripeWebhookEventRecord = {
    eventId: command.eventId,
    eventType: command.eventType,
    eventFingerprint: command.eventFingerprint,
    stripePaymentIntentId: snapshot.stripePaymentIntentId,
    processedAt,
  };

  for (let attempt = 1; attempt <= MAX_CONCURRENT_WRITE_ATTEMPTS; attempt += 1) {
    const resolved = await resolveOrder(dependencies.repository, snapshot);
    const proposed =
      resolved.order === undefined
        ? reconciliation('ORDER_NOT_FOUND')
        : proposeChange(resolved.order, snapshot, processedAt);
    try {
      let recordResult;
      if (proposed.outcome === 'RECONCILIATION_REQUIRED') {
        recordResult = await dependencies.repository.recordStripeWebhookReconciliationRequired({
          event,
          reasonCode: proposed.reasonCode,
          ...(resolved.order === undefined
            ? {
                missingOrder: {
                  merchantId: snapshot.merchantId,
                  orderId: snapshot.orderId,
                },
              }
            : { currentOrder: resolved.order }),
        });
      } else {
        if (resolved.order === undefined) {
          throw new Error('An applicable Stripe event must resolve to an order.');
        }
        recordResult =
          proposed.outcome === 'APPLIED'
            ? await dependencies.repository.applyStripeWebhookChange({
                event,
                currentOrder: resolved.order,
                changedOrder: proposed.order,
                mutation: tracedMutation(proposed.mutation, command),
                ensurePaymentIntentMapping: resolved.ensureMapping,
              })
            : await dependencies.repository.recordIgnoredStripeWebhook({
                event,
                currentOrder: resolved.order,
                ensurePaymentIntentMapping: resolved.ensureMapping,
              });
      }

      if (recordResult === 'duplicate') {
        return proposed.outcome === 'RECONCILIATION_REQUIRED'
          ? {
              outcome: 'reconciliation_required',
              reasonCode: proposed.reasonCode,
              recorded: false,
              ...(resolved.order === undefined ? {} : { order: resolved.order }),
            }
          : { outcome: 'ignored', order: resolved.order as Order };
      }
      if (proposed.outcome === 'RECONCILIATION_REQUIRED') {
        return {
          outcome: 'reconciliation_required',
          reasonCode: proposed.reasonCode,
          recorded: true,
          ...(resolved.order === undefined ? {} : { order: resolved.order }),
        };
      }
      return {
        outcome: proposed.outcome === 'APPLIED' ? 'applied' : 'ignored',
        order: proposed.outcome === 'APPLIED' ? proposed.order : (resolved.order as Order),
      };
    } catch (error: unknown) {
      if (error instanceof OrderVersionConflictError && attempt < MAX_CONCURRENT_WRITE_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }

  throw new Error('Stripe webhook processing exhausted its concurrency attempts.');
}
