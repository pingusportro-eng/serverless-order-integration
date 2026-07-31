# Asynchronous event journey and failure-handling walkthrough

## Purpose

Use this guide for a deeper interview discussion of the path from a committed
order mutation to the delivery provider and back through a signed webhook. The
goal is not to memorize AWS service names. For each boundary, be able to
explain:

1. who owns delivery and retries;
2. what success signal advances the message;
3. how duplicates and out-of-order work remain safe;
4. where an exhausted failure is retained; and
5. which consistency or availability trade-off remains.

The synchronous path ends when DynamoDB commits the order and mutation
metadata. It is covered in the
[synchronous API and data-integrity walkthrough](synchronous-api-and-data-integrity.md).

## Complete event journey

```text
Orders API or Webhook Lambda
  |
  | conditional or transactional order mutation
  v
DynamoDB orders table
  |
  | committed INSERT or MODIFY, NEW_IMAGE
  v
DynamoDB Stream
  |
  | Lambda event-source mapping
  v
Publisher Lambda
  |
  | versioned domain event + SNS message attributes
  v
SNS domain-events topic
  |
  | subscription filter:
  | order.created or order.submission_retry_requested
  v
Delivery SQS queue
  |
  | Lambda event-source mapping
  v
Delivery Worker Lambda
  |
  | HTTPS + stable delivery-provider idempotency key
  v
Delivery provider
  |
  | synchronous acceptance result
  v
Worker transactionally updates order + provider lookup

Delivery provider
  |
  | signed status webhook
  v
API Gateway -> Webhook Lambda
  |
  | transactionally updates order + claims provider event ID
  v
DynamoDB -> Stream -> Publisher -> SNS
```

The provider submission is asynchronous from the original API request, but
one worker attempt calls the provider synchronously. “Asynchronous” describes
the boundary between accepting the order and submitting it, not the transport
used for the worker's individual HTTPS request.

## 1. DynamoDB commit is the durable handoff

The Orders API does not perform:

```text
write order
publish SNS message
```

as two independent calls. A crash between those calls could leave either an
unpublished order or a message for an uncommitted order.

Instead, the application commits the order representation and its mutation
metadata together. DynamoDB Streams observes only committed item changes.
Failed or rolled-back transactions do not become work for the publisher.

The table stream uses `NEW_IMAGE`, so an order stream record contains the
committed representation needed to construct the corresponding fact. The
event-source mapping filters for `INSERT` or `MODIFY` records whose new image
has `entityType=ORDER`. Helper items such as idempotency claims are not delivery
work. The publisher repeats that validation in code instead of treating the
infrastructure filter as a trust boundary.

Invariant:

> Every asynchronously published order fact is derived from committed database
> state; the HTTP application does not have to keep DynamoDB and SNS in sync.

Trade-off:

> Stream propagation is asynchronous. A successful create means the platform
> durably accepted the order, not that SNS, SQS, or the provider has already
> processed it.

## 2. The publisher converts storage changes into domain facts

The Lambda event-source mapping polls DynamoDB Streams and invokes the
publisher with a bounded batch. The publisher does not publish the raw
DynamoDB record. It converts an order mutation into the versioned
[domain-event contract](../specifications/domain-events.md), including:

- a stable `eventId`;
- `eventType` and `schemaVersion`;
- order ID and aggregate version;
- occurrence time;
- correlation and causation references; and
- the small event-specific payload.

The event ID is derived from stable stream and event inputs. Retrying the same
stream record therefore publishes the same event ID instead of inventing a new
identity.

The publisher sends the JSON event to SNS and adds `eventType`,
`schemaVersion`, and `aggregateId` as SNS message attributes. The attributes
support routing without requiring SNS to parse the JSON body.

### How the publisher signals success or failure

For a successful batch, the Lambda returns:

```json
{
  "batchItemFailures": []
}
```

The event-source mapping can advance its checkpoint past those records.

If a record cannot be parsed or published, the handler returns its stream
sequence number:

```json
{
  "batchItemFailures": [
    {
      "itemIdentifier": "<failed sequence number>"
    }
  ]
}
```

