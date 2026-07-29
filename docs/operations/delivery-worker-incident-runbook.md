# Delivery-worker backlog and DLQ incident runbook

Status: ready for use

Last reviewed: 2026-07-29

AWS account: `454921778743`  
Region: `eu-central-1`  
Application stack: `serverless-order-integration-dev`

## Purpose and scope

Use this runbook when delivery submissions are retrying, the Delivery Queue is
growing, or messages appear in the delivery-worker DLQ.

It covers:

- detecting a delivery-worker incident;
- preserving evidence before changing messages;
- distinguishing a provider outage from a poison event or application defect;
- deciding whether managed DLQ redrive is safe; and
- proving recovery without creating duplicate provider submissions.

It does not cover the DynamoDB Stream publisher failure queue or the SNS
subscription DLQ. Those failure paths have separate evidence in
[`stream-publisher-failure-drill.md`](../testing/stream-publisher-failure-drill.md)
and
[`sns-subscription-dlq-drill.md`](../testing/sns-subscription-dlq-drill.md).

## Safety and cost boundary

Start with read-only service state and narrow log queries:

1. Use only AWS account `454921778743`, profile `pingusportro-admin`, and Region
   `eu-central-1`.
2. Do not click **Purge**, **Delete**, **Start DLQ redrive**, or
   **Send and receive messages** during initial diagnosis.
3. Do not change the queue redrive policy, visibility timeout, Lambda
   concurrency, event-source mapping, or retention settings during triage.
4. Do not inspect Lambda environment variables; they contain vendor
   authentication material.
5. Keep CloudWatch queries to the relevant log group, incident window, and at
   most 200 results.
6. Treat `ReceiveMessage` as a mutation: it increments
   `ApproximateReceiveCount` and temporarily changes message visibility.
7. Treat `StartMessageMoveTask` as a recovery mutation. It moves all currently
   eligible messages in the selected DLQ and cannot filter or modify them.

The read-only checks below create no resource. CloudWatch Logs Insights charges
for scanned data, so follow the narrow-query boundary in the
[CloudWatch query cookbook](cloudwatch-query-cookbook.md).

## Know what AWS does automatically

During normal SQS-to-Lambda processing:

1. The Lambda event-source mapping polls the Delivery Queue.
2. It invokes Delivery Worker with an SQS batch.
3. A successful record is eligible for deletion from the queue.
4. A record returned in `batchItemFailures`, or interrupted by a failed Lambda
   invocation, is not deleted.
5. The message stays invisible until its visibility timeout expires.
6. A later receive increments its approximate receive count.
7. After the configured receive threshold is exceeded, SQS moves the message
   to the worker DLQ.

AWS does not automatically decide that the provider is healthy and redrive the
DLQ. An operator or controlled recovery process must request redrive.

## Incident inputs

Record these before investigation:

```text
Incident start time:
Reporter or signal:
Observed customer impact:
Known order ID:
Known correlation ID:
Known event ID:
Delivery Queue visible / in-flight / delayed:
Worker DLQ visible / in-flight / delayed:
Provider status:
```

Use UTC for all incident timestamps.

## 1. Confirm identity and stack state

```bash
aws sts get-caller-identity \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --output json \
  --no-cli-pager
```

Require account `454921778743`.

```bash
aws cloudformation describe-stacks \
  --stack-name serverless-order-integration-dev \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --query 'Stacks[0].{Status:StackStatus,Updated:LastUpdatedTime}' \
  --output json \
  --no-cli-pager
```

If the stack is being created, updated, rolled back, or deleted, stop this
runbook and investigate that operation first. Do not mix queue recovery with an
unsettled infrastructure change.

## 2. Resolve the deployed queue and worker identities

CloudFormation-generated suffixes change between deployments. Resolve the
physical resources instead of copying an old URL:

```bash
delivery_queue_url="$(
  aws cloudformation describe-stack-resource \
    --stack-name serverless-order-integration-dev \
    --logical-resource-id DeliveryQueue \
    --profile pingusportro-admin \
    --region eu-central-1 \
    --query StackResourceDetail.PhysicalResourceId \
    --output text \
    --no-cli-pager
)"

worker_dlq_url="$(
  aws cloudformation describe-stack-resource \
    --stack-name serverless-order-integration-dev \
    --logical-resource-id DeliveryDeadLetterQueue \
    --profile pingusportro-admin \
    --region eu-central-1 \
    --query StackResourceDetail.PhysicalResourceId \
    --output text \
    --no-cli-pager
)"

worker_function="$(
  aws cloudformation describe-stack-resource \
    --stack-name serverless-order-integration-dev \
    --logical-resource-id DeliveryWorkerFunction \
    --profile pingusportro-admin \
    --region eu-central-1 \
    --query StackResourceDetail.PhysicalResourceId \
    --output text \
    --no-cli-pager
)"
```

