# Stripe cloud acceptance review

Status: ready for owner review; live deployment is not yet authorized

Last reviewed: 2026-08-28

Deployment region: `eu-central-1` (Europe, Frankfurt)  
Required AWS CLI profile: `pingusportro-admin`  
Expected AWS account: `454921778743`  
Application stack: `serverless-order-integration-dev`

## Purpose and approval boundary

This review defines one short-lived AWS and Stripe Sandbox acceptance exercise
for the payment extension. It updates the original
[pre-deployment cost review](pre-deployment-cost-review.md) with the resources
and traffic introduced by Stripe, Cognito PKCE, and the React cloud lab.

Creating this document does **not** authorize a deployment. Before running
`npm run cloud:deploy`, the owner must separately approve:

1. the exact resource and configuration inventory below;
2. the one-order workload and stop conditions;
3. the conservative `< $0.05` exercise bound; and
4. the live AWS and Stripe Sandbox exercise itself.

The account's `$5` project ceiling and existing AWS Budget remain safeguards,
not hard spending limits. This exercise must not include load testing, failure
campaigns, DLQ drills, or extra payment scenarios.

## Changes since the original review

The payment extension changes the reviewed application inventory as follows:

| Area | Original review | Stripe acceptance stack |
| --- | ---: | ---: |
| Lambda functions | 4 | 5 |
| Lambda log groups | 4 | 5 |
| Total explicit log groups | 5 | 6 |
| Application routes | 5 | 7 |
| Standard SSM parameters used by the lab | 0 | 2 |
| Cognito hosted authorization | Not exercised by the UI | Authorization Code + PKCE through the managed domain |
| Browser application | None | One local React/Vite process on `127.0.0.1:3002` |

The fifth Lambda and sixth log group belong to the Stripe webhook. The two new
routes are payment-intent preparation and the Stripe webhook.

## Exact resource inventory

### Resources with usage-based cost

| Service | Reviewed resources | Charging dimension |
| --- | --- | --- |
| API Gateway | One regional HTTP API, one `$default` stage, and seven application routes | Requests and internet data transfer |
| Lambda | Five 128 MB functions: orders API, vendor webhook, Stripe webhook, stream publisher, and delivery worker | Invocations and GB-seconds |
| DynamoDB | One Standard on-demand table, two sparse GSIs, and one `NEW_IMAGE` Stream | Reads, writes, indexed storage, and table storage |
| SNS | One Standard topic and one filtered SQS subscription | Publish requests and deliveries |
| SQS | Delivery queue, delivery-worker DLQ, publisher failure queue, and SNS subscription DLQ | API requests and payload chunks, including empty event-source-mapping polls |
| Cognito | One Lite user pool, public app client, operators group, and managed-login domain | Monthly active users |
| CloudWatch Logs | API access log group and five Lambda log groups, all retained for one day | Ingestion, retained storage, and query scanning |
| SSM Parameter Store | One retained Stripe Sandbox API key and one temporary webhook signing secret, both Standard `SecureString` parameters | Standard parameters and standard-throughput interactions have no additional Parameter Store charge |
| S3 deployment artifacts | One small retained SAM packaging bucket containing zipped Lambda artifacts | Storage and deployment requests |

CloudFormation, IAM resources, Lambda permissions, event-source mappings, the
SQS resource policy, the SNS subscription, Cognito's prefix domain, and
CloudWatch service metrics have no separate fixed-hourly charge in this design.
Lambda-triggered `GetRecords` calls against DynamoDB Streams are not billed.

### Non-AWS dependencies

- Stripe uses Sandbox API keys and a temporary Sandbox webhook endpoint. The
  exercise creates one synthetic PaymentIntent; Sandbox transactions do not
  move funds.
- The React UI, mock delivery vendor, and cloud-lab supervisor run on the local
  machine.
- The mock vendor is exposed through the existing learning-only HTTPS tunnel.
  It is stopped during teardown.

Only synthetic data and Stripe test-card values may be used. No real card,
customer, address, email, or production data is permitted.

### Explicitly absent

The payment extension still contains no VPC, NAT Gateway, VPC endpoint, Elastic
IP, load balancer, API cache, custom domain, WAF, provisioned concurrency,
provisioned DynamoDB capacity, DAX, point-in-time recovery, global table,
EventBridge resource, customer-managed KMS key, Secrets Manager secret,
advanced SSM parameter, custom metric, alarm, dashboard, tracing, canary, or
continuously running compute resource.

## Reviewed deployment controls

The deployment workflow supplies these bounded values. This review proposes no
configuration change:

