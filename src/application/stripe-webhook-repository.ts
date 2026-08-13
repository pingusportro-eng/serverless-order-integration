import type { MerchantId, Order, OrderId } from '../domain/order.js';
import type {
  OrderPaymentChangedMutation,
  OrderStatusChangedMutation,
} from '../events/order-mutation.js';

export const STRIPE_WEBHOOK_CONSUMER = 'stripe-webhook';

export const STRIPE_WEBHOOK_OUTCOMES = ['APPLIED', 'IGNORED', 'RECONCILIATION_REQUIRED'] as const;

export type StripeWebhookOutcome = (typeof STRIPE_WEBHOOK_OUTCOMES)[number];
export type StripeWebhookOrderMutation = OrderPaymentChangedMutation | OrderStatusChangedMutation;

export interface StripeWebhookEventRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventFingerprint: string;
  readonly stripePaymentIntentId: string;
  readonly processedAt: string;
}

export interface ApplyStripeWebhookChangeInput {
  readonly event: StripeWebhookEventRecord;
  readonly currentOrder: Order;
  readonly changedOrder: Order;
  readonly mutation: StripeWebhookOrderMutation;
  readonly ensurePaymentIntentMapping: boolean;
}

export interface RecordIgnoredStripeWebhookInput {
  readonly event: StripeWebhookEventRecord;
  readonly currentOrder: Order;
  readonly ensurePaymentIntentMapping: boolean;
}

export type StripeWebhookOrderExpectation =
  | { readonly currentOrder: Order }
  | {
      readonly missingOrder: {
        readonly merchantId: MerchantId;
        readonly orderId: OrderId;
      };
    };

export type RecordStripeWebhookReconciliationRequiredInput = {
  readonly event: StripeWebhookEventRecord;
  readonly reasonCode: string;
} & StripeWebhookOrderExpectation;

export type RecordStripeWebhookResult = 'recorded' | 'duplicate';

export interface StripeWebhookRepository {
  applyStripeWebhookChange(
    input: ApplyStripeWebhookChangeInput,
  ): Promise<RecordStripeWebhookResult>;
  recordIgnoredStripeWebhook(
    input: RecordIgnoredStripeWebhookInput,
  ): Promise<RecordStripeWebhookResult>;
  recordStripeWebhookReconciliationRequired(
    input: RecordStripeWebhookReconciliationRequiredInput,
  ): Promise<RecordStripeWebhookResult>;
}

export class StripeEventIdConflictError extends Error {
  override readonly name = 'StripeEventIdConflictError';

  constructor() {
    super('The Stripe event ID was already used with different event values.');
  }
}

export class StripeWebhookReconciliationError extends Error {
  override readonly name = 'StripeWebhookReconciliationError';

  constructor(readonly reasonCode: string) {
    super(`Stripe payment reconciliation is required: ${reasonCode}.`);
  }
}
