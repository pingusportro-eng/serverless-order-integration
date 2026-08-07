import { OrderNotFoundError, type OrderRepository } from './order-repository.js';
import {
  StripePaymentIntentBindingConflictError,
  type PaymentRepository,
} from './payment-repository.js';
import type { StripePaymentClient, StripePaymentIntentSnapshot } from './stripe-payment-client.js';
import type { MerchantId, Order, OrderId } from '../domain/order.js';
import { applyPaymentStatusChange } from '../domain/payment-status-transition.js';

export interface PrepareStripePaymentIntentDependencies {
  readonly repository: OrderRepository & PaymentRepository;
  readonly stripeClient: StripePaymentClient;
  readonly now?: () => Date;
}

export interface PrepareStripePaymentIntentCommand {
  readonly merchantId: MerchantId;
  readonly orderId: OrderId;
  readonly correlationId: string;
  readonly causationId: string;
}

export interface PrepareStripePaymentIntentResult {
  readonly outcome: 'created' | 'replayed';
  readonly order: Order;
  readonly stripePaymentIntent: StripePaymentIntentSnapshot;
}

export class PaymentPreparationNotAllowedError extends Error {
  override readonly name = 'PaymentPreparationNotAllowedError';

  constructor() {
    super('The order is not ready to prepare a Stripe PaymentIntent.');
  }
}

export class StripePaymentIntentContractError extends Error {
  override readonly name = 'StripePaymentIntentContractError';

  constructor(readonly field: string) {
    super(`Stripe returned an inconsistent PaymentIntent field: ${field}.`);
  }
}

function assertStripeSnapshot(
  order: Order,
  snapshot: StripePaymentIntentSnapshot,
  expectedStripePaymentIntentId?: string,
): asserts snapshot is StripePaymentIntentSnapshot & {
  readonly status: Exclude<StripePaymentIntentSnapshot['status'], 'NOT_STARTED'>;
  readonly clientSecret: string;
} {
  const payment = order.payment;
  if (payment === undefined) {
    throw new PaymentPreparationNotAllowedError();
  }
  if (
    expectedStripePaymentIntentId !== undefined &&
    snapshot.stripePaymentIntentId !== expectedStripePaymentIntentId
  ) {
    throw new StripePaymentIntentContractError('stripePaymentIntentId');
  }
  if (snapshot.merchantId !== order.merchantId) {
    throw new StripePaymentIntentContractError('merchantId');
  }
  if (snapshot.orderId !== order.orderId) {
    throw new StripePaymentIntentContractError('orderId');
  }
  if (
    snapshot.amount.amountMinor !== payment.amount.amountMinor ||
    snapshot.amount.currency !== payment.amount.currency
  ) {
    throw new StripePaymentIntentContractError('amount');
  }
  if (snapshot.status === 'NOT_STARTED') {
    throw new StripePaymentIntentContractError('status');
  }
  if (snapshot.clientSecret === undefined || snapshot.clientSecret.length === 0) {
    throw new StripePaymentIntentContractError('clientSecret');
  }
}

async function retrieveBoundPaymentIntent(
  dependencies: PrepareStripePaymentIntentDependencies,
  order: Order,
  stripePaymentIntentId: string,
): Promise<StripePaymentIntentSnapshot> {
  if (order.payment?.stripePaymentIntentId !== stripePaymentIntentId) {
    throw new StripePaymentIntentBindingConflictError();
  }
  const snapshot = await dependencies.stripeClient.retrievePaymentIntent(stripePaymentIntentId);
  assertStripeSnapshot(order, snapshot, stripePaymentIntentId);
  return snapshot;
}

export async function prepareStripePaymentIntent(
  dependencies: PrepareStripePaymentIntentDependencies,
  command: PrepareStripePaymentIntentCommand,
): Promise<PrepareStripePaymentIntentResult> {
  const now = dependencies.now ?? (() => new Date());
  const currentOrder = await dependencies.repository.get(command.merchantId, command.orderId);
  if (currentOrder === undefined) {
    throw new OrderNotFoundError();
  }
  const currentPayment = currentOrder.payment;
  if (currentPayment === undefined) {
    throw new PaymentPreparationNotAllowedError();
  }

  if (currentPayment.stripePaymentIntentId !== undefined) {
    const stripePaymentIntent = await retrieveBoundPaymentIntent(
      dependencies,
      currentOrder,
      currentPayment.stripePaymentIntentId,
    );
    return { outcome: 'replayed', order: currentOrder, stripePaymentIntent };
  }

  if (currentOrder.status !== 'AWAITING_PAYMENT' || currentPayment.status !== 'NOT_STARTED') {
    throw new PaymentPreparationNotAllowedError();
  }

  const changedAt = now().toISOString();
  const createdSnapshot = await dependencies.stripeClient.createPaymentIntent({
    merchantId: currentOrder.merchantId,
    orderId: currentOrder.orderId,
    amount: currentPayment.amount,
    stripeCreationKey: currentPayment.stripeCreationKey,
  });
  assertStripeSnapshot(currentOrder, createdSnapshot);
  const changedPayment = applyPaymentStatusChange(
    currentPayment,
    {
      targetStatus: createdSnapshot.status,
      stripePaymentIntentId: createdSnapshot.stripePaymentIntentId,
      ...(createdSnapshot.lastFailureReasonCode === undefined
        ? {}
        : {
            lastFailure: {
              reasonCode: createdSnapshot.lastFailureReasonCode,
              occurredAt: changedAt,
            },
          }),
    },
    changedAt,
  );
  const changedOrder: Order = {
    ...currentOrder,
    payment: changedPayment,
    updatedAt: changedAt,
    version: currentOrder.version + 1,
  };
  const binding = await dependencies.repository.bindStripePaymentIntent({
    currentOrder,
    changedOrder,
    mutation: {
      kind: 'ORDER_PAYMENT_CHANGED',
      previousPaymentStatus: currentPayment.status,
      correlationId: command.correlationId,
      causationId: command.causationId,
    },
  });

  if (binding.outcome === 'replayed') {
    const stripePaymentIntentId = binding.order.payment?.stripePaymentIntentId;
    if (stripePaymentIntentId === undefined) {
      throw new StripePaymentIntentBindingConflictError();
    }
    const stripePaymentIntent = await retrieveBoundPaymentIntent(
      dependencies,
      binding.order,
      stripePaymentIntentId,
    );
    return { outcome: 'replayed', order: binding.order, stripePaymentIntent };
  }

  return {
    outcome: 'created',
    order: binding.order,
    stripePaymentIntent: createdSnapshot,
  };
}