| Control | Value |
| --- | ---: |
| Log retention | 1 day |
| API burst / sustained rate | 2 / 1 request per second |
| DynamoDB maximum on-demand reads / writes | 10 / 10 request units per second |
| Stream publisher batch / retry / maximum age | 10 / 2 / 3,600 seconds |
| Delivery worker batch / maximum concurrency | 2 / 2 |
| Delivery worker / provider HTTP timeout | 15 seconds / 3 seconds |
| Delivery visibility timeout / maximum receives | 90 seconds / 3 |
| Delivery and failure-message retention | 86,400 seconds |
| Stripe HTTP timeout | 5 seconds |
| Stripe webhook signature tolerance | 300 seconds |

The UI performs at most 30 `GET /orders/{orderId}` tracking attempts at
one-second intervals. This client bound sits behind the API throttle; it does
not replace the server-side cost controls.

## Bounded acceptance workload

The entire exercise is limited to:

- one temporary Cognito operator and one browser sign-in;
- one synthetic order;
- one Stripe Sandbox PaymentIntent and one successful test-card confirmation;
- one normal mock-vendor delivery through `DELIVERED`;
- at most 50 HTTP API requests, including polling and webhooks;
- at most 150 Lambda invocations;
- at most 150 SNS publishes and deliveries;
- at most 2,000 SQS API requests, including empty long polls;
- at most 2,000 DynamoDB read request units and 2,000 write request units;
- at most 10 MB of CloudWatch log ingestion and query scanning;
- at most 50 MB of retained S3 deployment artifacts; and
- one temporary Stripe webhook endpoint, deleted during teardown.

The successful card path is sufficient here. Declines, 3D Secure, duplicate
events, webhook outage, reconciliation, and all three failure queues were
already exercised locally or in their separately reviewed drills.

## Conservative cost bound

This estimate does not depend on the SQS Free Tier being available. That is
important because unrelated account workloads may already have consumed some
or all of the monthly request allowance.

| Component | Conservative calculation | Bound |
| --- | --- | ---: |
| API Gateway HTTP API | 50 small requests | `< $0.0001` |
| Lambda requests | 150 requests | `< $0.0001` |
| Lambda duration | All 150 pessimistically use 15 seconds at 128 MB | `< $0.0047` |
| DynamoDB | 2,000 reads plus 2,000 writes at the previously reviewed regional rates | `< $0.0020` |
| SNS | 150 small Standard operations | `< $0.0002` |
| SQS | 2,000 Standard requests at `$0.40 / million`, without a free allowance | `< $0.0008` |
| Cognito Lite | One direct-sign-in MAU, conservatively priced without relying on its current free allowance | `< $0.0055` |
| Standard SSM parameters | Standard tier and standard throughput | `$0.0000` |
| CloudWatch Logs | At most 10 MB ingestion/query plus one-day retention | `< $0.0065` |
| S3 artifacts | At most 50 MB for one month plus a few requests | `< $0.0030` |
| Data transfer, managed-key requests, and rounding margin | Synthetic small payloads only | `< $0.0050` |

**Conservative exercise total: less than `$0.05`.**

The estimate excludes unrelated account usage, taxes, and traffic outside this
bounded exercise. Cognito currently documents a direct-sign-in free allowance
for Lite pools, and Parameter Store documents no additional charge for Standard
parameters at standard throughput, but the bound deliberately retains margin.

Official references checked on 2026-08-28:

- <https://aws.amazon.com/api-gateway/pricing/>
- <https://aws.amazon.com/lambda/pricing/>
- <https://aws.amazon.com/dynamodb/pricing/on-demand/>
- <https://aws.amazon.com/sns/pricing/>
- <https://aws.amazon.com/sqs/pricing/>
- <https://aws.amazon.com/cognito/pricing/>
- <https://aws.amazon.com/systems-manager/pricing/>
- <https://aws.amazon.com/cloudwatch/pricing/>
- <https://aws.amazon.com/s3/pricing/>
- <https://docs.stripe.com/testing>

## Acceptance procedure and evidence

### 1. Preflight and deployment

1. Confirm the reviewed commit is pushed and ordinary checks are green.
2. Run `npm run cloud:status`; reconcile any earlier owned lab state first.
3. Run `npm run cloud:deploy` only after explicit live approval.
4. Wait for `PAYMENT LAB READY`. Record the API URL, UI URL, stack name, Stripe
   endpoint ID, and Git commit from the supervisor output/state.

### 2. Prove Cognito Authorization Code + PKCE

Open the local UI and sign in with the temporary operator. In browser Network
tools, retain evidence that:

- the authorization request uses `response_type=code`, the reviewed callback,
  a `code_challenge`, and `code_challenge_method=S256`;
- the callback contains an authorization code rather than tokens in its URL;
- the browser exchanges the code at Cognito's token endpoint; and
- the successful API calls contain a bearer access token.

Do not record the password, authorization code, verifier, token, Stripe client
secret, or any signing secret.

### 3. Run exactly one happy path

1. Create one synthetic order in the UI.
2. Prepare its one PaymentIntent.
3. Confirm it with Stripe's successful test card.
4. Let the bounded tracker read the stored order until `DELIVERED`.
5. Record only safe evidence: order ID, PaymentIntent ID, Stripe event ID,
   create-order correlation ID, Stripe-webhook request/correlation ID, domain
   event IDs, statuses, versions, timestamps, and HTTP status codes.

The trace has two intentional roots:

- the create-order correlation ID proves request acceptance and the initial
  `order.created` publication;
- the Stripe webhook request ID becomes the correlation ID of the
  `order.ready_for_submission` mutation and its downstream delivery journey.

The order ID joins those roots. Do not claim that the browser's create-order
correlation ID crosses Stripe and returns in Stripe's independently initiated
webhook.

### 4. Inspect authoritative evidence

Use CloudWatch Logs and the stored order to prove:

- API access logs show expected 2xx responses and no unexplained 4xx/5xx;
- `stripe.webhook.started` and `stripe.webhook.completed` exist for the signed
  event, with an applied or safely ignored outcome and no reconciliation error;
- successful signature verification proves API Gateway delivered the exact raw
  bytes required by Stripe's signature;
- the publisher emits `order.created` for version 1 but the delivery worker
  does not process that event;
- payment success changes the order to `PENDING_SUBMISSION` and the publisher
  emits `order.ready_for_submission`;
- the delivery worker processes `order.ready_for_submission`, after which the
  normal submitted, picked-up, and delivered changes appear; and
- all four application queues finish with no visible or in-flight messages and
  all three failure queues are empty.

Filter the event timeline by `orderId`, then use the two correlation IDs to
inspect each boundary. The existing
[CloudWatch query cookbook](../operations/cloudwatch-query-cookbook.md) explains
the parsing and correlation workflow.

### 5. Verified teardown

Press `Ctrl+C` once in the supervising terminal and wait for its final teardown
status. If teardown is interrupted, run `npm run cloud:destroy` and do not start
another lab until recovery completes.

After success, `npm run cloud:status` must show:

- no application CloudFormation stack;
- no active lab-owned Stripe webhook endpoint;
- no temporary webhook-signing SSM parameter;
- no owned local UI, vendor, or tunnel process;
- no temporary browser credential file; and
- no unexplained recovery state.

The retained SAM artifact bucket and retained Standard SSM Stripe Sandbox API
key are approved deployment support resources outside the application stack.
Their presence is expected; any other retained resource requires investigation.

## Stop conditions

Stop the exercise and begin verified teardown if any of these occurs:

- the change set contains an unreviewed fixed-cost resource or replacement;
- readiness fails or an owned process cannot be identified;
- HTTP, Lambda, queue, database, log, or artifact usage approaches a bound;
- the UI exceeds its bounded tracker or produces repeated unexpected requests;
- an event reaches a DLQ or an unexplained retry loop begins;
- Stripe reports a live-mode object or anything other than synthetic data;
- a signing/authentication secret appears in logs or evidence; or
- the stored order needs reconciliation rather than completing the one happy
  path.

## Evidence record

Complete this only during an approved exercise:

- [ ] Reviewed commit SHA recorded.
- [ ] Deployment account, region, stack, and change set match this review.
- [ ] Cognito PKCE and bearer-token evidence recorded without secrets.
- [ ] One order and PaymentIntent completed in Stripe Sandbox.
- [ ] Raw Stripe webhook signature verification succeeded.
- [ ] `order.created` was excluded from delivery consumption.
- [ ] `order.ready_for_submission` crossed Stream, publisher, SNS, SQS, and the
      delivery worker.
- [ ] Stored order reached `DELIVERED`.
- [ ] Queues and DLQs ended empty.
- [ ] Temporary Stripe endpoint and webhook secret were deleted.
- [ ] Application stack and owned local processes were removed.
- [ ] Billing evidence remained inside the approved bound.

## Approval record

- [ ] Owner approves the exact resource/configuration inventory.
- [ ] Owner approves the bounded one-order workload and stop conditions.
- [ ] Owner approves the conservative `< $0.05` cost bound.
- [ ] Owner explicitly authorizes the live AWS and Stripe Sandbox exercise.

