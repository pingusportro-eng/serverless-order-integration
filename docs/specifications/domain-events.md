# Domain event contract

Status: MVP version 1  
Last reviewed: 2026-07-22

## Purpose

This contract defines the JSON facts published after committed order changes.
The DynamoDB Stream publisher creates these events, SNS distributes them, and
SQS consumers process them at least once. The normative machine-readable
contract is [domain-event.schema.json](domain-event.schema.json).

The event contains only routing, trace, state-transition, and provider-reference
data. Consumers that require the current complete order load it by merchant and
aggregate ID. Delivery addresses and order lines are deliberately not copied
through SNS and SQS.

## Envelope

| Field | Rule |
| --- | --- |
| `eventId` | Globally unique, stable ID beginning with `evt_`. A retry of the same publication uses the same ID. |
| `eventType` | Stable fact name from the taxonomy below. |
| `schemaVersion` | Positive integer version of this event type and payload; version 1 is the current contract. |
| `aggregateType` | `ORDER` for every event in this contract. |
| `aggregateId` | Order ID whose state change produced the fact. |
| `aggregateVersion` | Order version after the committed change. |
| `occurredAt` | UTC time of the committed business change, not the later SNS publication time. |
| `correlationId` | Stable trace reference propagated through the complete order flow. |
| `causationId` | ID of the request, event, or command that immediately caused this fact. |
| `payload` | Event-specific fields; it is not a complete order snapshot. |

For an API-originated flow, use an accepted `X-Correlation-Id` or the platform
request ID when the caller supplied none. Provider events retain the existing
correlation ID. `causationId` refers to the immediate HTTP request ID, provider
event ID, or preceding domain event ID.

The state mutation must preserve this trace metadata so a later DynamoDB Stream
publisher can construct the same event again. The publisher derives `eventId`
as `evt_` plus the base64url SHA-256 digest of the stream ARN, stream record ID,
event type, and schema version. Those inputs are stable across Lambda retries
and distinguish multiple facts derived from one record. Operator-initiated
changes also preserve the validated audit-safe reason for the applicable event
payload. A publisher retry must never generate a fresh random ID for each
attempt.

## Event taxonomy

| Event type | Meaning | Important payload fields |
| --- | --- | --- |
| `order.created` | The platform accepted a new order. | Merchant, pending status, provider code, stable submission key. |
| `order.submitted` | The provider confirmed acceptance. | Merchant, submitted status, provider order ID, acceptance time, and optional operator reason. |
| `order.submission_failed` | Provider acceptance permanently failed or retries were exhausted. | Merchant, submission-stage failure. |
| `order.submission_retry_requested` | An operator approved another submission attempt. | Merchant, prior status, pending status, unchanged submission key, and required operator reason. |
| `order.cancelled` | The order was cancelled from an allowed state. | Merchant, prior status, cancelled status, and optional operator reason. |
| `order.picked_up` | The provider reported pickup. | Merchant, prior status, provider order ID, and optional operator reason. |
| `order.delivered` | The provider reported successful delivery. | Merchant, prior status, provider order ID, and optional operator reason. |
| `order.delivery_failed` | A provider-accepted delivery failed. | Merchant, prior status, provider order ID, delivery-stage failure, and optional operator reason. |

The TypeScript discriminated union in
[`src/events/domain-event.ts`](../../src/events/domain-event.ts) mirrors the JSON
Schema. The schema remains the transport boundary and must validate untrusted
message data before it is treated as a typed event.

## Compatibility rules

1. The meaning and shape of an existing `(eventType, schemaVersion)` pair are
   immutable.
2. Removing a field, changing a type or meaning, or adding a field requires a
   new schema version because version 1 rejects unknown fields.
3. A new event type may be introduced without changing existing event types.
   Consumers ignore event types outside their declared subscription or route
   them to an explicit unsupported-event path.
4. Consumers dispatch on both event type and schema version. They must not guess
   how to process an unsupported version.
5. Deploy consumers that understand a new version before publishers emit it.
   During migration, a publisher may temporarily emit an old and new version
   with different event IDs if both are documented facts.
6. Transport wrappers are not part of this schema. With SNS raw-message delivery,
   the event JSON is the SQS message body; without it, the consumer must unwrap
   SNS before applying this schema.

## Duplicate and ordering rules

Delivery through DynamoDB Streams, Lambda, SNS, and standard SQS is at least
once. Duplicates and out-of-order messages are normal operating conditions.

For every consumer:

1. Calculate a SHA-256 fingerprint of the complete event using RFC 8785 JSON
   canonicalization. Transport wrappers are excluded.
2. Claim `(consumerName, eventId)` with a conditional write before or atomically
   with the consumer's state change.
3. If the same ID and fingerprint previously completed successfully, acknowledge
   it without repeating the state change or external side effect.
4. If the ID exists with another fingerprint, do not process it. Record an
   operational conflict and allow the configured failure or DLQ path to retain
   the message.
5. Do not record successful completion before all required side effects are
   safely complete. A failed or interrupted attempt remains retryable.
6. Do not use payload similarity or `aggregateVersion` as the duplicate key.
7. Use the aggregate version and domain state machine to recognize stale or
   invalid out-of-order events. Such an event must not move the order backward.

The delivery worker additionally uses the order's stable `submissionKey` when
calling the provider. Event deduplication prevents repeated consumer work;
provider idempotency protects the external side effect when the worker loses a
response after the provider accepted the request.

## Data and size rules

- Events contain only synthetic data in this learning project.
- Do not include authorization headers, secrets, raw provider responses, full
  order snapshots, or personal data.
- Failure summaries must remain audit-safe.
- Keep events comfortably below the smallest downstream message limit; large
  future payloads should be referenced, not embedded.
