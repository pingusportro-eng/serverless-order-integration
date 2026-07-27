# Stream-publisher failure drill

Status: passed in AWS; temporary resources, messages, and drill item removed

Reviewed: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

Required AWS CLI profile: `pingusportro-admin`

## Objective

Prove in AWS that one malformed DynamoDB order record:

1. passes the event-source filter;
2. is rejected by the publisher;
3. is attempted initially and retried twice;
4. is retained as invocation metadata in the publisher failure queue;
5. no longer blocks its DynamoDB Stream shard after exhaustion; and
6. can be matched, investigated, and removed without touching unrelated data.

AWS documents that function errors are retried until the configured retry or
age boundary is reached, after which the event-source mapping discards the
record, sends invocation metadata to its failure destination, and continues
processing the stream:
<https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html>.

## Important destination limitation

For DynamoDB Streams, an SQS or SNS on-failure destination does not contain the
original stream records. Its message contains invocation metadata including:

- failure condition;
- function ARN and invocation count;
- stream ARN;
- shard ID;
- first and last sequence numbers; and
- discarded batch size.

AWS includes the original invocation payload only for an S3 destination. For
SQS, the documented investigation flow is to use the retained shard and
sequence information to retrieve the record from the stream before its
24-hour retention expires.

The drill must therefore never identify or delete the failure message merely
because it is the only message in the queue.

## Live baseline

Read-only inspection on 2026-07-27 confirmed:

| Setting | Deployed value |
| --- | --- |
| Mapping state | `Enabled` |
| Last processing result | `OK` |
| Batch size | `10` |
| Retry attempts | `2` |
| Maximum record age | `3600` seconds |
| Partial failure reporting | `ReportBatchItemFailures` |
| Bisect on function error | `true` |
| Parallelization factor | `1` |
| Failure destination | Deployed publisher failure queue |
| Filter | `INSERT`/`MODIFY` with `entityType.S = ORDER` |
| Table | `ACTIVE`, on-demand, `NEW_IMAGE` stream |
| Publisher failure queue | Empty, one-day retention, SQS-managed encryption |
| Budget | `$0.00` actual and forecast |

AWS uses the lowest returned failed sequence number as the checkpoint and
retries from that point when partial batch failure reporting is enabled:
<https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html>.

## Synthetic item

The harness will generate a unique marker, order ID, primary key, and sort key.
It will first write one item smaller than 1 KiB containing:

- the exact unique drill marker;
- `entityType = ORDER`, so the event-source filter accepts it;
- an unsupported `schemaVersion`, so publisher parsing fails deterministically;
  and
- no customer, payment, address, or other personal data.

The write uses `attribute_not_exists(pk) AND attribute_not_exists(sk)` so it
cannot overwrite an existing item.

```text
DynamoDB malformed INSERT
  |
  v
DynamoDB Stream -> publisher Lambda
                       |
                       | initial attempt + 2 retries
                       v
                 publisher failure queue
                 (metadata, not original payload)
```

## Exact failure-message proof

The harness will poll only the deployed publisher failure queue for at most
120 seconds. It will preserve any unexpected message.

For a candidate failure message it must require:

- `requestContext.condition = RetryAttemptsExhausted`;
- the deployed publisher function ARN;
- the deployed stream ARN;
- a discarded batch size of one;
- equal start and end sequence numbers; and
- a non-empty shard ID and sequence number.

It will then request a DynamoDB Streams iterator at that exact sequence number,
read the record, and require:

- the same stream sequence number;
- the synthetic item key;
- `entityType = ORDER`;
- the unsupported schema version; and
- the exact unique drill marker.

Only after this record-level match may the failure message be deleted.

Using that verified sequence number, the harness will query only the publisher
log group and require three structured `stream.record.failed` entries—initial
attempt plus two retries—with:

- the sequence number as `requestId`;
- `operation = parseOrderStreamRecord`; and
- a safe exception name without the item or marker payload.

This supplies retry-count and log-safety evidence without searching unrelated
application data.

## Proving the shard continues

After the poison record reaches the failure destination, the harness will
repair the same DynamoDB item with a valid version-1 `CANCELLED` order and
status-change mutation. Updating the same item guarantees the recovery record
belongs to the same stream shard and follows the poison record.

The repair emits the non-actionable `order.cancelled` event. Before injection,
the harness will create one temporary SQS queue and topic subscription filtered
by both:

- `eventType = order.cancelled`; and
- the unique `aggregateId`.

The temporary queue will have a topic-scoped SNS send policy. Receiving and
schema-checking that exact event proves the publisher moved beyond the poison
record. The deployed delivery subscription excludes `order.cancelled`, so the
delivery worker and vendor receive nothing.

## Guardrails

Before mutation, the harness must:

1. Verify account `454921778743`, profile `pingusportro-admin`, and Region
   `eu-central-1`.
2. Require stack status `UPDATE_COMPLETE` and fresh drift status `IN_SYNC`.
3. Re-read the table, stream, mapping, function, topic, queues, and policies
   from CloudFormation and AWS.
4. Require the mapping values in the live-baseline table above.
5. Require all four deployed queues to be empty.
6. Require the synthetic DynamoDB key to be absent.
7. Refuse a prior recovery-state file, drill item, queue, or subscription.

During the drill:

- write exactly one malformed item;
- create no synthetic order through the public API;
- wait for exhaustion before writing the valid repair;
- never modify the event-source mapping, IAM, retention, concurrency, or
  throughput controls;