The publisher processes records sequentially and stops at the first failure.
That prevents later records in the batch from being checkpointed ahead of the
failed boundary.

`ReportBatchItemFailures` identifies the failed checkpoint boundary.
`BisectBatchOnFunctionError` is an additional isolation mechanism when the
invocation fails as a whole. They solve related but different cases:

| Mechanism | Signal | Purpose |
| --- | --- | --- |
| Partial batch failure | Handler returns an item identifier | Retry from the reported record instead of replaying an already successful prefix |
| Batch bisection | Invocation fails | Split a failed batch to isolate a bad record |

### Bounded stream retries

The reviewed development configuration uses:

- batch size `10`;
- two retries after the initial attempt; and
- maximum record age of one hour.

If either retry attempts or record age is exhausted, the event-source mapping
sends the failed invocation record to the stream-publisher failure queue.
`MaximumRecordAgeInSeconds` measures the age of the stream record, not merely
the time since its latest retry.

The retry limit handles deterministic poison records quickly. The age limit is
an independent safety net for old backlog. A failure on one stream shard does
not stop other shards from being processed, but it can delay later records on
the affected shard until the failure is retried or discarded.

## 3. SNS routes facts; SQS owns delivery work

SNS is the publication and fan-out boundary. The publisher sends every domain
event to one topic, including:

- `order.created`;
- `order.submitted`;
- `order.submission_failed`;
- `order.submission_retry_requested`;
- `order.cancelled`;
- `order.picked_up`;
- `order.delivered`; and
- `order.delivery_failed`.

The delivery subscription accepts only:

```text
order.created
order.submission_retry_requested
```

Those are commands-in-fact-form that require a provider submission attempt.
An `order.delivered` fact is still published for future audit, notification,
or analytics subscribers, but it must not submit the order again.

Raw message delivery means the SQS body is the domain-event JSON rather than an
SNS wrapper. The delivery worker still validates it as untrusted input.

SNS and SQS have separate responsibilities:

| Service | Responsibility |
| --- | --- |
| SNS | Publish once, filter, and fan out to interested subscriptions |
| SQS | Buffer delivery work, control retry timing, and isolate exhausted worker messages |

If the project had exactly one permanent consumer, the publisher could send
directly to SQS and remove SNS. SNS is retained because pub/sub and future
independent consumers are deliberate requirements.

## 4. The delivery worker assumes at-least-once delivery

The SQS event-source mapping polls the Delivery Queue and invokes workers with
small batches. The reviewed configuration uses:

- batch size `2`;
- maximum concurrency `2`;
- Lambda timeout `15` seconds;
- provider timeout `3` seconds; and
- queue visibility timeout `90` seconds.

The worker processes its batch sequentially. Bounded batch size and
concurrency limit simultaneous provider traffic and Lambda spend. The
visibility timeout is six times the Lambda timeout, leaving room for service
coordination before a failed message becomes visible again.

For every message, the worker:

1. validates the event contract;
2. strongly reads the current order;
3. verifies merchant, submission key, and aggregate version;
4. recognizes already-completed or stale work;
5. calls the provider once with a short timeout; and
6. conditionally records the outcome.

The vendor client does not retry or sleep inside the invocation. Queue
redelivery owns retries, preventing nested client, Lambda, and SQS retry loops
from multiplying provider calls and cost.

### Retryable and non-retryable provider outcomes

| Provider outcome | Worker interpretation | Message result |
| --- | --- | --- |
| Timeout, network error, `429`, `5xx`, unusable success response | Acceptance is uncertain or failure may be temporary | Report the SQS message as failed |
| `401`, `403`, provider idempotency conflict, other rejected `4xx` | Repeating unchanged work cannot repair it | Record `SUBMISSION_FAILED`, then acknowledge |
| Valid acceptance | Record `SUBMITTED` and provider mapping | Acknowledge |

A business failure is not automatically a DLQ failure. When the provider
definitively rejects a request, the worker can durably record
`SUBMISSION_FAILED` and successfully consume the message. The worker DLQ is for
work that cannot complete safely after repeated deliveries.

