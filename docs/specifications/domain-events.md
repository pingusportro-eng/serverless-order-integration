# Domain event contract

Status: MVP version 2
Last reviewed: 2026-07-30

## Purpose

This contract defines the JSON facts published after committed order changes.
The DynamoDB Stream publisher creates these events, SNS distributes them, and
SQS consumers process them at least once. The normative machine-readable
contract is [domain-event.schema.json](domain-event.schema.json).

The event contains only routing, trace, state-transition, and delivery-provider
data. Consumers that require the current complete order load it by merchant and
aggregate ID. Delivery addresses and order lines are deliberately not copied
through SNS and SQS.

## Envelope

| Field | Rule |
| --- | --- |
| `eventId` | Globally unique, stable ID beginning with `evt_`. A retry of the same publication uses the same ID. |
| `eventType` | Stable fact name from the taxonomy below. |
| `schemaVersion` | Positive integer version of this event type and payload; version 2 is the current contract. |
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
event ID, or preceding domain event ID. Trace references accept up to two
trailing `=` characters because trusted platform request IDs can use padded
Base64; `=` is not accepted in the middle of an identifier.

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
| `order.created` | The platform accepted a new order. | Merchant, pending status, delivery-provider code, stable delivery-provider submission key. |
| `order.submitted` | The provider confirmed acceptance. | Merchant, submitted status, delivery-provider order ID, acceptance time, and optional operator reason. |
| `order.submission_failed` | Provider acceptance permanently failed or retries were exhausted. | Merchant, submission-stage failure. |
| `order.submission_retry_requested` | An operator approved another submission attempt. | Merchant, prior status, pending status, unchanged delivery-provider submission key, and required operator reason. |
| `order.cancelled` | The order was cancelled from an allowed state. | Merchant, prior status, cancelled status, and optional operator reason. |
| `order.picked_up` | The provider reported pickup. | Merchant, prior status, delivery-provider order ID, and optional operator reason. |
| `order.delivered` | The provider reported successful delivery. | Merchant, prior status, delivery-provider order ID, and optional operator reason. |
| `order.delivery_failed` | A provider-accepted delivery failed. | Merchant, prior status, delivery-provider order ID, delivery-stage failure, and optional operator reason. |

The TypeScript discriminated union in
[`src/events/domain-event.ts`](../../src/events/domain-event.ts) mirrors the JSON
Schema. The schema remains the transport boundary and must validate untrusted
message data before it is treated as a typed event.

## Compatibility rules

1. The meaning and shape of an existing `(eventType, schemaVersion)` pair are
   immutable.
2. Removing a field, changing a type or meaning, or adding a field requires a
   new schema version because existing versions reject unknown fields.
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

Every consumer must define a durable idempotency strategy appropriate to its
side effects. A stable `eventId` preserves the identity of publisher retries,
but it does not prevent duplicate processing by itself.

Rules shared by every consumer:

1. Do not assume exactly-once or globally ordered delivery.
2. Validate the complete event before using it as trusted application data.
3. Do not report successful completion before all required side effects are
   safely complete. A failed or interrupted attempt must remain retryable.
4. Use the aggregate version and domain state machine to recognize stale or
   invalid out-of-order events. Such an event must not move the order backward.
5. Document which durable state or idempotency contract makes repeated and
   concurrent processing safe.

The delivery worker uses a domain-specific strategy:

- aggregate version and current order state recognize completed or stale work;
- conditional writes prevent concurrent order updates from overwriting each
  other; and
- the stable `deliveryProviderSubmissionKey` protects concurrent calls and an
  uncertain provider acceptance from creating duplicate deliveries.

The delivery worker validates, logs, and propagates the domain `eventId` as a
causation reference, but it does not persist a `(consumerName, eventId)` claim.
Consequently, it does not independently detect the same event ID reused with a
different payload. This is an accepted limitation because actionable messages
originate from the trusted publisher and the delivery queue accepts messages
only from the stack's SNS topic.

Consumers that need event-ID-based deduplication should use the generic
processed-event pattern:

1. Calculate a SHA-256 fingerprint of the complete event using RFC 8785 JSON
   canonicalization. Transport wrappers are excluded.
2. Claim `(consumerName, eventId)` with a conditional write before or atomically
   with the consumer's database state change.
3. If the same ID and fingerprint previously completed successfully,
   acknowledge it without repeating the state change.
4. If the ID exists with another fingerprint, do not process it. Record an
   operational conflict and allow the configured failure or DLQ path to retain
   the message.
5. If processing includes an external side effect, a completed-event marker
   alone does not prevent concurrent calls. Use an atomic in-progress claim
   with expiry or an idempotent external API, and retain a recovery path for a
   crash between the external call and the completion write.

The provider-webhook consumer uses a processed-event claim because the order
update and event marker can be committed in the same DynamoDB transaction.

## Data and size rules

- Events contain only synthetic data in this learning project.
- Do not include authorization headers, secrets, raw provider responses, full
  order snapshots, or personal data.
- Failure summaries must remain audit-safe.
- Keep events comfortably below the smallest downstream message limit; large
  future payloads should be referenced, not embedded.