- never call the delivery vendor;
- stop on an unexpected queue message or backlog; and
- retain enough local state to recover after interruption.

## Cleanup and interruption recovery

On success, or when explicitly resumed after failure, `SIGINT`, or `SIGTERM`,
cleanup must:

1. Preserve any unverified failure or recovery message.
2. Delete a queue message only after its body or referenced stream record
   matches the saved marker.
3. Unsubscribe and delete only the temporary marker subscription and queue.
4. Delete the DynamoDB item with a condition requiring its exact marker.
5. Verify the publisher mapping returns to `OK`.
6. Verify all deployed queues are empty.
7. Verify no drill item, temporary queue, or subscription remains.
8. Run fresh drift detection and require `IN_SYNC`.

The ignored `.aws-sam/cloud-drill/` directory may store non-secret recovery
state. Because deleting or repairing the table item cannot erase an already
committed stream record, cleanup mode must still wait for and identify any
published failure record before declaring success.

Before the poison write, the process trap removes any temporary setup resource
it recorded. After the poison write is attempted, it preserves the temporary
subscriber and state instead of discarding evidence; the operator or automated
test runner must immediately invoke cleanup mode. The cleanup integration test
forces an interruption at exactly that boundary.

## Cost and workload boundary

The drill is capped at:

- three DynamoDB writes: malformed insert, valid repair, and conditional delete;
- five expected publisher Lambda invocations: three poison attempts, one
  recovery event, plus one margin;
- one temporary standard SQS queue for at most five minutes;
- one temporary SNS subscription;
- at most 100 SQS requests;
- at most 50 SNS requests;
- at most 50 DynamoDB Streams requests;
- at most 50 CloudWatch Logs requests;
- at most 20 DynamoDB requests;
- at most 20 Lambda control-plane requests;
- less than 2 KiB of synthetic table and message data;
- zero API Gateway requests;
- zero delivery-worker invocations; and
- zero vendor calls.

The conservative incremental estimate is below `$0.001`, even without relying
on Free Tier, and remains inside the approved `$0.02` campaign ceiling. The
temporary standard queue and subscription have no idle hourly charge.

The higher request ceilings provide room for eventual-consistency polling,
diagnosis, and interrupted-run recovery. They do not increase the strict
side-effect limits: one item, one repair, one conditional delete, one queue,
and one subscription.

The owner approved this design, the real AWS mutation, and the increased
diagnostic caps on 2026-07-27.

## Harness

The implementation is
[`scripts/cloud/stream-publisher-failure-drill.sh`](../../scripts/cloud/stream-publisher-failure-drill.sh).
It has no default execution mode:

```bash
npm run test:publisher-failure-drill
scripts/cloud/stream-publisher-failure-drill.sh run
scripts/cloud/stream-publisher-failure-drill.sh cleanup
```

The automated test replaces the AWS CLI with a stateful fake and creates no AWS
resources. It covers:

- refusal without an explicit mode;
- empty SQS polls before both expected messages;
- delayed CloudWatch Logs availability;
- exact failure metadata and stream-record correlation;
- exactly three structured failure logs;
- the valid same-item recovery event;
- verified message deletion and conditional item deletion; and
- interruption immediately after the poison write followed by cleanup-mode
  recovery.

The local `run` simulation, forced-interruption recovery, shell syntax checks,
and full project verification pass.

## AWS execution record

The approved drill ran on 2026-07-27 in account `454921778743` and Region
`eu-central-1`. The malformed item produced one discarded invocation record
whose stream sequence resolved back to the exact synthetic key and marker.
CloudWatch contained exactly three structured `stream.record.failed` entries
for that sequence: the initial attempt and two configured retries.

Repairing that same item produced the expected `order.cancelled` event in the
isolated recovery queue. This proved that processing continued on the same
stream shard after retry exhaustion. The deployed delivery subscription
filtered the event out, so the delivery worker and vendor were not called.

The execution exposed two compatibility cases:

- this machine's `date +%s%3N` output combined epoch seconds with nine
  nanosecond digits instead of producing the 13-digit epoch-millisecond value
  required by CloudWatch Logs; and
- Lambda text-format log messages prefix the structured JSON with timestamp,
  request ID, and log-level fields separated by tabs.

The first issue caused the initial log query to search in the future. The
second would have prevented parsing even with a corrected start time. The
harness now generates milliseconds arithmetically, repairs the old saved
timestamp during recovery, and extracts the final tab-separated JSON field.
The fake AWS fixture reproduces the real Lambda log format, and the recovery
test locks both behaviors.

Final evidence:

- the verified publisher-failure and recovery messages were deleted;
- the marked DynamoDB item was conditionally deleted;
- the temporary SNS subscription and SQS queue no longer exist;
- the recovery-state file no longer exists;
- the delivery queue and all three failure queues report zero visible,
  in-flight, and delayed messages;
- no stream-publisher drill item or drill-named queue remains;
- the publisher event-source mapping reports `Enabled` and `OK`;
- the stack is `UPDATE_COMPLETE` and its fresh drift result is `IN_SYNC`; and
- the `$1` zero-spend budget reports `$0.00` actual and forecast spend.

Across the interrupted run and successful recovery, the harness used 26 SQS,
5 SNS, 10 DynamoDB, 2 DynamoDB Streams, 25 CloudWatch Logs, and 5 Lambda
control-plane requests. Every cap remained intact, and the incremental
estimate remains below `$0.001`.