## 5. SQS partial failures, visibility, and the worker DLQ

The worker returns one entry for every failed SQS message:

```json
{
  "batchItemFailures": [
    {
      "itemIdentifier": "<SQS message ID>"
    }
  ]
}
```

The event-source mapping can delete successful messages from the batch. Failed
messages are not deleted. They remain invisible until the visibility timeout
expires and then become eligible for another receive.

Each receive increases `ApproximateReceiveCount`. With the reviewed
`maxReceiveCount` of `3`, repeated failure moves the message to the worker DLQ
instead of retrying forever.

The worker does not call the DLQ directly:

```text
Worker returns failed message ID
  -> Lambda mapping does not delete it
  -> visibility timeout expires
  -> SQS delivers it again
  -> receive limit is exhausted
  -> SQS redrive policy moves it to the worker DLQ
```

AWS does not decide when the dependency has recovered. An operator
investigates the failure, repairs the provider or application, and deliberately
starts a managed redrive from the DLQ to its source queue.

## 6. Protecting the external provider side effect

The provider call and DynamoDB cannot participate in one atomic transaction.
This failure is possible:

```text
provider accepts delivery
  -> worker loses response or database write fails
  -> SQS retries message
```

Without protection, the retry could create a second delivery.

The order therefore carries a stable `deliveryProviderSubmissionKey`. Every
attempt for that logical submission sends the same value as the provider's
`Idempotency-Key`. A compliant provider returns the original acceptance for a
safe retry instead of creating another delivery.

After acceptance, one DynamoDB transaction:

- conditionally advances the order to `SUBMITTED`; and
- creates the `DELIVERY_PROVIDER_ORDER` reverse-lookup item.

If the database write loses a race, the worker reloads the order. It
acknowledges only when current state proves that the intended provider outcome
was already recorded. A different newer state is a reconciliation failure and
remains retryable.

Invariant:

> Provider acceptance is never committed without the reverse lookup needed for
> later webhooks, and an uncertain retry uses the same provider idempotency key.

Honest limitation:

> Safety depends on the provider honoring its idempotency contract. A provider
> without idempotent creation would require a reconciliation API, a lookup by
> merchant reference, or an operator workflow for uncertain outcomes.

## 7. Provider webhooks complete the return journey

The provider later calls the public webhook route with its delivery status.
The route is public because an external provider cannot use the platform's
Cognito user flow, so it has a separate trust boundary.

Before applying a webhook, the application:

1. verifies an HMAC over the timestamp and exact raw body;
2. compares the signature in constant time;
3. requires the timestamp to be within five minutes;
4. validates the JSON contract;
5. resolves the order through the delivery-provider-order mapping; and
6. checks event time and the domain state transition.

The application transactionally writes:

- the conditional order status change, when the event is current and legal;
  and
- a `PROCESSED_EVENT` item containing the provider event ID and fingerprint.

The two writes succeed or fail together. The application never marks an event
processed without safely applying its required state change.

Duplicate behavior is explicit:

| Event condition | Result |
| --- | --- |
| New event ID and current legal transition | Apply and return `204` |
| Same event ID and same fingerprint | Acknowledge duplicate with `204` |
| Older or no-longer-applicable event | Record as processed and return `204` without moving state backward |
| Same event ID and different fingerprint | Return `409 EVENT_ID_CONFLICT` |

The processor retries a conditional version conflict up to three times within
the request. Each retry reloads current state and re-evaluates whether the
event is applicable. This is a short concurrency reconciliation loop, not a
provider-delivery retry loop.

A successful webhook mutation creates another order stream record. The
publisher emits facts such as `order.picked_up` or `order.delivered`. The
delivery SNS subscription does not accept those event types, so they do not
loop back into provider submission.

## 8. The three retained failure boundaries

The architecture has three different failure queues. They are not a sequence
through which one message normally travels.

