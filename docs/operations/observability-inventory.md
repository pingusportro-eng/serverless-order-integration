# Observability inventory

Status: current signals inventoried; successful asynchronous trace gap identified

Reviewed: 2026-07-28

AWS account: `454921778743`  
Region: `eu-central-1`  
Application stack: `serverless-order-integration-dev`

## Cost boundary

This inventory is based on the source, deployable template, automated tests, and
previous cloud-test evidence. It did not deploy resources or query AWS, so its
AWS cost is `$0`.

The current stack uses only application logs, API access logs, and the standard
metrics emitted by the selected AWS services. It does not create custom
CloudWatch metrics, alarms, dashboards, X-Ray traces, synthetic canaries, or a
third-party observability service.

Adding any of those resources, increasing log retention, or generating another
cloud workload requires a separate cost review.

## Identifier semantics

The system has several identifiers with different jobs:

| Identifier | Meaning | Created by |
| --- | --- | --- |
| API request ID | One HTTP request | API Gateway, with a local fallback |
| Correlation ID | One business journey or related chain of work | Calling client, or the initiating request ID when absent |
| Causation ID | The request or event that directly caused a mutation | The HTTP request ID, domain event ID, or provider event ID |
| Domain event ID | One immutable domain event; stable across publisher retries | Stream publisher |
| Order ID | The aggregate shared by all changes to one order | Orders application |
| Stream sequence number | One record's position within a DynamoDB Stream shard | DynamoDB Streams |
| SQS message ID | One SQS message delivery identity | SQS |
| Provider event ID | One webhook event, used for durable deduplication | Delivery provider |

The logger currently places API request IDs, stream sequence numbers, and SQS
message IDs in the same field named `requestId`. That makes every failure
searchable, but the name is less precise for non-HTTP records.

## Current signal map

| Boundary | Preserved context | Existing logs and metrics | Gap |
| --- | --- | --- | --- |
| API Gateway | API request ID and route | JSON access record with route, status, latency, response length, and integration status; standard API metrics | Access record has no business correlation or order ID |
| Orders API Lambda | API request ID; optional incoming correlation ID | Safe JSON start, completion, and unexpected-failure records; standard Lambda metrics | When the caller omits `X-Correlation-Id`, the mutation falls back to the request ID but the log does not show that fallback correlation; successful response log has no order ID |
| DynamoDB order item | Correlation and causation metadata are stored with the latest order mutation | Stream records preserve the committed mutation; standard DynamoDB metrics | The item is durable evidence, not an operational log timeline |
| Stream publisher | Deterministic event ID, order ID, version, correlation ID, and causation ID in the domain-event envelope | Safe structured failure record keyed by stream sequence number; stream retry and failure-queue signals; standard Lambda metrics | No success or ignored-record log; failure log omits correlation ID and aggregate version |
| SNS and delivery SQS | Full domain-event envelope; SNS attributes include event type, schema version, and aggregate ID | Standard SNS/SQS delivery, backlog, age, and failure signals | No application-level publication or receipt success record |
| Delivery worker | SQS message ID plus parsed domain-event context | Safe structured failure record with event ID and order ID; SQS retry and DLQ state; standard Lambda metrics | No processing-start or success record; failure record omits correlation ID, event type, version, and attempt count |
| Vendor request | Correlation ID and stable submission idempotency key | Local mock-vendor attempt journal records correlation ID, key digest, scenario, and status | The deployed Lambda does not log a safe vendor-attempt outcome or duration |
| Vendor webhook | API request ID; optional provider correlation ID; durable provider event ID | Safe JSON start, completion, and unexpected-failure records; API access record; standard Lambda metrics | Lambda log ignores the incoming correlation ID and validated provider event ID; a provider that omits correlation starts a new correlation branch |
| Webhook transaction | Provider event ID becomes causation; webhook correlation is stored on the order mutation | Durable deduplication item and committed order version | The successful application outcome (`applied`, `duplicate`, or `stale`) is not logged |

All application log fields pass through an explicit allow-list. Authorization
headers, secrets, request bodies, addresses, exception messages, and raw vendor
responses are deliberately excluded.

## One-order context journey

The code preserves the following context for a created order:

```text
POST /orders
  requestId = API Gateway request ID
  correlationId = X-Correlation-Id, otherwise requestId
  causationId = requestId
        |
        v
DynamoDB ORDER mutation
  correlationId + causationId
        |
        v
DynamoDB Stream -> publisher
  deterministic eventId
  aggregateId = orderId
  aggregateVersion = 1
  same correlationId + causationId
        |
        v
SNS -> SQS -> delivery worker
  complete domain-event envelope
        |
        v
POST delivery vendor
  X-Correlation-Id = event correlationId
  Idempotency-Key = submissionKey
        |
        v
DynamoDB SUBMITTED mutation
  same correlationId
  causationId = consumed eventId
```

A provider webhook creates another mutation whose causation ID is the provider
event ID. It remains in the original correlation chain only if the provider
returns the original `X-Correlation-Id`; otherwise the webhook request ID starts
a new correlation chain and the order ID is the join key.

The Phase 5 cloud test proved the real service journey and exposed an API
Gateway request-ID compatibility defect. The terminal retry and vendor
rate-limit drills also proved stable correlation through retries. However,
current successful-path logs do not contain enough entries to reconstruct the
whole journey with one CloudWatch Logs query. Phase 7.1 is therefore not yet
complete.

## Prioritized gaps

The next cost-free implementation should:

1. put the effective correlation ID in every Orders API log, including the
   request-ID fallback;
2. add safe success records to the publisher and delivery worker;
3. include correlation ID, event type, aggregate version, and processing
   outcome where they are already known;
4. include webhook correlation, provider event ID, order ID, and application
   outcome after signature and payload validation; and
5. add tests proving both trace continuity and exclusion of sensitive fields.

This requires application-code and test changes only. It does not require
custom metrics, tracing, longer retention, or an AWS deployment.

After those signals exist, add a small CloudWatch Logs Insights query cookbook
and prove locally that one correlation ID reconstructs the successful
API-to-vendor path. Cloud verification, alarms, and dashboards remain separate
cost-reviewed decisions.
