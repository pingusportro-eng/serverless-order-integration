# Asynchronous cloud slice

Status: defined, not deployed  
Last reviewed: 2026-07-24

## Purpose

Step 5.2 extends `template.cloud.yaml` with the asynchronous path that turns
committed order mutations into domain events and delivery work:

```text
DynamoDB Stream -> Publisher Lambda -> SNS
                                      |
                                      | filtered actionable events
                                      v
                              Delivery SQS queue -> Worker Lambda -> vendor
                                      |
                                      v
                                  Worker DLQ

Failed stream record -> Publisher failure queue
```

See the editable
[full AWS cloud stack Draw.io diagram](../architecture/full-cloud-stack.drawio)
for this path in the context of the API, webhook, IAM, and logging resources.

The existing `template.yaml` remains the local HTTP SAM template. Defining,
validating, and building the cloud template creates no AWS resources.

## Resource inventory

The asynchronous addition contains:

- A `NEW_IMAGE` DynamoDB Stream on the orders table
- One 128 MB stream-publisher Lambda
- One standard SNS domain-events topic
- One standard SQS delivery queue
- One standard SQS worker DLQ
- One standard SQS stream-publisher failure queue
- One 128 MB delivery-worker Lambda
- Two CloudWatch log groups using the stack's reviewed retention parameter
- Lambda event-source mappings for DynamoDB Streams and SQS
- An SNS-to-SQS subscription and queue resource policy

There is no FIFO messaging, provisioned polling, EventBridge, VPC, NAT Gateway,
provisioned concurrency, or customer-managed KMS key.

## Routing and message shape

The publisher sends the domain-event JSON as the SNS message and adds
`eventType`, `schemaVersion`, and `aggregateId` message attributes. SNS remains
the fan-out point for every event type.

The delivery subscription filters on the `eventType` message attribute and
accepts only:

- `order.created`
- `order.submission_retry_requested`

Raw message delivery makes the domain-event JSON the SQS body, matching the
worker's validated input contract. Events such as `order.submitted`,
`order.submission_failed`, and `order.delivered` are published to SNS but do not
enter the delivery queue unless a future subscriber explicitly requests them.

The stream event-source mapping filters out non-order table items before
invoking the publisher. The publisher still validates every received order
record instead of trusting infrastructure filtering as a data boundary.

## Failure and retry paths

The publisher and worker both enable `ReportBatchItemFailures`.

For DynamoDB Streams:

- The publisher processes records in stream order and stops at the first failed
  record so later records from that batch are not checkpointed ahead of it.
- A thrown whole-batch failure may be bisected to isolate the bad record.
- Retry count and maximum record age are bounded by required parameters.
- A record that exhausts either bound is sent to the publisher failure queue.

For delivery SQS:

- The worker processes its small batch sequentially and reports only failed
  message IDs.
- Successful messages are removed while failed messages become visible again
  after the queue visibility timeout.
- The queue's `maxReceiveCount` bounds attempts before moving a message to the
  separate worker DLQ.
- Event-source maximum concurrency protects both the vendor and Lambda spend
  from an unbounded burst.

The failure queues retain data for investigation; they do not automatically
replay it.

## IAM and transport boundaries

| Function | Allowed actions |
| --- | --- |
| Stream publisher | Read the orders stream, list DynamoDB streams, publish only to the domain-events topic, and send discarded records only to its failure queue |
| Delivery worker | Receive/delete messages only from the delivery queue, get orders from the table, and transact delivery outcomes to the table |

The delivery queue policy permits `sqs:SendMessage` only from the stack's SNS
topic and account. Lambda functions are not placed in a VPC, so the worker can
reach a reviewed public HTTPS vendor without a NAT Gateway.

All three SQS queues use SQS-managed server-side encryption. The SNS topic does
not use KMS encryption in this disposable synthetic-data environment; adding
SNS KMS encryption would require a separate cost and IAM review. Domain events
must continue to exclude secrets and personal data.

`VendorAuthToken` is a required `NoEcho` CloudFormation parameter and is exposed
to the worker as an encrypted-at-rest Lambda environment variable. It is not
written to logs or outputs. A production system would normally use a dedicated
secret store and rotation workflow, which is outside this cost-limited slice.

## Values deliberately deferred to the cost review

The asynchronous template requires these values and provides no defaults:

| Parameter | Decision deferred to step 5.3 |
| --- | --- |
| `StreamPublisherBatchSize` | Maximum stream records per publisher invocation |
| `StreamPublisherMaximumRetryAttempts` | Retries before sending a failed stream record to SQS |
| `StreamPublisherMaximumRecordAgeSeconds` | Age limit before sending a failed stream record to SQS |
| `DeliveryWorkerBatchSize` | Sequential provider submissions per worker invocation |
| `DeliveryWorkerMaximumConcurrency` | Maximum concurrent vendor-calling workers |
| `DeliveryWorkerTimeoutSeconds` | Maximum duration of one worker invocation |
| `DeliveryQueueVisibilityTimeoutSeconds` | Delay before a failed delivery message can retry |
| `DeliveryQueueMaxReceiveCount` | Attempts before the worker DLQ |
| `DeliveryMessageRetentionSeconds` | Retention for pending delivery work |
| `FailureMessageRetentionSeconds` | Retention for both failure queues |
| `VendorTimeoutMs` | Maximum duration of one provider HTTP attempt |

The cost review must enforce these relationships:

1. Queue visibility must be at least six times the worker timeout.
2. The vendor timeout must leave enough Lambda time for DynamoDB reads, writes,
   serialization, and failure reporting.
3. Worker batch size multiplied by the vendor timeout must fit comfortably
   inside the worker timeout because records are processed sequentially.

`VendorBaseUrl` and `VendorAuthToken` are also required deployment inputs. The
current local mock vendor is not reachable from AWS Lambda. Before deployment,
we must explicitly select a temporary public HTTPS mock endpoint or define a
separate cloud-hosted mock and review its cost.

## Local verification

```bash
npm run sam:cloud:validate
npm run sam:cloud:build
npm run test:stream-publisher
npm run test:delivery-worker
```

These commands validate infrastructure and the saved AWS event fixtures
locally. They do not create an AWS stack or send messages through AWS.
