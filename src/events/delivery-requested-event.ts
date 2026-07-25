import type { OrderCreatedEvent, OrderSubmissionRetryRequestedEvent } from './domain-event.js';

export type DeliveryRequestedEvent = OrderCreatedEvent | OrderSubmissionRetryRequestedEvent;

const ENVELOPE_FIELDS = new Set([
  'eventId',
  'eventType',
  'schemaVersion',
  'aggregateType',
  'aggregateId',
  'aggregateVersion',
  'occurredAt',
  'correlationId',
  'causationId',
  'payload',
]);
const CREATED_PAYLOAD_FIELDS = new Set(['merchantId', 'status', 'providerCode', 'submissionKey']);
const RETRY_PAYLOAD_FIELDS = new Set([
  'merchantId',
  'previousStatus',
  'status',
  'providerCode',
  'submissionKey',
  'reason',
]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+={0,2}$/;
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_-]{16,128}$/;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]+$/;
const MERCHANT_ID_PATTERN = /^mrc_[A-Za-z0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}

function isSafeId(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    SAFE_ID_PATTERN.test(value)
  );
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return (
    hasOnlyFields(value, ENVELOPE_FIELDS) &&
    isSafeId(value['eventId'], 20, 132) &&
    EVENT_ID_PATTERN.test(value['eventId']) &&
    value['schemaVersion'] === 1 &&
    value['aggregateType'] === 'ORDER' &&
    isSafeId(value['aggregateId'], 12, 64) &&
    ORDER_ID_PATTERN.test(value['aggregateId']) &&
    Number.isSafeInteger(value['aggregateVersion']) &&
    (value['aggregateVersion'] as number) >= 1 &&
    typeof value['occurredAt'] === 'string' &&
    Number.isFinite(Date.parse(value['occurredAt'])) &&
    isSafeId(value['correlationId'], 8, 128) &&
    isSafeId(value['causationId'], 8, 128)
  );
}

function hasCommonPayload(payload: Record<string, unknown>): boolean {
  return (
    isSafeId(payload['merchantId'], 3, 64) &&
    MERCHANT_ID_PATTERN.test(payload['merchantId']) &&
    payload['status'] === 'PENDING_SUBMISSION' &&
    payload['providerCode'] === 'mock-delivery' &&
    isSafeId(payload['submissionKey'], 8, 128)
  );
}

export function parseDeliveryRequestedEvent(body: string): DeliveryRequestedEvent {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error('SQS message body must contain valid JSON.');
  }

  if (!isRecord(value) || !hasValidEnvelope(value) || !isRecord(value['payload'])) {
    throw new Error('SQS message does not contain a valid domain-event envelope.');
  }

  const payload = value['payload'];
  if (!hasCommonPayload(payload)) {
    throw new Error('SQS message does not contain a valid delivery payload.');
  }

  if (value['eventType'] === 'order.created' && hasOnlyFields(payload, CREATED_PAYLOAD_FIELDS)) {
    return value as unknown as OrderCreatedEvent;
  }

  if (
    value['eventType'] === 'order.submission_retry_requested' &&
    hasOnlyFields(payload, RETRY_PAYLOAD_FIELDS) &&
    payload['previousStatus'] === 'SUBMISSION_FAILED' &&
    typeof payload['reason'] === 'string' &&
    payload['reason'].length >= 3 &&
    payload['reason'].length <= 500
  ) {
    return value as unknown as OrderSubmissionRetryRequestedEvent;
  }

  throw new Error('SQS message event type is not actionable by the delivery worker.');
}
