# Terminal failure and operator-retry campaign

Status: passed and cleaned up

Tested: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

AWS CLI profile: `pingusportro-admin`

## Purpose

This campaign completed the public-error and event-journey matrix without
breaking live IAM or increasing concurrency, retention, throughput, or any
fixed-cost resource. It proved:

- a non-retryable vendor response is acknowledged only after
  `SUBMISSION_FAILED` is stored;
- `order.submission_failed` is published but excluded from the delivery queue;
- an operator can explicitly retry the failed order;
- `order.submission_retry_requested` reaches the worker and the same provider
  delivery-provider submission key is reused;
- signed provider webhooks apply, deduplicate, reject conflicting event IDs,
  and ignore stale state changes;
- a duplicate actionable SQS event is acknowledged without another vendor
  request; and
- the deployed API throttle produces a platform-native `429`.

The executable procedure is
[`scripts/cloud/terminal-retry-campaign.sh`](../../scripts/cloud/terminal-retry-campaign.sh).
Its local guard tests are
[`tests/scripts/terminal-retry-campaign.test.ts`](../../tests/scripts/terminal-retry-campaign.test.ts).

## Safety boundary

The run used one synthetic order, two temporary Cognito users, one temporary
SQS audit queue, and one temporary SNS subscription. The audit subscription
captured the real domain events without changing the application subscription.
The campaign made 125 HTTP requests against its 200-request cap:

- 25 setup, error-path, retry, and webhook requests, including two expected
  retries after native throttling;
- 100 sustained throttle-test requests with concurrency limited to two.

Per-service diagnostic calls remained below 200. The test introduced no
persistent resource type, fixed charge, concurrency change, or retention
increase.

## Event journey

The temporary audit subscription captured these unique events for one order:

| Aggregate version | Event | Result |
| ---: | --- | --- |
| 1 | `order.created` | Entered the delivery queue |
| 2 | `order.submission_failed` | Published, but filtered out of the delivery queue |
| 3 | `order.submission_retry_requested` | Entered the delivery queue |
| 4 | `order.submitted` | Published, but filtered out of the delivery queue |
| 5 | `order.picked_up` | Published, but filtered out of the delivery queue |
| 6 | `order.delivered` | Published, but filtered out of the delivery queue |

The first vendor call returned deterministic HTTP `422` and produced failure
reason `REQUEST_REJECTED`. The retry returned `201`. The two journal entries
had the same idempotency-key digest and the expected create/retry correlation
IDs.

Injecting the version-3 retry event again after the order reached version 6
caused no third vendor journal entry. This proves the worker acknowledged the
duplicate/stale action without repeating the external effect.

## HTTP and webhook coverage

The deployed routes reproduced:

- missing token `401`;
- authenticated non-operator `403`;
- malformed JSON and malformed `If-Match` `400`;
- missing `If-Match` `428`;
- stale version `412`;
- idempotency, merchant order ID, invalid-transition, and provider-event
  conflicts `409`;
- missing API order and unknown delivery-provider order `404`;
- invalid create, list, status, and webhook values `422`;
- applied pickup and delivered webhooks `204`;
- stale webhook `204` without a version change; and
- 51 platform-native `429` responses from the final bounded load, alongside 49
  successful reads.

Unexpected Lambda failures remain local-only tests because deliberately
breaking deployed IAM would not add useful orchestration evidence.

## Defect found by the real AWS boundary

The temporary operator's access token correctly contained the `operators`
group. API Gateway exposed the Cognito group claim to Lambda as the string
`[operators]`, while the adapter understood arrays, JSON arrays, and
comma-separated strings only. The real operator therefore received `403`.

The adapter now recognizes API Gateway's bracketed representation while still
requiring the exact `operators` entry. A regression test uses `[operators]`.
The reviewed hotfix change set updated the four built Lambda artifacts and the
dependent HTTP API in place, with no replacement or infrastructure-setting
change. The rerun proved that the non-operator still received `403` and the
operator reached the status handler.

The initial 40-way throttle burst produced 11 successes and 29 native `503`
responses because it also stressed the Lambda integration. The final test used
100 requests with concurrency two so it exercised the stage rate limit without
turning the test into a Lambda-concurrency drill.

## Cleanup and final audit

Successful cleanup permanently deleted:

- the synthetic order, its idempotency/merchant order ID/delivery-provider mappings, and three
  processed-webhook markers;
- the temporary audit subscription and queue; and
- both temporary Cognito users.

It also stopped the mock vendor and Quick Tunnel and removed local recovery
secrets. An independent post-run audit found:

- CloudFormation `UPDATE_COMPLETE`, drift `IN_SYNC`, zero drifted resources;
- all four deployed queues at zero visible, in-flight, and delayed messages;
- one expected SNS-to-SQS application subscription and no temporary queue;
- zero `terminal-campaign-*` users and zero marked DynamoDB items;
- no available change set, recovery state, local vendor/tunnel process, or
  running Compose container;
- 49 project artifacts totalling 22,174,164 bytes, below the approved 50 MiB
  cap; and
- the existing `$1` budget view at `$0.00` actual and `$0.00` forecast.

Billing data can be delayed, so the budget values record the observed billing
view rather than guaranteeing that every usage record has arrived.
