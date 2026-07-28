# CloudWatch Logs Insights query cookbook

Status: queries defined and record parsing validated locally

Reviewed: 2026-07-28

AWS account: `454921778743`  
Region: `eu-central-1`  
Application stack: `serverless-order-integration-dev`

## Cost and safety boundary

Creating this cookbook and validating representative records locally costs
`$0`. None of these queries was run in AWS.

CloudWatch Logs Insights charges for the uncompressed log data scanned. Before
running a query:

1. select only the log groups named for that query;
2. begin with the narrowest useful time range, normally 5–15 minutes;
3. keep the result limit at 200 or lower;
4. widen the time range only when the first query has no result; and
5. cancel an unnecessary running query instead of closing the browser tab.

The development stack retains logs for only one day. An older incident cannot
be reconstructed from CloudWatch after that boundary.

## Log groups

| Signal | Log group |
| --- | --- |
| API Gateway access | `/aws/serverless-order-integration/serverless-order-integration-dev/api-access` |
| Orders API | `/aws/serverless-order-integration/serverless-order-integration-dev/orders-api` |
| Stream publisher | `/aws/serverless-order-integration/serverless-order-integration-dev/stream-publisher` |
| Delivery worker | `/aws/serverless-order-integration/serverless-order-integration-dev/delivery-worker` |
| Vendor webhook | `/aws/serverless-order-integration/serverless-order-integration-dev/vendor-webhook` |

The application Lambda functions currently use `LogFormat: Text`. Lambda
therefore prefixes the JSON emitted by the safe logger with platform timestamp,
invocation request ID, and level fields. Every application query first extracts
the final JSON object and converts it to a map:

```text
parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
```

Platform `START`, `END`, and `REPORT` records do not match the application
filters and are ignored.

API Gateway access records are already JSON. CloudWatch can discover their
top-level fields directly, so the access-log queries do not use the Lambda
parser.

## Trace one correlation journey

Select the four application Lambda log groups, use a narrow time range, and
replace `<correlation-id>`.

```text
fields @timestamp, @log, @logStream, @message
| parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
| filter record.correlationId = "<correlation-id>"
| fields @timestamp, @log, record.level, record.event, record.requestId, record.correlationId, record.orderId, record.eventId, record.eventType, record.aggregateVersion, record.orderVersion, record.outcome, record.attempt, record.exceptionName
| sort @timestamp asc
| limit 200
```

Expected successful creation path:

```text
http.request.started
http.request.completed
stream.event.published
delivery.message.processed
stream.event.published
```

The final publication is normally `order.submitted`; SNS filters it out of the
delivery queue, so there should be no second worker success for that event.

## Trace one order across correlation branches

Use this when the delivery provider did not return the original correlation ID
on its webhook. Select the publisher, worker, and webhook log groups and replace
`<order-id>`.

```text
fields @timestamp, @log, @logStream, @message
| parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
| filter record.orderId = "<order-id>"
| fields @timestamp, @log, record.level, record.event, record.requestId, record.correlationId, record.eventId, record.eventType, record.aggregateVersion, record.orderVersion, record.outcome, record.attempt, record.exceptionName
| sort @timestamp asc
| limit 200
```

The Orders API completion record does not yet carry an order ID. Begin with the
order query, copy a returned correlation ID, and then run the correlation query
to recover the initiating HTTP records.

## Find one domain event or failed source record

Select the publisher and worker log groups. Replace either placeholder with the
known domain event ID, DynamoDB Stream sequence number, or SQS message ID.

```text
fields @timestamp, @log, @logStream, @message
| parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
| filter record.eventId = "<event-id>" or record.requestId = "<stream-sequence-or-sqs-message-id>"
| fields @timestamp, @log, record.level, record.event, record.requestId, record.correlationId, record.orderId, record.eventId, record.eventType, record.aggregateVersion, record.orderVersion, record.outcome, record.attempt, record.exceptionName
| sort @timestamp asc
| limit 100
```

For a malformed stream record, no domain event exists yet. Search with the
sequence number stored in the publisher failure-queue message. For a worker DLQ
message, search with its SQS message ID or parse its body to obtain the domain
event ID.

## Inspect delivery retries

Select only the delivery-worker log group and replace `<order-id>`.

```text
fields @timestamp, @logStream, @message
| parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
| filter record.orderId = "<order-id>" and record.event in ["delivery.message.processed", "delivery.message.failed"]
| fields @timestamp, record.level, record.event, record.requestId, record.correlationId, record.eventId, record.aggregateVersion, record.orderVersion, record.outcome, record.attempt, record.exceptionName
| sort @timestamp asc
| limit 100
```

`attempt` is the SQS `ApproximateReceiveCount` observed by that Lambda
invocation. Repeated failures should retain the same correlation, event, order,
and provider idempotency context while the attempt increases.

The log proves processing attempts; it does not prove the current queue state.
Confirm terminal retention from the worker DLQ's standard visible-message and
oldest-message signals, or by a bounded read-only queue inspection.

## Summarize safe application failures

Select only the application log groups and use a short incident window.

```text
fields @timestamp, @log, @message
| parse @message /(?<applicationJson>\{.*\})\s*$/
| fields jsonParse(applicationJson) as record
| filter record.level = "error"
| stats count(*) as failures by record.event, record.exceptionName
| sort failures desc
| limit 50
```

This groups only allow-listed exception classes. Exception messages, request
bodies, tokens, addresses, and raw vendor responses are intentionally absent.

After identifying a failure class, return to the correlation, order, event, or
source-record query for the individual journey.

## Inspect API access failures

Select only the API access log group.

```text
fields @timestamp, requestId, routeKey, status, responseLatency, responseLength, integrationStatus
| filter status like /^[45]/
| sort @timestamp desc
| limit 100
```

To connect one API access record to its Lambda application logs, replace
`<api-request-id>` and then search the appropriate Lambda group for the same
application `requestId`.

```text
fields @timestamp, requestId, routeKey, status, responseLatency, integrationStatus
| filter requestId = "<api-request-id>"
| sort @timestamp asc
| limit 20
```

## Local validation boundary

The automated observability test uses representative records for:

- Lambda text-format prefixes followed by the safe JSON application record;
- Lambda platform records with no application JSON;
- API Gateway JSON access records;
- correlation selection across successful components;
- order selection across different correlation branches; and
- failure selection by safe exception class.

This validates the deployed record assumptions and the regular-expression
extraction locally. It cannot execute or type-check the managed CloudWatch Logs
Insights language. The query syntax follows the AWS documentation for
[`parse`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-Parse.html),
[`jsonParse` and structure access](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html),
[discovered Lambda and JSON fields](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData-discoverable-fields.html),
and [Lambda text/JSON formats](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-logformat.html).

Actually running a query and validating its managed-service result remains a
separate cost-reviewed cloud operation.