| Failure boundary | Automatic owner | What failed | Retained destination | Typical recovery |
| --- | --- | --- | --- | --- |
| DynamoDB Stream → Publisher | Lambda stream event-source mapping | Stream record parsing or SNS publication | Stream-publisher failure queue | Inspect exact record, repair data/code, then deliberately replay or reproduce the mutation |
| SNS → Delivery Queue | SNS subscription delivery | SNS could not deliver to SQS after its managed attempts | SNS subscription DLQ | Repair queue policy or destination, then deliberately republish/replay |
| Delivery Queue → Worker/provider | SQS redrive policy | Worker could not safely complete the message within receive limit | Worker DLQ | Repair dependency/code, then managed redrive to source queue |

Other errors do not automatically enter these queues:

- invalid API requests return an HTTP error;
- invalid webhook signatures return `401`;
- a non-retryable provider rejection becomes durable
  `SUBMISSION_FAILED`; and
- domain events with no subscriber remain published facts but create no
  delivery work.

Each queue has one-day retention in the disposable development stack. Stack
teardown deletes the queues, so an operator must collect required evidence
before destruction.

## 9. Ordering and duplicate guarantees

The system deliberately does not claim global ordering or exactly-once
delivery.

### What is ordered

- DynamoDB Streams preserves modifications to the same item in sequence.
- The publisher stops at the first failed record in its received batch.
- Aggregate versions describe the order's committed progression.

### What is not ordered

- Separate stream shards may be processed concurrently.
- SNS and Standard SQS may deliver duplicates.
- Standard SQS may deliver messages out of order.
- Multiple workers may be active at the same time.

Application safeguards make those transport properties acceptable:

| Risk | Safeguard |
| --- | --- |
| Publisher republishes one stream record | Delivery worker checks aggregate version/current state, and provider submission uses a stable idempotency key |
| Delivery work is duplicated | Aggregate version/state checks plus stable provider idempotency key |
| Newer event arrives first | Missing aggregate version remains retryable; stale work cannot move state backward |
| Provider accepts but response is lost | Same provider submission key recovers the original acceptance |
| Webhook is repeated | Transactional provider event-ID claim |
| Webhook ID is reused with changed data | Stored fingerprint produces an operational conflict |
| Two writers change the order | Conditional expected-version write |

The delivery worker does not persist a generic processed-event marker for its
SNS event. It validates and logs `eventId` and preserves it as causation
metadata, while durable order progression and provider idempotency protect the
actual business side effect. This means it does not independently detect the
same domain event ID reused with a different payload. That accepted limitation
avoids an in-progress claim, expiry, recovery, and additional DynamoDB state for
a queue that accepts messages only from the trusted SNS topic.

The webhook consumer does persist a processed-event marker because its order
update and provider event-ID claim can be committed in one DynamoDB transaction.
There is no external side effect between that claim and the order update. A
future consumer with different side effects must select and document its own
idempotency strategy instead of assuming that a stable event ID is sufficient.

## 10. Walk through three interview scenarios

### Scenario A: normal order delivery

1. Create commits order version `1` in `PENDING_SUBMISSION`.
2. The stream publisher emits `order.created` with aggregate version `1`.
3. SNS routes it into the Delivery Queue.
4. The worker loads version `1` and calls the provider.
5. Provider acceptance is transactionally stored as order version `2` plus the
   reverse lookup.
6. The publisher emits `order.submitted`; the delivery subscription ignores
   it.
7. Provider pickup and delivery webhooks are authenticated, deduplicated, and
   applied as later versions.
8. The publisher emits `order.picked_up` and `order.delivered`.

### Scenario B: provider returns `429`

1. The worker calls the provider once.
2. `429` becomes a retryable `VendorSubmissionError`.
3. The worker returns that SQS message ID in `batchItemFailures`.
4. The message remains invisible for 90 seconds.
5. SQS delivers it again with the same domain event and provider submission
   key.
6. After three failed receives, SQS moves it to the worker DLQ.
7. An operator confirms provider recovery and starts controlled redrive.
8. The new attempt succeeds without creating a duplicate provider delivery.

This exact managed-service journey was exercised in the
[vendor rate-limit and worker-DLQ drill](../testing/vendor-rate-limit-dlq-drill.md).

### Scenario C: publisher poison record

