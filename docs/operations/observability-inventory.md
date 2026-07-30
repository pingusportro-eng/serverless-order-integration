# Observability inventory

Status: safe successful-path signals and query cookbook complete locally

Reviewed: 2026-07-28

AWS account: `454921778743`  
Region: `eu-central-1`  
Application stack: `serverless-order-integration-dev`

## Cost boundary

This inventory and the first logging improvement are based on the source,
deployable template, automated tests, and previous cloud-test evidence. They did
not deploy resources or query AWS, so their AWS cost is `$0`.

The current stack uses only application logs, API access logs, and the standard
metrics emitted by the selected AWS services. It does not create custom
CloudWatch metrics, alarms, dashboards, X-Ray traces, synthetic canaries, or a
third-party observability service.

Adding any of those resources, increasing log retention, or generating another
cloud workload requires a separate cost review.

The improvement adds one success log for each published domain event and one
for each processed delivery message. If deployed later, those extra records
will add a small amount of variable CloudWatch Logs ingestion. No deployment is
authorized by this review; the added volume must be included in the next
deployment cost check.

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
| Orders API Lambda | API request ID and effective correlation ID, including request-ID fallback | Safe JSON start, completion, and unexpected-failure records; standard Lambda metrics | Successful response log has no order ID |
| DynamoDB order item | Correlation and causation metadata are stored with the latest order mutation | Stream records preserve the committed mutation; standard DynamoDB metrics | The item is durable evidence, not an operational log timeline |
| Stream publisher | Deterministic event ID, order ID, version, correlation ID, and causation ID in the domain-event envelope | Safe structured publication-success and failure records keyed by stream sequence number; stream retry and failure-queue signals; standard Lambda metrics | Ignored transaction-support records are intentionally not logged |
| SNS and delivery SQS | Full domain-event envelope; SNS attributes include event type, schema version, and aggregate ID | Standard SNS/SQS delivery, backlog, age, and failure signals | No application-level publication or receipt success record |
| Delivery worker | SQS message ID plus parsed domain-event context | Safe structured processing-success and failure records with correlation, event, order, version, outcome, and receive attempt; SQS retry and DLQ state; standard Lambda metrics | No separate processing-start record, avoiding an extra log for every attempt |
| Vendor request | Correlation ID and stable submission idempotency key | Local mock-vendor attempt journal records correlation ID, key digest, scenario, and status | The deployed Lambda does not log a safe vendor-attempt outcome or duration |
| Vendor webhook | API request ID; effective provider correlation or request-ID fallback; durable provider event ID | Safe JSON start, completion, and unexpected-failure records; completed records include provider event, order, version, and outcome; API access record; standard Lambda metrics | A provider that omits the original order correlation starts a new correlation branch |
| Webhook transaction | Provider event ID becomes causation; webhook correlation is stored on the order mutation | Durable deduplication item, committed order version, and safe `applied`, `duplicate`, or `stale` completion outcome | No remaining application-outcome gap |

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
  Idempotency-Key = deliveryProviderSubmissionKey
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
rate-limit drills also proved stable correlation through retries.

The local `successful trace continuity` test now proves that one correlation ID
selects the successful Orders API, stream publication, and delivery processing
records while preserving event, order, version, outcome, and receive-attempt
context. Component tests also prove webhook correlation fallback and safe
outcome logging. The operator query cookbook now covers those successful
signals and the main failure pivots. Its text-prefix parsing is validated
against representative records locally.

## Implemented local improvement

The first cost-free implementation:

1. puts the effective correlation ID in every Orders API log, including the
   request-ID fallback;
2. adds safe success records to the publisher and delivery worker;
3. includes correlation ID, event type, aggregate version, and processing
   outcome where they are already known;
4. includes webhook correlation, provider event ID, order ID, and application
   outcome after signature and payload validation; and
5. adds tests proving both trace continuity and exclusion of sensitive fields.

No request body, address, signing secret, authorization value, raw provider
response, or free-form exception message was added to the log contract.

## Query cookbook

The
[CloudWatch Logs Insights query cookbook](cloudwatch-query-cookbook.md)
documents:

- one correlation journey;
- one order across correlation branches;
- one event or failed queue message;
- retry attempts and the separate terminal-DLQ check; and
- HTTP or Lambda failures by safe exception class.

Its parsing assumptions are covered by local fixtures and tests. Running the
queries against CloudWatch, changing the functions to Lambda-native JSON log
format, or adding alarms, dashboards, and tracing remain separate cost-reviewed
decisions.
