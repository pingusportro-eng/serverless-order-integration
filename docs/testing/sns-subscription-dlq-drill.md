# SNS subscription-DLQ failure drill

Status: passed in AWS; temporary resources and marker removed

Reviewed: 2026-07-27

Stack: `serverless-order-integration-dev`

Region: `eu-central-1`

Required AWS CLI profile: `pingusportro-admin`

## Objective

Prove with one real AWS message that an SNS-to-SQS client-side delivery failure
is retained in the deployed SNS subscription DLQ, then remove all drill data and
temporary resources.

AWS documents that preventing SNS from accessing a subscribed endpoint is a
client-side error. SNS does not retry that class of failure; when the
subscription has a redrive policy, the message is retained in its DLQ:
<https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html>.

## Isolation decision

The drill will not change the live delivery queue policy. Temporarily denying
the deployed subscription would create CloudFormation drift and could leak a
test message to the delivery worker if policy propagation were delayed.

Instead, create one isolated standard SQS target queue and one temporary
subscription on the deployed topic:

```text
Domain-events SNS topic
  |
  | existing filter: order.ready_for_submission or retry_requested
  +------------------------------------------> Delivery queue (unchanged)
  |
  | temporary filter: sns.subscription_dlq_drill
  v
Temporary target queue with no SNS SendMessage policy
  |
  | client-side authorization failure
  v
Deployed SNS subscription DLQ
```

The temporary subscription will use the deployed subscription DLQ as its
`deadLetterTargetArn`. This proves the real topic-to-DLQ delivery mechanism and
the deployed DLQ policy without mutating the main subscription. The main
subscription's own redrive attribute has already been read back and verified
against the same queue ARN.

## Temporary resources and message

The harness may create only:

- one standard SQS queue whose name begins
  `serverless-order-integration-dev-sns-dlq-drill-`;
- one SQS subscription on the existing domain-events topic; and
- one small synthetic SNS message.

The target queue will have:

- SQS-managed encryption;
- five-minute message retention;
- the project and environment tags plus `Purpose=sns-dlq-drill`; and
- no queue policy granting SNS `sqs:SendMessage`.

The temporary subscription will have:

- raw message delivery enabled;
- a filter accepting only
  `eventType=sns.subscription_dlq_drill`; and
- a redrive policy targeting the deployed subscription DLQ.

The published body will be a unique non-domain marker, not an order or valid
domain event. The existing delivery subscription therefore filters it out, so
the delivery worker and vendor cannot receive it.

## Guardrails

Before mutation, the harness must:

1. Verify account `454921778743`, profile `pingusportro-admin`, and Region
   `eu-central-1`.
2. Require stack status `UPDATE_COMPLETE` and fresh drift status `IN_SYNC`.
3. Re-read the topic, main subscription, deployed subscription-DLQ ARN, and
   queue policy from CloudFormation/AWS rather than accepting arbitrary inputs.
4. Require all four deployed queues to be empty.
5. Refuse to run if a previous drill queue or temporary drill subscription
   exists.

During the drill:

- create the queue before the subscription;
- verify the temporary queue has no SNS access policy;
- publish exactly one message with the unique drill event attribute;
- poll only the deployed subscription DLQ for at most 90 seconds;
- require exactly one received message and an exact marker-body match; and
- never delete an unexpected message.

## Cleanup and interruption recovery

The harness must register cleanup immediately after each resource is created.
On success, failure, `SIGINT`, or `SIGTERM`, it must:

1. Unsubscribe the temporary subscription if it exists.
2. Delete the temporary target queue if it exists.
3. Delete the DLQ message only after its marker was positively matched.
4. Verify the delivery queue and all three failure queues are empty.
5. Verify no drill-named queue or subscription remains.
6. Run fresh stack drift detection and require `IN_SYNC`.

The ignored `.aws-sam/` directory may hold a non-secret recovery-state file
containing the temporary queue URL, subscription ARN, marker, and receipt
handle. A separate cleanup-only mode must use that state after a terminal crash
or machine restart. It must validate the account, Region, resource-name prefix,
and topic before deleting anything.

If an unexpected message appears, cleanup must preserve it and report manual
investigation steps instead of claiming success.

## Expected evidence

The drill passes only when:

- SNS returns one publish message ID;
- the temporary target queue remains empty;
- the deployed subscription DLQ receives the exact marker;
- the existing delivery queue remains empty;
- the marker is deleted after inspection;
- temporary resources are removed;
- all deployed queues finish empty; and
- the application stack remains `UPDATE_COMPLETE` and `IN_SYNC`.

No API Gateway request, Lambda invocation, DynamoDB operation, vendor call,
order, webhook, concurrency change, retention change, or log-retention change
is expected.

## Cost and workload bound

The drill is capped at:

- one temporary queue for at most five minutes;
- one temporary subscription;
- one SNS publish;
- at most 100 SQS API requests, including diagnostic and recovery headroom;
- at most 50 SNS API requests, including diagnostic and recovery headroom;
- zero expected Lambda invocations; and
- less than 1 KiB of message payload.

The incremental estimate is below `$0.0001`, even without relying on Free Tier,
and remains inside the campaign's `$0.02` ceiling. Standard SQS queues have no
per-queue hourly charge:
<https://aws.amazon.com/sqs/pricing/>.

## Harness

The guarded implementation is
[`scripts/cloud/sns-subscription-dlq-drill.sh`](../../scripts/cloud/sns-subscription-dlq-drill.sh).
It has no default execution mode:

```bash
npm run test:cloud-drill
scripts/cloud/sns-subscription-dlq-drill.sh run
scripts/cloud/sns-subscription-dlq-drill.sh cleanup
```

The test command uses a fake AWS CLI and creates no AWS resources. `run` is the
real drill and requires explicit temporary-resource execution approval.
`cleanup` recovers an interrupted approved run from its validated state file.

## AWS execution record

The approved drill ran on 2026-07-27 in account `454921778743` and Region
`eu-central-1`. SNS accepted exactly one marker with message ID
`33f5d2b9-1ab4-5795-9be7-b059c5d782df`. The isolated target queue denied SNS
delivery as designed, and the deployed subscription DLQ received the exact
marker body.

The first execution also exposed two AWS CLI behaviors that the fake harness
did not originally reproduce:

- an empty `list-queues` or `receive-message` result may contain no JSON
  document rather than an object with an empty array; and
- SQS approximate queue counters can briefly retain the pre-deletion value.

The harness now normalizes empty CLI responses and retries queue-count reads at
most three times. Its tests reproduce an empty receive followed by delivery and
one stale post-delete count. Recovery mode positively matched and deleted only
the saved marker.

Final evidence:

- the temporary subscription and target queue no longer exist;
- the recovery-state file no longer exists;
- the delivery queue and all three failure queues report zero visible,
  in-flight, and delayed messages;
- the stack is `UPDATE_COMPLETE` and its fresh drift result is `IN_SYNC`; and
- the `$1` zero-spend budget reports `$0.00` actual and forecast spend.

The run-mode caps were never exceeded. Compatibility diagnosis and recovery
required additional read-only and cleanup requests, but the complete episode
remained below 60 SQS calls, below 25 SNS calls, and exactly one publish. Its
incremental estimate therefore remains below `$0.0001`.
