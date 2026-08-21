export interface StripeReconciliationEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly stripeAccountId: string;
  readonly apiVersion: string | null;
  readonly createdAt: string;
  readonly livemode: boolean;
  readonly eventFingerprint: string;
  readonly stripePaymentIntentId?: string;
  readonly applicationMetadataNamespace?: string;
  readonly merchantId?: string;
  readonly orderId?: string;
}

export type StripeReconciliationEventQuery =
  | {
      readonly kind: 'time_range';
      readonly since: string;
      readonly until: string;
      readonly limit: number;
    }
  | {
      readonly kind: 'event_ids';
      readonly eventIds: readonly string[];
    };

export interface StripeReconciliationEventPage {
  readonly events: readonly StripeReconciliationEvent[];
  readonly hasMore: boolean;
}

export interface StripeReconciliationEventSource {
  getStripeAccountId(): Promise<string>;
  findEvents(query: StripeReconciliationEventQuery): Promise<StripeReconciliationEventPage>;
}
