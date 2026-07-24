import type { Order } from '../domain/order.js';
import type { OrderStatusChangedMutation } from '../events/order-mutation.js';

export const PROVIDER_WEBHOOK_CONSUMER = 'provider-webhook';

export interface RecordProviderWebhookInput {
  readonly eventId: string;
  readonly eventFingerprint: string;
  readonly providerOrderId: string;
  readonly processedAt: string;
  readonly currentOrder: Order;
  readonly changedOrder?: Order;
  readonly mutation?: OrderStatusChangedMutation;
}

export type RecordProviderWebhookResult = 'recorded' | 'duplicate';

export interface ProviderWebhookRepository {
  getByProviderOrderId(
    providerCode: Order['provider']['providerCode'],
    providerOrderId: string,
  ): Promise<Order | undefined>;
  recordProviderWebhook(input: RecordProviderWebhookInput): Promise<RecordProviderWebhookResult>;
}

export class ProviderOrderConflictError extends Error {
  override readonly name = 'ProviderOrderConflictError';

  constructor() {
    super('The provider order ID is already assigned to another order.');
  }
}

export class ProviderEventIdConflictError extends Error {
  override readonly name = 'ProviderEventIdConflictError';

  constructor() {
    super('The provider event ID was already used with different event values.');
  }
}
