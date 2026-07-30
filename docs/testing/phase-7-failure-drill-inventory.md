# Phase 7.2 failure-drill evidence inventory

Status: complete

Last reviewed: 2026-07-29

## Purpose

This inventory closes Phase 7.2 by mapping every required failure to evidence
at the boundary that can prove it. It avoids repeating equivalent AWS failures
merely to produce more traffic:

- local HTTP and repository tests prove error classification and conditional
  state changes;
- Lambda fixture tests prove partial batch responses and safe logging; and
- bounded AWS drills prove managed retries, failure destinations, DLQ
  movement, redrive, and service integration.

For every scenario, the review records detection, diagnosis, recovery, and
prevention.

## Coverage summary

| Required scenario | Primary evidence | Boundary | Result |
| --- | --- | --- | --- |
| Vendor timeout | `delivery-vendor-client.test.ts` | Real local HTTP timeout | Complete |
| Vendor `429` | Vendor rate-limit and worker-DLQ drill | AWS worker/SQS/DLQ/redrive | Complete |
| Vendor `500` | Vendor-client and delivery-worker tests | Real local HTTP response plus Lambda batch behavior | Complete |
| Duplicate delivery | Terminal failure and operator-retry campaign | AWS delivery worker and vendor journal | Complete |
| Poison message | Stream-publisher failure drill | AWS DynamoDB Stream retries and failure destination | Complete |
| Invalid webhook | Webhook tests and terminal campaign | Local HMAC boundary plus deployed API | Complete |
| Conditional-write conflict | Repository contract and concurrent status tests | DynamoDB Local and application concurrency | Complete |

## Vendor timeout

**Detection**

[`tests/integrations/delivery-vendor-client.test.ts`](../../tests/integrations/delivery-vendor-client.test.ts)
uses the real local mock-vendor HTTP boundary with a caller timeout shorter than
the vendor delay. The client emits a safe, retryable `TIMEOUT`
`VendorSubmissionError`.

**Diagnosis**

The error distinguishes elapsed provider time from an unreachable endpoint,
rate limiting, an HTTP `500`, and an unusable response. It does not expose a
response body or authentication material.

**Recovery**

The worker returns the SQS message identifier in `batchItemFailures`. The
Lambda event-source mapping leaves the message for a later receive. Repeated
exhaustion follows the worker-DLQ and managed-redrive path proved by the live
`429` drill.

**Prevention**

The provider request has a three-second bound, calls use a stable provider
delivery-provider submission key, SQS retry ownership is explicit, and the DLQ retains exhausted
messages. A separate timeout cloud drill would repeat the same AWS
orchestration while making each Lambda attempt slower.

## Vendor `429`

**Detection**

The live AWS drill produced three `delivery.message.failed` records for:

```text
correlationId: corr.vendor429drill.1785310860841814
orderId:       ord_vendor429drill1785310860841814
attempts:      1, 2, 3
exception:     VendorSubmissionError
```

The append-only vendor journal independently recorded three `429` responses
with the same correlation ID and idempotency-key digest.

**Diagnosis**

CloudWatch showed gaps of approximately the configured 90-second visibility
timeout. The Delivery Queue redrive policy showed `Maximum receives: 3`, and
the worker DLQ metric briefly reached one visible message.

**Recovery**

After the mock vendor was restarted in `success` mode, the guarded harness
called `StartMessageMoveTask`. The SQS console reported:

```text
Status:              Successfully completed
Percent processed:   100%
Redrive destination: Source queue(s)
Messages moved:      1
```

The redriven message received a fresh SQS attempt count of one, the vendor
returned `201`, and the worker logged `outcome=submitted`.

**Prevention**

The vendor client classifies and bounds `Retry-After`, the worker does not
acknowledge retryable failures, the delivery-provider submission key remains stable, and
the DLQ prevents infinite hot retries. Operators redrive only after the
dependency is healthy.

The reusable procedure is documented in the
[vendor rate-limit and worker-DLQ drill](vendor-rate-limit-dlq-drill.md).

## Vendor `500`

**Detection**

The real local mock vendor returns `500`, which the vendor client maps to the
safe, retryable `PROVIDER_UNAVAILABLE` code.
[`tests/lambda/delivery-worker.test.ts`](../../tests/lambda/delivery-worker.test.ts)
then proves that this error is returned as a partial batch failure without an
order status write.

**Diagnosis**

The internal code separates provider availability from authentication,
validation, idempotency conflict, network failure, timeout, and malformed
success responses.

**Recovery**

It follows the same SQS retry, worker-DLQ, dependency-health check, and managed
redrive procedure as `429`.

