# Vendor rate-limit and worker-DLQ drill

Status: design proposed; no harness or AWS mutation approved yet

Reviewed: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

Required AWS CLI profile: `pingusportro-admin`

## Objective

Prove in AWS that one real `429` response from the mock delivery vendor:

1. is classified as the retryable `RATE_LIMITED` vendor failure;
2. makes the worker report only that SQS record as failed;
3. keeps the order at `PENDING_SUBMISSION` without a status write;
4. reuses one provider submission key across every attempt;
5. reaches the delivery-worker DLQ after the configured receive bound;
6. can be inspected and redriven with the SQS managed-redrive API; and
7. succeeds exactly once after the vendor recovers.

The drill covers both the transient-vendor and managed-redrive rows in the
[error and event-journey matrix](error-and-event-journey-matrix.md).

AWS makes a failed partial-batch record visible again after the queue visibility
timeout, and a configured DLQ retains messages that repeatedly fail:
<https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html>.

## Why use `429` instead of a timeout

Both failures follow the same retryable application and SQS path. `429` is the
safer representative because:

- the mock rejects before accepting the delivery, so the provider outcome is
  certain;
- every Lambda attempt returns promptly instead of waiting for the three-second
  HTTP timeout;
- it creates less Lambda duration and lower cost; and
- the mock's `Retry-After: 1` also proves that the HTTP client does not create a
  nested retry loop or sleep inside Lambda.

Timeout and other retryable mappings remain covered through their real local
HTTP boundaries. A separate timeout cloud drill would repeat the same AWS
orchestration while adding cost and uncertain-outcome recovery.

## Live baseline

Read-only inspection on 2026-07-27 confirmed:

| Setting | Deployed value |
| --- | --- |
| AWS CLI | `2.36.8`; managed-redrive commands available |
| Worker function | `Active`; last update successful |
| Worker memory and timeout | 128 MB; 15 seconds |
| Vendor HTTP timeout | 3 seconds |
| SQS mapping | `Enabled`; batch size 2; partial failures enabled |
| Worker maximum concurrency | 2 |
| Delivery visibility timeout | 90 seconds |
| Delivery `maxReceiveCount` | 3 |
| Delivery retention | 1 day |
| Delivery queue | Empty |
| Existing vendor URL | Old random Quick Tunnel URL; tunnel is stopped |
| Local mock and tunnel processes | Not running |
| Budget | `$0.00` actual and forecast |

Quick Tunnels generate a new random `trycloudflare.com` hostname each time they
start, so the old deployed hostname cannot be restarted:
<https://developers.cloudflare.com/tunnel/setup/#quick-tunnels-development>.

## Isolation and input

The drill will bypass the public API and conditionally insert exactly one valid
synthetic order item into the deployed table. This avoids a Cognito user,
idempotency record, merchant-reference record, and unrelated API cases while
still exercising the real asynchronous path:

```text
One valid DynamoDB order INSERT
  |
  v
DynamoDB Stream -> publisher Lambda -> SNS -> delivery SQS queue
                                                |
                                                v
                                       delivery worker Lambda
                                                |
                                                | repeated HTTP 429
                                                v
                                         delivery-worker DLQ
                                                |
                                                | managed redrive after recovery
                                                v
                                       delivery queue -> worker -> 201
                                                |
                                                v
                                     DynamoDB order becomes SUBMITTED
```

The item will contain:

- unique drill-prefixed order, merchant-reference, submission, correlation, and
  causation identifiers;
- only synthetic items, prices, and Bucharest test addresses;
- status `PENDING_SUBMISSION`, version 1, and an `ORDER_CREATED` mutation;
- all top-level keys and indexes required by the DynamoDB repository; and
- no customer name, phone number, email, payment data, or production value.

The put must require `attribute_not_exists(pk) AND attribute_not_exists(sk)`.
The normal stream publisher creates `order.created`; the normal SNS filter
routes it to the worker. No direct SNS or SQS message is injected.

## Temporary vendor endpoint

Because the previous Quick Tunnel is stopped, the drill needs one reviewed
CloudFormation parameter update:

1. Generate a new temporary bearer token without printing it.
2. Start the local mock on `127.0.0.1:4000` with default scenario
   `rate-limit`.
3. Start one Quick Tunnel and capture its generated HTTPS URL.
4. Create a CloudFormation change set using the deployed template.
5. Set only `VendorBaseUrl` and `VendorAuthToken`; explicitly use each current
   value for every other parameter.
6. Require the change set to modify only the delivery-worker function in place.
7. Execute it only after the harness's real AWS mutation receives approval.

CloudFormation supports retaining each existing parameter with
`UsePreviousValue`:
<https://docs.aws.amazon.com/cli/latest/reference/cloudformation/update-stack.html>.

This rotates an existing Lambda environment configuration. It creates no
resource and changes no timeout, memory, concurrency, queue, retention,
throughput, log-retention, or IAM setting.

The temporary token may be retained only in an ignored local recovery file with
mode `0600`. It must never appear in command logs, process output, documentation,
or committed files. CloudFormation input must be supplied through a mode-`0600`
CLI input file so the token is not exposed in the process command line. Both
files are removed after successful cleanup.

## Safe vendor-attempt evidence

Before implementing the cloud harness, the local mock runner will gain an
optional append-only attempt journal. For each authenticated request it may
record only:

- timestamp;
- selected scenario;
- correlation ID;
- SHA-256 digest of the idempotency key; and
- final HTTP status.

It must not record the bearer token, raw idempotency key, request body,
addresses, or provider response. Local tests will prove these exclusions.

The drill must require:

