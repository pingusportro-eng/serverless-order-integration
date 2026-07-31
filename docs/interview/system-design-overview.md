# Short system-design interview walkthrough

## Purpose

Use this guide to explain the project in approximately two to three minutes.
Learn the sequence and reasoning rather than memorizing every sentence. Pause
when the interviewer shows interest and let their questions choose the deeper
topic.

## Thirty-second opening

> I built a serverless order-integration system for a commerce platform. It
> accepts orders through a REST API, stores them durably, submits them
> asynchronously to a delivery provider, and reconciles signed provider
> webhooks. The central design problem was making an unreliable external
> dependency safe: the provider can be slow, unavailable, rate-limited, and
> duplicate requests or callbacks. I used TypeScript on Lambda, API Gateway,
> DynamoDB, DynamoDB Streams, SNS, and SQS, with idempotency, optimistic
> concurrency, bounded retries, dead-letter queues, and correlated structured
> logs.

## Two-to-three-minute explanation

> The synchronous path starts at an API Gateway HTTP API. Cognito validates
> access tokens, and operator-only status changes also require an operators
> group. The Orders Lambda validates the request and uses a DynamoDB transaction
> to persist the order and its idempotency records. A repeated request with the
> same idempotency key and payload returns the same logical order; conflicting
> reuse is rejected. The API can then respond without waiting for the delivery
> provider.
>
> I deliberately avoided writing to DynamoDB and publishing a message directly
> from the API Lambda because that creates a dual-write failure. Instead,
> DynamoDB Streams captures committed order changes. A publisher Lambda converts
> relevant records into versioned domain events and publishes them to SNS. SNS
> gives a fan-out point and filters actionable event types into a Standard SQS
> delivery queue.
>
> The delivery worker consumes small SQS batches with bounded concurrency so it
> cannot overwhelm the provider. It assumes at-least-once delivery, checks event
> and aggregate versions, and calls the provider with a stable idempotency key
> and a short HTTP timeout. Retryable failures are reported through partial-batch
> failures, so SQS retries them after the visibility timeout. After the
> configured receive limit, SQS moves a poison message to a worker DLQ for
> investigation and controlled redrive.
>
> Provider status updates return through a public webhook route. That route
> verifies an HMAC over the timestamp and raw body using constant-time
> comparison, enforces a five-minute replay window, and records the provider
> event ID transactionally so duplicate callbacks do not repeat a state change.
> Conditional writes and aggregate versions prevent stale or concurrent updates
> from corrupting the order.
>
> Operationally, correlation IDs cross the HTTP and asynchronous boundaries,
> structured CloudWatch logs avoid sensitive payloads, and separate failure
> queues retain stream, SNS-delivery, and worker failures. I exercised a real
> provider-429 journey through retries, the DLQ, managed redrive, and recovery.
> Infrastructure is SAM and CloudFormation. GitHub Actions uses short-lived OIDC
> credentials and exact reviewed change sets rather than stored AWS access keys.
> The normal development loop is local, while short-lived AWS labs validate real
> IAM and managed-service behavior and then verify teardown.

## Whiteboard sequence

Draw the main flow from left to right:

```text
Client
  -> API Gateway
  -> Orders Lambda
  -> DynamoDB
  -> DynamoDB Stream
  -> Publisher Lambda
  -> SNS
  -> SQS
  -> Delivery Worker
  -> Delivery Provider

Delivery Provider
  -> signed webhook
  -> API Gateway
  -> Webhook Lambda
  -> DynamoDB
```

Then add these protections next to the relevant boundary:

1. `Idempotency-Key` beside order creation.
2. `transaction + conditional version` beside DynamoDB.
3. `versioned event + partial batch failure` beside the publisher.
4. `visibility timeout + max receives + DLQ` beside SQS.
5. `stable provider key + HTTP timeout` beside the vendor call.
6. `HMAC + replay window + event deduplication` beside the webhook.
7. `correlationId` across the whole drawing.

## Five decisions to defend

| Decision | Short reason |
| --- | --- |
| API Gateway HTTP API and Lambda | Scale-to-zero REST boundary with managed JWT validation and no idle server |
| DynamoDB on-demand | Fits known key-based access patterns and irregular learning traffic without an always-running database |
| DynamoDB Stream after the write | Avoids an API database-plus-message dual write |
| SNS before SQS | Separates publication from consumers, supports filtering, and leaves a fan-out point |
| Standard messaging with application idempotency | The domain already needs duplicate and stale-version protection; global FIFO ordering is unnecessary |

## One credible alternative

If the system were guaranteed to have only one asynchronous consumer, the
publisher could send directly from the DynamoDB Stream to SQS and remove SNS.
That would reduce one service hop, one subscription, IAM permissions, and a
failure boundary.

SNS is justified here because the project explicitly explores pub/sub and
allows future audit or notification subscribers without changing the order
writer. Publishing directly from the Orders Lambda would be simpler still, but
is not equivalent: it reintroduces the database/message dual-write failure.

## Honest boundaries

Do not claim:

- exactly-once delivery—Streams, SNS, SQS, Lambda mappings, and webhooks are
  handled as at least once;
- global message ordering—Standard messaging and independent stream shards do
  not provide it;
- that AWS Budgets stop spending—they alert and act as a local deployment gate;
- that local SAM proves AWS behavior—it cannot prove IAM, Cognito, service
  retries, quotas, or event-source wiring; or
- that this is production ready—it has one merchant, one mock provider, one
  Region, short retention, no backups or disaster recovery, and no automated
  paging.

Those limits are deliberate learning-scope choices. In a real design, traffic,
availability, recovery, retention, tenancy, compliance, and provider-contract
requirements would be collected before selecting production limits.

## Rehearsal checklist

A successful short explanation should answer:

- What business problem does the system solve?
- Why is provider submission asynchronous?
- How is the API/database/message dual write avoided?
- Where are duplicate requests and events made safe?
- What happens when the provider returns `429` or remains unavailable?
- How is a webhook authenticated and deduplicated?
- How can an operator trace and recover one failed order?
- How are cloud access and cost bounded?
- What important limitation and alternative would you discuss?

Source material:

- [Final architecture and project guide](../../README.md)
- [Synchronous API and data-integrity walkthrough](synchronous-api-and-data-integrity.md)
- [Asynchronous event journey and failure handling](asynchronous-event-journey-and-failures.md)
- [Architecture decision records](../decisions/README.md)
- [Failure-drill inventory](../testing/phase-7-failure-drill-inventory.md)
- [Incident runbook](../operations/delivery-worker-incident-runbook.md)
