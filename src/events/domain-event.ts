import type { FailureDetails, MerchantId, OrderId } from '../domain/order.js';

export const DOMAIN_EVENT_TYPES = [
  'order.created',
  'order.ready_for_submission',
  'order.submitted',
  'order.submission_failed',
  'order.submission_retry_requested',
  'order.cancelled',
  'order.picked_up',
  'order.delivered',
  'order.delivery_failed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEventEnvelope<TType extends DomainEventType, TPayload extends object> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: 2;
  readonly aggregateType: 'ORDER';
  readonly aggregateId: OrderId;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly payload: TPayload;
}

interface MerchantEventPayload {
  readonly merchantId: MerchantId;
}

export interface OrderCreatedPayload extends MerchantEventPayload {
  readonly status: 'AWAITING_PAYMENT' | 'PENDING_SUBMISSION';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderSubmissionKey: string;
}

export interface OrderReadyForSubmissionPayload extends MerchantEventPayload {
  readonly previousStatus: 'AWAITING_PAYMENT';
  readonly status: 'PENDING_SUBMISSION';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderSubmissionKey: string;
}

export interface OrderSubmittedPayload extends MerchantEventPayload {
  readonly status: 'SUBMITTED';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderOrderId: string;
  readonly acceptedAt: string;
  readonly reason?: string;
}

export interface OrderSubmissionFailedPayload extends MerchantEventPayload {
  readonly status: 'SUBMISSION_FAILED';
  readonly failure: FailureDetails & { readonly stage: 'SUBMISSION' };
}

export interface OrderSubmissionRetryRequestedPayload extends MerchantEventPayload {
  readonly previousStatus: 'SUBMISSION_FAILED';
  readonly status: 'PENDING_SUBMISSION';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderSubmissionKey: string;
  readonly reason: string;
}

export interface OrderCancelledPayload extends MerchantEventPayload {
  readonly previousStatus: 'PENDING_SUBMISSION' | 'SUBMISSION_FAILED' | 'SUBMITTED';
  readonly status: 'CANCELLED';
  readonly reason?: string;
}

export interface OrderPickedUpPayload extends MerchantEventPayload {
  readonly previousStatus: 'SUBMITTED';
  readonly status: 'PICKED_UP';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderOrderId: string;
  readonly reason?: string;
}

export interface OrderDeliveredPayload extends MerchantEventPayload {
  readonly previousStatus: 'SUBMITTED' | 'PICKED_UP';
  readonly status: 'DELIVERED';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderOrderId: string;
  readonly reason?: string;
}

export interface OrderDeliveryFailedPayload extends MerchantEventPayload {
  readonly previousStatus: 'SUBMITTED' | 'PICKED_UP';
  readonly status: 'DELIVERY_FAILED';
  readonly deliveryProviderCode: 'mock-delivery';
  readonly deliveryProviderOrderId: string;
  readonly failure: FailureDetails & { readonly stage: 'DELIVERY' };
  readonly reason?: string;
}

export type OrderCreatedEvent = DomainEventEnvelope<'order.created', OrderCreatedPayload>;
export type OrderReadyForSubmissionEvent = DomainEventEnvelope<
  'order.ready_for_submission',
  OrderReadyForSubmissionPayload
>;
export type OrderSubmittedEvent = DomainEventEnvelope<'order.submitted', OrderSubmittedPayload>;
export type OrderSubmissionFailedEvent = DomainEventEnvelope<
  'order.submission_failed',
  OrderSubmissionFailedPayload
>;
export type OrderSubmissionRetryRequestedEvent = DomainEventEnvelope<
  'order.submission_retry_requested',
  OrderSubmissionRetryRequestedPayload
>;
export type OrderCancelledEvent = DomainEventEnvelope<'order.cancelled', OrderCancelledPayload>;
export type OrderPickedUpEvent = DomainEventEnvelope<'order.picked_up', OrderPickedUpPayload>;
export type OrderDeliveredEvent = DomainEventEnvelope<'order.delivered', OrderDeliveredPayload>;
export type OrderDeliveryFailedEvent = DomainEventEnvelope<
  'order.delivery_failed',
  OrderDeliveryFailedPayload
>;

export type DomainEvent =
  | OrderCreatedEvent
  | OrderReadyForSubmissionEvent
  | OrderSubmittedEvent
  | OrderSubmissionFailedEvent
  | OrderSubmissionRetryRequestedEvent
  | OrderCancelledEvent
  | OrderPickedUpEvent
  | OrderDeliveredEvent
  | OrderDeliveryFailedEvent;