- every rate-limited attempt has the same correlation ID and key digest;
- every pre-recovery response is `429`;
- the worker has one safe `delivery.message.failed` log per failed receive,
  correlated to the synthetic order and event; and
- recovery adds exactly one `201` attempt using the same key digest.

## DLQ proof

The harness will wait at most eight minutes for the marked message to reach the
delivery-worker DLQ. The 90-second visibility timeout and `maxReceiveCount=3`
make this deliberately slower than the publisher drill.

It must inspect, without deleting:

- exactly one DLQ message;
- a body that parses as the expected `order.created` event;
- the unique aggregate ID, submission key, correlation ID, and event version;
- an `ApproximateReceiveCount` greater than the configured bound; and
- an order that remains `PENDING_SUBMISSION`, version 1, without provider
  acceptance or failure details.

Receiving a message for inspection temporarily hides it. After an exact match,
the harness will set its visibility back to zero before managed redrive. Any
unexpected message or queue backlog stops automation and is preserved.

## Recovery with managed redrive

After the exact DLQ message is verified:

1. Restart the local mock on the same port and token with scenario `success`;
   keep the Quick Tunnel running.
2. Recheck that the delivery queue is empty and the worker DLQ contains only
   the matched message.
3. Call `StartMessageMoveTask` on the worker DLQ without a custom destination,
   which selects the message's original source queue.
4. Poll `ListMessageMoveTasks` and require one completed move.
5. Require the order to become `SUBMITTED`, version 2, with a provider order ID
   and acceptance time.
6. Require the delivery queue and worker DLQ to finish empty.

AWS managed redrive assigns a new message ID and enqueue time and can route a
DLQ message back to its original source:
<https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html>.

The successful worker transaction also creates a provider-order lookup item.
Cleanup must transactionally delete both the order and that lookup only after
checking their exact drill identifiers, version, submission key, and provider
order ID. Their DynamoDB `REMOVE` records are excluded from publication.

## Guardrails and interruption recovery

Before any mutation, the future harness must:

1. Verify account `454921778743`, profile `pingusportro-admin`, and Region
   `eu-central-1`.
2. Require stack status `UPDATE_COMPLETE` and fresh drift status `IN_SYNC`.
3. Require all four deployed queues to be empty.
4. Re-read the table, stream, topic, worker, mappings, queue attributes, and
   redrive policy from CloudFormation and AWS.
5. Refuse an existing drill item, local recovery file, mock process, tunnel
   process, or active DLQ move task.

During the drill:

- create exactly one synthetic order item;
- allow no more than one source message and one DLQ message;
- never disable a mapping or modify a queue;
- never raise concurrency, throughput, timeout, or retention;
- never delete or redrive an unverified message; and
- stop if any unrelated queue message or table item appears.

The process records each completed action before continuing. If the terminal,
mock, or tunnel stops after injection, the bounded SQS redrive policy eventually
retains the message in the DLQ; it does not retry forever. Cleanup mode may
start a new tunnel and update only the two vendor parameters again, then resume
from the observed order and queue state.

On success or resumed cleanup, it must:

- complete the verified message's recovery before deleting its data;
- conditionally delete only the two marked DynamoDB items;
- stop the local mock and tunnel;
- delete the local token and recovery state;
- verify all four deployed queues are empty;
- verify no drill item or process remains;
- require the mappings to be enabled and the stack `UPDATE_COMPLETE`;
- run fresh drift detection and require `IN_SYNC`; and
- recheck the budget.

After the tunnel stops, the deployed vendor URL is intentionally unreachable,
as it was before this drill. It remains a CloudFormation-managed parameter and
has no idle charge. Any later vendor test must rotate it to a new temporary URL.

## Workload and cost boundary

Expected workload:

- one CloudFormation change set and in-place worker configuration update;
- one synthetic order item;
- one publisher invocation for `order.created` and one for `order.submitted`;
- at most four failed worker invocations plus one successful recovery;
- at most four `429` vendor calls plus one `201` call;
- one SQS managed-redrive task moving exactly one verified message;
- one worker DynamoDB status transaction;
- one cleanup transaction deleting at most two marked items;
- less than 100 KiB of new log and message data;
- zero API Gateway requests and zero Cognito operations; and
- one Quick Tunnel for at most 20 minutes.

Diagnostic ceilings are 200 low-cost calls per AWS service, consistent with the
already approved campaign rule. Side-effect limits remain stricter: one order,
one queue message, one DLQ message, one redrive, one provider acceptance, and
at most two vendor-parameter updates if interruption recovery needs a new URL.

The conservative incremental estimate is below `$0.001`:

| Component | Conservative bound |
| --- | ---: |
| Five 128 MB worker invocations plus two publisher invocations | `< $0.0001` |
| DynamoDB writes, reads, stream reads, SNS, and SQS requests | `< $0.0002` |
| CloudWatch ingestion and one-day retention below 100 KiB | `< $0.0001` |
| CloudFormation control plane and Quick Tunnel | `$0` |
| Rounding and diagnostic margin | `< $0.0006` |

No fixed-cost resource is added. This fits inside both the approved `$0.02`
failure-campaign ceiling and the project's `$5` monthly budget.

## Approval boundary

This document does not authorize implementation, starting the public tunnel,
updating the stack, inserting the item, invoking the vendor, or starting
managed redrive.

The next review should approve or change these four decisions:

1. use deterministic `429` instead of timeout;
2. rotate only the existing worker URL and token through CloudFormation;
3. inject one valid order item at DynamoDB rather than create an API user/order;
4. recover the exact DLQ message with SQS managed redrive.