**Prevention**

The worker has bounded HTTP time, idempotent submission, safe error mapping,
partial batch handling, and a DLQ. Repeating `500` in AWS would not prove a new
orchestration branch beyond the representative `429` drill.

## Duplicate delivery

**Detection**

The
[terminal failure and operator-retry campaign](terminal-retry-campaign.md)
directly injected the already-processed version-3 retry event after the order
had reached version 6. The worker recorded `duplicate_or_stale`, and the vendor
journal contained no third external call.

The local worker batch fixture also mixes a successful record, a duplicate, a
poison record, and a transient provider failure.

**Diagnosis**

The event aggregate version is behind the durable order version. The same
event therefore cannot legitimately cause another provider submission.

**Recovery**

The worker acknowledges the duplicate. The Lambda event-source mapping can
delete that SQS message without changing the order or calling the vendor.

**Prevention**

Durable aggregate versions, provider submission state, event IDs, and stable
idempotency keys prevent duplicate external effects. At-least-once delivery is
accepted; idempotent processing makes it safe.

## Poison message

**Detection**

The
[stream-publisher failure drill](stream-publisher-failure-drill.md)
inserted one marked malformed order record. CloudWatch recorded exactly three
correlated `stream.record.failed` entries, and the exact invocation record
reached the publisher failure queue.

**Diagnosis**

The retained stream record resolved to the synthetic DynamoDB key and sequence
number. This separated a deterministic record/schema failure from a transient
Lambda or SNS failure.

**Recovery**

The drill repaired the same DynamoDB item, observed the expected
`order.cancelled` event, and proved that the publisher continued on the same
stream shard. It then deleted only the marked failure record and synthetic
item.

**Prevention**

Strict stream-record parsing, partial batch failure reporting, bounded retry
attempts, maximum record age, and the publisher failure destination prevent one
poison record from retrying forever without evidence.

## Invalid webhook

**Detection**

[`tests/lambda/vendor-webhook.test.ts`](../../tests/lambda/vendor-webhook.test.ts)
covers missing, malformed, wrong, and expired signatures. Each returns
`401 INVALID_WEBHOOK_SIGNATURE` without changing the order.

The deployed campaign also reproduced invalid webhook signatures. API Gateway
access logs showed the public webhook `401`, and the matching Webhook Lambda
records showed `webhook.request.started` followed by
`webhook.request.completed` with status `401`.

**Diagnosis**

The request ID connects API Gateway access logs to Lambda logs. The completion
record identifies the rejected boundary without logging the signature, secret,
or request body.

**Recovery**

An invalid request is not applied. A legitimate provider must create a new
signature and current timestamp, then retry the same durable provider event ID.
Event deduplication protects against an uncertain prior response.

**Prevention**

The endpoint uses HMAC verification, constant-time comparison, a five-minute
replay window, validation before mutation, and durable event-ID deduplication.

## Conditional-write conflict

**Detection**

[`tests/application/change-order-status.test.ts`](../../tests/application/change-order-status.test.ts)
starts two concurrent changes with expected version 1 and proves that exactly
one succeeds. The rejected operation receives `OrderVersionConflictError`, and
the stored order advances exactly once to version 2.

The DynamoDB repository contract proves that a stale conditional status write
cannot overwrite the winning order. The HTTP handler maps a stale `If-Match`
value to `412 VERSION_MISMATCH` and returns the current ETag.

**Diagnosis**

The expected and actual versions distinguish concurrent modification from a
missing order, invalid transition, or infrastructure failure.

**Recovery**

The caller reads the current order and ETag, re-evaluates the business intent,
and submits a new command only if it remains valid. It must not blindly replay
the stale write.

**Prevention**

Every status change increments the aggregate exactly once and uses a DynamoDB
condition on the expected version. Transactional order/event writes prevent a
state change without its corresponding domain event.

## Phase result

All required Phase 7.2 scenarios are exercised. The evidence deliberately uses
one representative AWS drill for each distinct managed-service behavior rather
than duplicating equivalent transient failures.

The final live session independently verified:

- the application stack and development artifact prefix were removed;
- all lab-owned vendor and tunnel processes stopped;
- the ignored drill journal retained only safe evidence;
- the project Budget reported `$0.00` actual and forecast spend; and
- the persistent bootstrap contains no fixed-cost application resource.

Two operational defects discovered during the session were corrected:

1. CloudFormation drift inspection now has the read-only
   `logs:DescribeIndexPolicies` permission; and
2. verified teardown can match its destroy operation if `master` advances while
   a lab is running.

The next phase can use this evidence to write an incident runbook and one
concise postmortem without another AWS deployment.
