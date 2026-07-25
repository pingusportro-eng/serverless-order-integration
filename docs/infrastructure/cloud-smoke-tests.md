# Cloud smoke-test record

Status: passed after correcting defects found by the test

Tested: 2026-07-25

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

AWS CLI profile: `pingusportro-admin`

## Scope and cost boundary

The test used one synthetic Cognito operator, one synthetic order, one provider
submission, one applied webhook event, its duplicate, and one expired webhook.
API Gateway received exactly 30 requests, matching the approved cap. No
concurrency, retention, throughput, encryption, or fixed-cost setting was
increased.

The existing `$1` Zero-Spend Budget reported `$0.00` actual and forecast spend
after the test. AWS billing data can be delayed, so this is evidence of the
current billing view rather than a guarantee that every usage record has
arrived.

## Results

| Boundary | Evidence | Result |
| --- | --- | --- |
| API authorization | An order-list request without a token returned `401` | Passed |
| Cognito authorization | One confirmed user with the `operators` group obtained an access token | Passed |
| Create order | Corrected request returned `201`; one order and its supporting records were committed atomically | Passed |
| Idempotency | Identical body and `Idempotency-Key` returned `200` with `Idempotency-Replayed: true` and the same order | Passed |
| DynamoDB Stream | Publisher event-source mapping remained `Enabled` with `LastProcessingResult=OK` | Passed |
| SNS to SQS | The `order.created` event reached the delivery queue; later non-actionable event types did not | Passed |
| Delivery worker and vendor | The recovered event submitted once to the public mock vendor and changed the order to `SUBMITTED`, version 2 | Passed |
| Retry and DLQ | A consumer-poison event was received four times, retained in the worker DLQ, inspected, and redriven | Passed |
| Webhook | Valid `DELIVERY_PICKED_UP` returned `204` and changed the order to version 3 | Passed |
| Webhook deduplication | Repeating the same provider event returned `204` without another version change | Passed |
| Replay protection | A correctly signed webhook with a timestamp ten minutes old returned `401` | Passed |
| Final state | Strongly consistent DynamoDB read returned `PICKED_UP`, version 3, with the original provider order ID | Passed |

The 30 API access records had this final status distribution:

```text
200: 21
201: 1
204: 2
401: 2
500: 4
```

The four `500` responses were the deliberate reproductions used to diagnose the
cloud-only defects below. No assertion was silently ignored.

## Defects found and corrected

### Transaction IAM actions

The first create attempts returned `500` with `AccessDeniedException`.
`TransactWriteItems` is the SDK/API operation, but DynamoDB authorizes each
transaction member through its underlying `PutItem`, `UpdateItem`, or
`ConditionCheckItem` IAM action. The initial policies incorrectly granted
`dynamodb:TransactWriteItems`.

The Orders API, webhook, and worker roles now grant only the underlying actions
they use on the one table. Every write grant is constrained with
`dynamodb:EnclosingOperation=TransactWriteItems`, preventing standalone writes.
The webhook role additionally grants `ConditionCheckItem` because duplicate and
stale events transactionally check the order version before recording the event.
This follows the
[AWS transaction IAM model](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

### Platform request-ID compatibility

API Gateway supplied a padded request ID such as `BC8AYho8FiAEPYQ=`. It was
correctly stored as event causation metadata, but the delivery parser and JSON
Schema rejected the trailing Base64 padding. The event contract now accepts up
to two trailing `=` characters while continuing to reject `=` in the middle of
an identifier.

The original real event was kept as evidence and passed the corrected parser
before redeployment.

### Safe failure diagnostics

Orders, worker, and webhook adapters caught expected boundary failures but did
not record their exception class. Structured logs now allow-list
`exceptionName`. This exposed `AccessDeniedException` without logging messages,
request bodies, tokens, addresses, or vendor responses. Regression tests verify
both the diagnostic field and the continued exclusion of free-form exception
details.

## Poison-event recovery

The request-ID contract mismatch turned the valid `order.created` event into a
real consumer poison event:

1. The worker returned the message ID in `batchItemFailures`.
2. SQS retried after each 90-second visibility period.
3. The message appeared in the worker DLQ with
   `ApproximateReceiveCount=4`, proving that redrive occurred after the
   configured `maxReceiveCount=3` was exceeded.
4. The installed AWS CLI predates SQS managed redrive commands, so the retained
   body was sent back to the source queue and the original DLQ copy was deleted
   only after the send succeeded.
5. After the parser correction, the next delivery succeeded and both the source
   queue and DLQ became empty.

This recovery also demonstrated why a DLQ is retention for investigation rather
than an automatic replay mechanism.

## Final evidence

| Item | Final observation |
| --- | --- |
| CloudFormation | `UPDATE_COMPLETE`; drift `IN_SYNC` |
| Delivery queue | 0 visible, 0 in flight |
| Delivery DLQ | 0 visible, 0 in flight |
| Publisher failure queue | 0 visible, 0 in flight |
| Stream mapping | `Enabled`, last result `OK` |
| SQS mapping | `Enabled` |
| DynamoDB | 5 synthetic items; final order `PICKED_UP`, version 3 |
| Lambda log starts | Orders 25; publisher 3; worker 6; webhook 4 |
| Cognito | 1 confirmed synthetic operator |
| Log retention | All five groups remain at 1 day |
| SAM packaging prefix | 40 objects, 17,753,944 bytes |
| Budget view | `$0.00` actual, `$0.00` forecast; reporting may be delayed |

## Teardown boundary

The AWS stack, synthetic operator, five DynamoDB items, SAM packaging objects,
local mock vendor, and Cloudflare tunnel remain only so this result can be
reviewed. All queues are empty and no further test traffic will be generated.

Step 5.6 must stop the local processes, delete the application stack, remove
the project packaging objects and project-specific managed SAM resources, and
verify that no project resource remains.
