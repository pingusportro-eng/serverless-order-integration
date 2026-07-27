# Error and event-journey test matrix

Status: inventory complete; additional tests pending

Last reviewed: 2026-07-25

## Purpose

This matrix turns the broad goal of “test every error” into evidence at the
right boundary:

- Every stable application or vendor-client error code must have an automated
  local test that causes the code through its real decision path.
- Real AWS tests are reserved for behavior that local doubles cannot prove:
  authorization, event-source mappings, service filters, retry counters,
  failure destinations, DLQ movement, and managed redrive.
- One representative cloud test is enough when several error codes share the
  same orchestration path. The individual mappings must still be tested
  locally.
- Tests must assert the resulting state and side effects, not only the returned
  status code.

Generated platform responses are separate from the application contract. For
example, API Gateway can return `429`, but it does not automatically return the
application's Problem Details shape.

## Public HTTP problem codes

| Problem code | Emitting path | Current automated evidence | Additional local work | Cloud evidence |
| --- | --- | --- | --- | --- |
| `MALFORMED_REQUEST` | Invalid JSON, idempotency key, `If-Match`, or route input | Covered in API, create-order, status, and webhook tests | Add a table-driven route-level set so every emitting route is explicit | Reproduce malformed JSON and malformed `If-Match` |
| `UNAUTHORIZED` | Missing or wrong token; mock-vendor authentication is a separate contract | Covered in Lambda authorization and mock-vendor tests | None | Already reproduced without a Cognito token |
| `FORBIDDEN` | Authenticated caller missing the `operators` group on the operator route | Covered in the Orders Lambda test | None | Reproduce with a confirmed non-operator user |
| `INVALID_WEBHOOK_SIGNATURE` | Missing, malformed, wrong, or expired webhook signature | Covered for wrong and expired signatures | Add explicit missing/malformed header cases | Wrong and expired signatures already reproduced |
| `ORDER_NOT_FOUND` | Hidden/missing order or unknown provider order reference | Covered in get-order, status, and webhook tests | None | Reproduce on API and webhook routes |
| `IDEMPOTENCY_CONFLICT` | Same idempotency key with different order input | Covered at HTTP, repository, DynamoDB, vendor-client, and mock-vendor boundaries | None | Reproduce through `POST /orders` |
| `MERCHANT_REFERENCE_CONFLICT` | Same merchant reference with a different idempotency key | Covered at HTTP and DynamoDB integration boundaries | None | Reproduce through `POST /orders` |
| `INVALID_STATUS_TRANSITION` | Disallowed order status transition | Covered at domain, HTTP, and DynamoDB integration boundaries | None | Reproduce through the operator route |
| `EVENT_ID_CONFLICT` | Same provider event ID with different validated values | Covered in the webhook Lambda test | None | Reproduce through the public webhook |
| `VERSION_MISMATCH` | Stale operator ETag or repeated concurrent webhook conflict | Operator path is covered; webhook exhaustion path is not | Add a repository double that conflicts on all three webhook attempts | Reproduce the deterministic stale-ETag path; keep webhook contention local |
| `PRECONDITION_REQUIRED` | Operator mutation without `If-Match` | Covered in the status-handler test | None | Reproduce through the operator route |
| `VALIDATION_ERROR` | Invalid create, list, status, or webhook values | Covered at each application handler | Add a compact route-level matrix for representative invalid bodies and queries | Reproduce one case per public route |
| `INTERNAL_ERROR` | Safe ID-collision response or unexpected Lambda boundary failure | Covered for create collision and unexpected webhook repository failure | Add an Orders Lambda unexpected-failure/log-safety test | Do not deliberately break live IAM merely to manufacture a `500` |
`RATE_LIMITED` and `SERVICE_UNAVAILABLE` were removed from the application
Problem Details contract because no handler can emit them. API Gateway `429`
remains documented as a platform-native response and must be captured in the
cloud campaign without expecting an application `code`. The vendor client's
separate internal `RATE_LIMITED` code remains valid.

## Delivery vendor-client failures

Every client code must be caused locally through the HTTP or network boundary.
Cloud tests then exercise one transient and one terminal orchestration class.

| Client code | Retryable | Current automated evidence | Missing work | Cloud class |
| --- | --- | --- | --- | --- |
| `TIMEOUT` | Yes | Covered through a real local timeout | None | Candidate transient failure |
| `NETWORK_ERROR` | Yes | Covered through a stopped local endpoint | None | Same retry path as other transient failures |
| `RATE_LIMITED` | Yes | Covered with valid, invalid, and capped `Retry-After` values | None | Candidate transient failure |
| `PROVIDER_UNAVAILABLE` | Yes | Covered with `500` | None | Same retry path |
| `INVALID_RESPONSE` | Yes | Covered for truncated JSON, invalid success shape, and unexpected status | None | Candidate uncertain-outcome failure |
| `AUTHENTICATION_FAILED` | No | Covered with `401` and `403` | None | Candidate terminal failure |
| `IDEMPOTENCY_CONFLICT` | No | Covered with `409` | None | Local evidence is sufficient |
| `REQUEST_REJECTED` | No | Covered through deterministic mock-vendor `422` | None | Same terminal path |

The delivery application has a table-driven classification test covering all
eight client codes. It proves that every retryable failure remains on the SQS
failure path without a status write and every terminal failure is durably
recorded as `SUBMISSION_FAILED` before acknowledgement. A completeness
assertion fails if the vendor client later declares a code without adding it to
this classification.

## Mock-vendor response contract