1. The stream mapping invokes the publisher with a malformed order record.
2. The publisher logs `stream.record.failed` and reports its sequence number.
3. The mapping retries from that failure boundary.
4. Retry or age exhaustion sends the failed invocation record to the
   stream-publisher failure queue.
5. Other stream shards continue.
6. An operator correlates the retained record to the DynamoDB item, repairs the
   cause, and deliberately reproduces or replays the required fact.

This path was exercised in the
[stream-publisher failure drill](../testing/stream-publisher-failure-drill.md).

## 11. Scaling, cost, and operational trade-offs

The main controls are intentionally explicit:

| Control | Protection |
| --- | --- |
| Stream batch size and retry/age bounds | Limit reprocessing and poison-record duration |
| Worker batch size | Bound sequential provider calls per invocation |
| Worker maximum concurrency | Bound simultaneous provider calls and Lambda spend |
| Provider timeout | Bound one external attempt |
| Queue visibility timeout | Prevent ordinary work from being delivered again too early |
| Queue receive limit and DLQ | Prevent infinite hot retries |
| Short retention | Bound disposable-environment storage |

Increasing worker batch size alone does not guarantee more useful throughput.
Provider latency, Lambda timeout, queue visibility, concurrency, provider rate
limits, and DynamoDB capacity must be reviewed together.

Known production limitations include:

- one provider and one Region;
- no automated paging or DLQ alarm;
- one-day development retention;
- no disaster-recovery or cross-Region strategy;
- no per-tenant stream or queue isolation;
- Standard messaging rather than strict FIFO ordering; and
- dependence on the provider's idempotency behavior.

## 12. A two-minute deep-dive answer

> My asynchronous boundary starts only after DynamoDB commits an order
> mutation. DynamoDB Streams captures that committed change, and a Lambda
> event-source mapping invokes a publisher that converts the storage record
> into a stable, versioned domain event. The publisher returns partial batch
> failures by stream sequence number, while retry count and record age bound a
> poison record before it is retained in a failure queue.
>
> The publisher sends every fact to SNS. A filtered subscription routes only
> order creation and explicitly requested submission retries into Standard
> SQS. SQS buffers work and owns provider retry timing. The worker processes
> small sequential batches with bounded concurrency, validates aggregate
> versions, and calls the provider once per delivery with a stable idempotency
> key and short timeout. Retryable failures remain on the queue; exhausted work
> moves to a worker DLQ for controlled redrive.
>
> Provider acceptance and DynamoDB cannot be one transaction, so retries use
> the same provider key. Once accepted, the order update and provider reverse
> lookup are one DynamoDB transaction. Later provider webhooks use HMAC,
> constant-time verification, a replay window, and a transactional event-ID
> claim with the order update.
>
> I distinguish three retained failures: the stream publisher destination, the
> SNS subscription DLQ, and the worker DLQ. The system is at least once and not
> globally ordered, so stable IDs, aggregate versions, conditional writes, and
> external idempotency provide safety rather than claiming exactly once.

## Practice checklist

Before closing the asynchronous walkthrough, explain without reading:

- why the API does not publish directly to SNS;
- what exact return value tells the stream mapping that a record succeeded or
  failed;
- the difference between partial batch failure and batch bisection;
- why SNS and SQS are both present;
- which event types reach the delivery worker and why;
- who retries a provider `429`, and why the HTTP client does not retry it;
- what happens from the first failed SQS receive through worker-DLQ redrive;
- how provider acceptance remains safe if the following DynamoDB write fails;
- how duplicate and out-of-order delivery events remain safe;
- why a non-retryable provider rejection does not belong in the worker DLQ;
- how webhook authentication differs from webhook deduplication; and
- the distinct responsibility of each of the three failure queues.

Source material:

- [Asynchronous cloud slice](../infrastructure/asynchronous-cloud-slice.md)
- [Domain-event contract](../specifications/domain-events.md)
- [Vendor-client policy](../specifications/vendor-client.md)
- [Failure-drill inventory](../testing/phase-7-failure-drill-inventory.md)
- [Delivery-worker incident runbook](../operations/delivery-worker-incident-runbook.md)
- [Cloud infrastructure template](../../template.cloud.yaml)