These variables contain resource identifiers, not credentials. Do not print
the worker configuration or its environment.

## 3. Measure the backlog without receiving messages

For the Delivery Queue:

```bash
aws sqs get-queue-attributes \
  --queue-url "$delivery_queue_url" \
  --attribute-names \
    ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible \
    ApproximateNumberOfMessagesDelayed \
    RedrivePolicy \
    VisibilityTimeout \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --output json \
  --no-cli-pager
```

For the worker DLQ:

```bash
aws sqs get-queue-attributes \
  --queue-url "$worker_dlq_url" \
  --attribute-names \
    ApproximateNumberOfMessages \
    ApproximateNumberOfMessagesNotVisible \
    ApproximateNumberOfMessagesDelayed \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --output json \
  --no-cli-pager
```

Interpret the signals:

| Signal | Likely meaning |
| --- | --- |
| Source visible grows | Worker cannot keep up, mapping is disabled, or retries are returning |
| Source not-visible grows | Lambda is actively processing or waiting for failed visibility timeouts |
| Source oldest age grows | Sustained backlog or blocked processing |
| DLQ visible grows | Messages exhausted the source queue redrive policy |
| DLQ not-visible is nonzero | Another operator or process may be inspecting or redriving messages |

SQS counts are approximate and can lag. Confirm a trend with CloudWatch queue
metrics rather than treating one sample as exact.

In the SQS console, inspect:

- `ApproximateNumberOfMessagesVisible`;
- `ApproximateNumberOfMessagesNotVisible`;
- `ApproximateAgeOfOldestMessage`; and
- the worker DLQ's visible-message graph.

## 4. Verify the Lambda consumer is healthy

```bash
aws lambda list-event-source-mappings \
  --function-name "$worker_function" \
  --event-source-arn "$(
    aws sqs get-queue-attributes \
      --queue-url "$delivery_queue_url" \
      --attribute-names QueueArn \
      --profile pingusportro-admin \
      --region eu-central-1 \
      --query Attributes.QueueArn \
      --output text \
      --no-cli-pager
  )" \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --query 'EventSourceMappings[].{UUID:UUID,State:State,LastResult:LastProcessingResult,BatchSize:BatchSize,FunctionResponseTypes:FunctionResponseTypes}' \
  --output json \
  --no-cli-pager
```

Require:

- `State` is `Enabled`;
- `FunctionResponseTypes` contains `ReportBatchItemFailures`; and
- `LastProcessingResult` does not indicate an infrastructure or permission
  failure.

Inspect the Lambda `Errors`, `Throttles`, and `Duration` metrics for the
incident window. A provider failure can produce application failure records
while the Lambda invocation itself remains technically successful because the
handler returns a partial batch response.

## 5. Identify the failing journey in logs