The mock vendor covers success, idempotent success, timeout, malformed success
JSON, scenario selection, and every stable error response implemented by its
HTTP boundary:

| HTTP status | Mock code | Trigger |
| --- | --- | --- |
| `404` | `NOT_FOUND` | Wrong method or path |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Missing or wrong `Content-Type` |
| `413` | `REQUEST_TOO_LARGE` | Body larger than 64 KiB |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | Missing idempotency key |
| `400` | `MALFORMED_REQUEST` | Invalid JSON |
| `400` | `INVALID_DELIVERY` | Structurally invalid delivery |

The executable server's validated `MOCK_VENDOR_SCENARIO` input lets cloud
failure drills choose a deterministic default without adding test-only headers
to production vendor requests.

## Domain-event coverage

All eight version-1 event types are mapped and schema-validated locally:

- `order.created`
- `order.submitted`
- `order.submission_failed`
- `order.submission_retry_requested`
- `order.cancelled`
- `order.picked_up`
- `order.delivered`
- `order.delivery_failed`

The AWS campaign does not need to create every event merely to re-test JSON
mapping. It must prove both routing classes:

- Actionable: `order.created` and `order.submission_retry_requested` enter the
  delivery queue.
- Non-actionable: the other six event types are published to SNS but excluded
  from the delivery queue.

An automated infrastructure assertion should lock the SNS filter to exactly
those two actionable values.

## AWS event-journey matrix

| Journey | Expected evidence | Current state | Planned action |
| --- | --- | --- | --- |
| API -> Lambda -> DynamoDB -> Stream -> publisher -> SNS -> delivery queue -> worker -> vendor -> DynamoDB | One accepted delivery, stable correlation/idempotency references, final `SUBMITTED` order | Passed in the first smoke test | Keep as the baseline |
| Non-order transaction items -> Stream filter | Publisher is not invoked for idempotency and reference items | Inferred from logs and local mapping tests | Add an infrastructure filter assertion |
| Non-actionable domain event -> SNS filter | Event is published but does not enter the delivery queue | Representative `order.submitted` path passed | Assert the exact allow-list locally; one cloud representative is sufficient |
| Malformed order record -> publisher retries -> publisher failure queue | Structured failure logs, configured attempts exhausted, retained stream invocation record | Not tested; queue remained empty | Inject one synthetic malformed order item, then repair it and verify the shard continues |
| Publisher -> SNS failure | Publisher returns the sequence number and logs safely | Covered locally | Do not break live IAM; local handler evidence is sufficient |
| SNS -> SQS delivery exhaustion | Failed subscription delivery is retained for investigation | No SNS subscription DLQ exists | Architecture decision required before claiming complete failure retention |
| Delivery queue mixed batch -> worker partial response | Successful record is removed while only the failed record retries | Covered locally | Use a small two-message AWS batch only if timing can be deterministic |
| Transient vendor failure -> queue retries -> worker DLQ | Same submission key on every attempt, bounded receive count, retained message | Poison-message DLQ path passed, but no real vendor transient did | Run one timeout or `429` scenario |
| Terminal vendor failure -> DynamoDB `SUBMISSION_FAILED` -> acknowledgement | Failure details persisted, `order.submission_failed` published, no worker DLQ entry | Covered locally only | Run one authentication or request-rejection scenario |
| Operator retry -> `order.submission_retry_requested` -> delivery queue -> success | Failed order returns to `PENDING_SUBMISSION`, actionable retry event reaches worker, final `SUBMITTED` | Not tested in AWS | Run after the terminal-failure journey |
| Duplicate delivery event | No second external effect and message is acknowledged | Covered locally; provider idempotency observed during recovery | Add a deterministic AWS duplicate only if the harness can count vendor submissions |
| Worker DLQ -> managed redrive -> delivery queue -> worker | AWS-managed move task completes and the recovered message is consumed | Previous recovery used manual send-then-delete because of the old CLI | Repeat once with `start-message-move-task` |
| Webhook -> DynamoDB -> Stream -> SNS filter | Applied, duplicate, stale, and conflicting provider events produce correct order state and no delivery resubmission | Applied and duplicate paths passed; stale/conflict mostly local | Add stale and event-ID conflict HTTP cases; one non-actionable routing assertion is enough |

## Architecture gap: SNS subscription failures

The publisher failure queue handles DynamoDB Stream records that the publisher
cannot process. The worker DLQ handles messages that reached the delivery queue
but the worker could not complete.

There is currently no dead-letter queue on the SNS subscription itself. If SNS
exhausts delivery to SQS, neither existing failure queue owns that failure.
Before the expanded campaign, choose one of these explicit positions:

1. Add an SNS subscription DLQ and test its policy and redrive behavior.
2. Accept SNS-managed retries without retained terminal evidence and document
   that limitation.

Adding another SQS queue has no idle request charge, but it is an infrastructure
and cost-model change and therefore requires review before implementation.

## Initial cloud safety boundary

The first expanded campaign remains bounded by:

- At most 200 API Gateway requests.
- At most 20 synthetic orders.
- At most 10 directly injected SNS/SQS test messages.
- At most 5 poison or retry-exhaustion scenarios.
- At most 1,000 Lambda invocations.
- No increase to concurrency, retention, DynamoDB throughput caps, or log
  retention.
- Incremental AWS cost ceiling: `$0.02`.

The harness must count operations, stop on an unexpected backlog, and clean up
all synthetic records and messages. If the final selected matrix cannot fit
inside these limits, the remaining cases and a revised estimate must be
reviewed before increasing a cap.
