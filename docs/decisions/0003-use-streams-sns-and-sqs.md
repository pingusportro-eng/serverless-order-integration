# 0003: Publish order events through DynamoDB Streams, SNS, and SQS

- Status: Accepted
- Date: 2026-07-21

## Context

Creating or updating an order must lead to asynchronous integration work without
making the HTTP client wait for the provider. Writing an order and publishing a
message directly from the same Lambda creates a dual-write failure: either write
can succeed while the other fails.

The project also needs to demonstrate event publication, pub/sub, durable
asynchronous processing, backpressure, retries, and dead-letter handling.

Lambda event-source mappings process DynamoDB Streams and SQS records at least
once, so duplicates are expected rather than exceptional.

Reference: [Lambda event-source mapping behavior](https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventsourcemapping.html)

## Decision

Use this standard, at-least-once event pipeline:

```text
DynamoDB committed change
  -> DynamoDB Stream
  -> Event publisher Lambda
  -> Standard SNS topic
  -> Standard SQS delivery queue
  -> Vendor worker Lambda
  -> Mock provider API
```

Responsibilities are separated as follows:

| Component | Responsibility |
| --- | --- |
| DynamoDB transaction | Commit the order state, version, and idempotency effects atomically. |
| DynamoDB Stream | Capture committed item changes so the API does not perform a database-plus-message dual write. |
| Publisher Lambda | Interpret relevant changes, construct the versioned domain event envelope, and publish it. |
| SNS topic | Fan out domain events and apply subscription filters without coupling publishers to consumers. |
| SQS delivery queue | Persist delivery work, buffer bursts, apply backpressure, and drive worker retries. |
| Worker Lambda | Deduplicate the event and call the provider with the order's stable submission key. |
| Dead-letter handling | Retain unprocessable records for investigation and controlled recovery. |

Use standard SNS and SQS rather than FIFO. Domain event IDs, aggregate versions,
conditional writes, and provider submission keys provide correctness without a
global ordering guarantee.

The DynamoDB Stream mapping and SQS mapping will enable partial batch responses.
Publisher failures that outlive the configured stream retry policy require an
on-failure SQS destination; worker messages that exceed the receive limit go to
a separate worker dead-letter queue. An SNS subscription dead-letter queue
retains messages that SNS can no longer deliver to the delivery queue. Exact
retry counts and timeouts will be reviewed with the infrastructure change.

DynamoDB Streams retains records for 24 hours, so monitoring and the publisher
failure destination are required rather than relying on indefinite retries.

Reference: [DynamoDB event-source mapping parameters](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-params.html)

## Alternatives considered

### Publish directly from the API Lambda

This is simpler but permits inconsistent outcomes when either the DynamoDB write
or message publish succeeds alone.

### Connect the DynamoDB Stream directly to the provider worker

This removes SNS and SQS but tightly couples database representation to provider
logic, offers no durable work queue after transformation, and makes future
subscribers harder to add.

### Publish directly to SQS

This is appropriate for one consumer. SNS is retained deliberately to practise
pub/sub and allow independent future consumers such as notifications or audit.
That educational benefit comes with an additional service and request hop.

### EventBridge

EventBridge offers richer routing and cross-account event-bus features, but they
are unnecessary for the small event taxonomy and single-account MVP.

### FIFO SNS and SQS

FIFO can provide ordered, deduplicated delivery but adds constraints and does not
remove the need for idempotent application behavior. The domain already detects
duplicates, stale versions, and invalid transitions.

## Consequences

### Positive

- HTTP latency is independent of provider latency.
- Committed database changes cannot be silently skipped by a failed direct
  message publish.
- Consumers scale and fail independently.
- SQS protects the provider from bursts and preserves failed work.
- New subscribers can be added without modifying the order-writing Lambda.

### Trade-offs

- Delivery is eventually consistent and at least once.
- Duplicate and out-of-order messages must be handled explicitly.
- More services create more IAM policies, metrics, failure modes, and operational
  runbooks.
- Deriving domain events from item changes requires careful filtering and schema
  versioning.
- A stream record can expire after 24 hours if failures are not detected and
  routed for recovery.

## Cost effect

Streams, Lambda, SNS, and SQS are request-based and have no idle worker instance.
At learning volume they are expected to remain within free allowances or cost
only cents. The publisher and worker failure queues add no fixed hourly cost.
The later-approved SNS subscription DLQ brings the total to three failure
queues and likewise adds no fixed hourly cost. All event fan-out, requests,
payload sizes, retries, and log volume remain part of the deployment cost
review.

## Reconsider when

Use direct SQS when there will permanently be only one consumer. Consider
EventBridge for complex routing or cross-account integration, and FIFO only when
the business requires ordering that aggregate-version checks cannot provide.