Use the delivery-worker query in
[Inspect delivery retries](cloudwatch-query-cookbook.md#inspect-delivery-retries).
Start with a known order ID. If none is known, run the safe application-failure
summary first, then narrow to one event.

The important fields are:

```text
event
correlationId
eventId
orderId
aggregateVersion
attempt
exceptionName
outcome
```

Expected retryable-provider pattern:

```text
delivery.message.failed  attempt=1  exceptionName=VendorSubmissionError
delivery.message.failed  attempt=2  exceptionName=VendorSubmissionError
delivery.message.failed  attempt=3  exceptionName=VendorSubmissionError
```

Do not infer the provider's exact HTTP response from
`VendorSubmissionError` alone. Correlate with the vendor's safe availability
signals or request journal.

## 6. Classify before recovery

| Failure class | Evidence | Redrive decision |
| --- | --- | --- |
| Temporary provider outage, timeout, or `429` | Stable event/order identity, increasing attempts, dependency currently unhealthy | Wait; redrive only after provider health is confirmed |
| Provider terminal rejection | Order should become `SUBMISSION_FAILED` and the SQS record should be acknowledged | Do not redrive; investigate if it reached the DLQ |
| Authentication or configuration error | All calls fail consistently after a deployment or credential rotation | Fix and deploy configuration first; then review DLQ |
| Poison or incompatible event | Same event fails deterministically before or during parsing | Do not bulk-redrive; fix compatibility or isolate the event |
| Lambda permission, throttle, or runtime defect | Lambda service metrics or platform logs fail independently of provider health | Restore Lambda health before redrive |
| Duplicate or stale event | Worker records `duplicate_or_stale`; no external call occurs | It should be acknowledged, not retained |

If messages in one DLQ have different failure classes, do not use bulk managed
redrive. Preserve them and design a selective recovery.

## 7. Controlled message inspection

Initial diagnosis should not receive a message. If identity cannot be proven
from logs and metrics, record an explicit incident decision before inspecting
the DLQ.

Receiving a DLQ message:

- increments its receive count;
- makes it invisible for the requested interval;
- can hide it from another responder; and
- requires preserving its receipt handle if visibility must be restored.

Never delete, edit, or republish a message during inspection. Verify:

- one expected message, not an unexpected batch;
- its domain `eventId`, `eventType`, `aggregateId`, and aggregate version;
- its correlation and causation IDs;
- the corresponding order and worker failure logs; and
- whether more than one failure class is present.

If inspection temporarily hid the verified message, set its visibility to zero
only after confirming that no other responder owns it.

## 8. Decide whether managed redrive is safe

All of these must be true:

- the source failure is understood;
- the provider and worker are healthy;
- the worker event-source mapping is enabled;
- the source Delivery Queue can absorb the replay;
- every message eligible for the task is safe to replay;
- stable idempotency keys prevent duplicate provider effects;
- no other redrive task is active; and
- the incident record names the operator, DLQ, destination, count, and maximum
  velocity.

Do not redrive merely because the DLQ is non-empty.

## 9. Start and monitor managed redrive

This section mutates AWS state. Run it only after the decision gate above.

Resolve the DLQ ARN:

```bash
worker_dlq_arn="$(
  aws sqs get-queue-attributes \
    --queue-url "$worker_dlq_url" \
    --attribute-names QueueArn \
    --profile pingusportro-admin \
    --region eu-central-1 \
    --query Attributes.QueueArn \
    --output text \
    --no-cli-pager
)"
```

For a small development incident, start at one message per second:

```bash
aws sqs start-message-move-task \
  --source-arn "$worker_dlq_arn" \
  --max-number-of-messages-per-second 1 \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --output json \
  --no-cli-pager
```

Record the returned task handle without placing it in source control.

Monitor:

```bash
aws sqs list-message-move-tasks \
  --source-arn "$worker_dlq_arn" \
  --max-results 10 \
  --profile pingusportro-admin \
  --region eu-central-1 \
  --query 'Results[].{Status:Status,Moved:ApproximateNumberOfMessagesMoved,ToMove:ApproximateNumberOfMessagesToMove,Started:StartedTimestamp}' \
  --output json \
  --no-cli-pager
```

Stop and reassess if redriven messages immediately fail again. Do not start a
second redrive task to compensate for an unexplained first task.

## 10. Prove recovery

Require evidence at every affected boundary:

1. The move task reports `COMPLETED`.
2. The expected number of messages moved; it did not exceed the reviewed
   count.
3. Delivery Queue visible, in-flight, delayed, and oldest-age signals return
   toward baseline.
4. Worker DLQ visible and in-flight counts return toward baseline.
5. Worker logs show `delivery.message.processed` for the same domain event.
6. The recovered SQS message starts with a fresh receive attempt.
7. The order reaches the intended durable status and version.
8. The vendor records only the expected idempotent external effect.
9. No new application-failure pattern or Lambda throttle appears.

Keep monitoring for at least one visibility-timeout interval after the last
success. A temporarily empty source queue is not sufficient proof if failed
messages are still invisible.

## 11. Close and preserve evidence

Record:

- start, detection, mitigation, recovery, and close times;
- affected order, event, and correlation IDs;
- maximum source and DLQ backlog;
- provider and Lambda symptoms;
- redrive task result and message count;
- customer impact;
- root cause or current leading hypothesis;
- follow-up owner and due date; and
- whether code, configuration, runbook, or monitoring changed.

Never copy access tokens, webhook signatures, vendor credentials, full order
bodies, addresses, or raw unreviewed message bodies into an incident record.

## Validated example

The 2026-07-29 development exercise used:

```text
correlationId: corr.vendor429drill.1785310860841814
orderId:       ord_vendor429drill1785310860841814
```

It observed:

- three correlated vendor `429` responses;
- three worker `delivery.message.failed` records;
- approximately 90 seconds between receives;
- a worker-DLQ visible-message peak of one;
- Delivery Queue `Maximum receives: 3`;
- one SQS managed-redrive task at 100% and `Successfully completed`;
- one recovery vendor `201`;
- one worker `delivery.message.processed` with `outcome=submitted`; and
- empty queues and conditional synthetic-data cleanup afterward.

The drill procedure and complete failure-class inventory are:

- [Vendor rate-limit and worker-DLQ drill](../testing/vendor-rate-limit-dlq-drill.md)
- [Phase 7.2 failure-drill inventory](../testing/phase-7-failure-drill-inventory.md)
- [Exercise postmortem: delivery-provider rate limit and worker DLQ](postmortem-2026-07-29-vendor-rate-limit.md)
