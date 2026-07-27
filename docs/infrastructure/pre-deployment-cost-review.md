# Pre-deployment cost review

Status: original stack deployed; subscription-DLQ update approved but not deployed

Last reviewed: 2026-07-27

Deployment region: `eu-central-1` (Europe, Frankfurt)  
Required AWS CLI profile: `pingusportro-admin`

## Purpose and approval boundary

This review covers the first short-lived cloud deployment of the
`serverless-order-integration` learning stack. It does not authorize a
deployment by itself.

No AWS application resources may be created until the project owner approves:

1. the recommended cost-control parameters;
2. the temporary public mock-vendor approach;
3. the bounded smoke-test workload; and
4. the deployment itself.

The monthly project ceiling remains **$5 USD**. The planned smoke test is much
smaller than that ceiling, but an AWS Budget is an alert rather than a hard
spending limit.

## Account safeguards verified

Read-only checks on 2026-07-24 confirmed:

- the explicit `pingusportro-admin` profile still reaches the selected project
  account;
- the existing `My Zero-Spend Budget` has a `$1.00` budget limit;
- its reported actual spend is `$0.00`;
- its actual-spend notification is healthy and has one subscriber; and
- no subscriber address or account credential was recorded.

The first deployment must continue to pass `--profile pingusportro-admin` and
`--region eu-central-1` explicitly. It must not rely on the machine's default
AWS profile.

## Resource inventory

### Resources with usage-based cost

| Service | Planned resources | Charging dimension |
| --- | --- | --- |
| API Gateway | One regional HTTP API, one `$default` stage, and five routes | Requests and internet data transfer |
| Lambda | Four 128 MB functions: orders API, webhook, stream publisher, and delivery worker | Invocations and GB-seconds |
| DynamoDB | One Standard on-demand table, two sparse GSIs, and one `NEW_IMAGE` Stream | Reads, writes, indexed storage, and table storage |
| SNS | One Standard topic and one filtered SQS subscription | Publish requests and deliveries |
| SQS | Delivery queue, delivery-worker DLQ, publisher failure queue, and SNS subscription DLQ | API requests and payload chunks |
| Cognito | One Lite user pool, one public app client, and one operators group | Monthly active users |
| CloudWatch Logs | API access log group and four Lambda log groups | Ingestion, retained storage, and optional query scanning |
| S3 deployment artifacts | One small SAM packaging bucket containing zipped Lambda artifacts | Storage and a small number of PUT/GET/LIST requests |

Lambda-triggered `GetRecords` calls against DynamoDB Streams are not billed.
CloudFormation, IAM roles and policies, Lambda permissions, event-source
mappings, the SQS resource policy, and CloudWatch service metrics have no
separate fixed charge in this design.

The local cloud build is currently about 9.5 MB before deployment packaging.
The review uses a conservative upper bound of 20 MB for retained S3 artifacts.
The artifact bucket is deployment infrastructure outside the application stack
and must be included in the teardown check.

### Explicitly absent

The template contains no:

- VPC, NAT Gateway, VPC endpoint, Elastic IP, or load balancer;
- API Gateway REST API, cache, custom domain, or WAF;
- provisioned Lambda concurrency or provisioned event pollers;
- provisioned DynamoDB capacity, DAX, backup, point-in-time recovery, or global
  table;
- FIFO topic or queue;
- EventBridge resource;
- customer-managed KMS key;
- Secrets Manager secret or Parameter Store advanced parameter;
- CloudWatch custom metric, alarm, dashboard, tracing, or synthetic canary; or
- continuously running compute resource.

These exclusions remove the main fixed-hourly cost risks. They do not make the
budget a hard cap: unexpected public traffic, excessive logging, or retained
data could still generate usage charges.

## Approved incremental SNS safeguard

On 2026-07-27, the project owner approved adding one standard SQS queue as the
delivery subscription's dead-letter queue.

- The queue has no fixed hourly or idle request charge.
- Successful SNS deliveries never write to it.
- It reuses the approved one-day failure-message retention.
- It uses SQS-managed encryption and introduces no KMS key or KMS request cost.
- The bounded failure drill adds only a handful of SQS requests and remains
  inside the existing `$0.02` incremental campaign ceiling.
- This approval covers the template change, not deployment; deployment remains
  a separate deliberate action.

The live baseline, exact expected update, rollback behavior, and deployment
gates are recorded in the
[SNS subscription-DLQ deployment review](subscription-dlq-deployment-review.md).

## Recommended deployment parameters

These values are **recommendations awaiting owner approval**:

| Parameter | Recommended value | Reason |
| --- | ---: | --- |
| `LogRetentionDays` | `1` | Minimum allowed retention for this short experiment |
| `ApiThrottleBurstLimit` | `2` | Permits a tiny burst without opening a large public request rate |
| `ApiThrottleRateLimit` | `1` | One request per second is enough for sequential smoke tests |
| `DynamoMaxReadRequestUnits` | `10` | Allows transactional and indexed test traffic while bounding on-demand scaling |
| `DynamoMaxWriteRequestUnits` | `10` | A create transaction writes three items and must not be capped at one unit |
| `StreamPublisherBatchSize` | `10` | Small batches limit reprocessing and invocation duration |
| `StreamPublisherMaximumRetryAttempts` | `2` | Two retries after the initial attempt release a poison record quickly |
| `StreamPublisherMaximumRecordAgeSeconds` | `3600` | One-hour safety net leaves ordinary backlog time without holding poison records for 24 hours |
| `DeliveryWorkerBatchSize` | `2` | Keeps sequential external calls bounded |
| `DeliveryWorkerMaximumConcurrency` | `2` | Minimum supported explicit SQS concurrency cap and at most two simultaneous vendor-calling workers |
| `DeliveryWorkerTimeoutSeconds` | `15` | Bounds a worker batch without approaching Lambda's service maximum |
| `DeliveryQueueVisibilityTimeoutSeconds` | `90` | Six times the worker timeout, following Lambda's SQS guidance |
| `DeliveryQueueMaxReceiveCount` | `3` | Provides bounded learning retries and reaches the DLQ in a reasonable test time |
| `DeliveryMessageRetentionSeconds` | `86400` | One day for pending synthetic delivery work |
| `FailureMessageRetentionSeconds` | `86400` | One day to inspect any of the three failure queues before teardown |
| `VendorTimeoutMs` | `3000` | Two sequential worst-case vendor waits use 6 of the Lambda's 15 seconds |

The relationships required by the asynchronous design hold:

```text
visibility timeout = 90 seconds = 6 × 15-second Lambda timeout
worker batch bound = 2 × 3-second vendor timeout = 6 seconds
remaining Lambda time = approximately 9 seconds for reads, writes, and reporting
```

`DynamoMaxReadRequestUnits` and `DynamoMaxWriteRequestUnits` are best-effort
throughput controls, not billing limits. API throttling, authentication, the
short test window, immediate teardown, and the AWS Budget remain additional
layers.

## Required non-cost parameters and secrets

The planned non-secret values are:

| Parameter | Planned value |
| --- | --- |
| `EnvironmentName` | `dev` |
| `MerchantId` | `mrc_demo` |
| `WebhookToleranceSeconds` | `300` (template default) |

The deployment needs newly generated values for:

- `CursorSigningSecret`;
- `WebhookSigningSecret`; and
- `VendorAuthToken`.

They must contain at least 32 characters, must not be committed, printed in
logs, or placed in a checked-in parameter file, and must be discarded after
stack teardown. `VendorBaseUrl` is not a secret but will be temporary.

## Temporary public mock vendor

The delivery worker is not in a VPC and requires a public HTTPS vendor. The
local mock binds to localhost and cannot be called directly from Lambda.

The recommended learning-only option is a **Cloudflare Quick Tunnel**:

```text
AWS Delivery Worker
        |
        | HTTPS to a random temporary trycloudflare.com URL
        v
Cloudflare Quick Tunnel
        |
        | outbound tunnel connection
        v
Local mock vendor on 127.0.0.1:4000
```

Reasons for the recommendation:

- advertised cost is `$0`;
- it requires no domain, inbound port, or continuously deployed vendor;
- the random endpoint exists only while `cloudflared` runs; and
- it lets the cloud worker exercise the existing mock-vendor contract.

Limitations and security boundary:

- Quick Tunnels are a third-party service intended only for testing, with no
  SLA;
- Cloudflare proxies the synthetic request data;
- the URL is public, so the mock's bearer token must be a new temporary secret;
- the laptop, mock server, and tunnel must remain running during worker tests;
- `cloudflared` is not currently installed and must not be installed until this
  choice is approved; and
- the tunnel must be stopped immediately after the smoke test.

Alternatives are to provide another reviewed public HTTPS mock endpoint or add
an AWS-hosted mock Lambda/API route in a separate review. The latter adds code,
resources, and invocations and is not part of this recommendation.

Cloudflare documents Quick Tunnels as free, randomly addressed, localhost
proxies for testing and development:
<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>.

## Bounded smoke-test workload

The first cloud session is limited to:

- one synthetic Cognito operator;
- at most 30 HTTP API calls;
- at most 100 total Lambda invocations, including asynchronous retries;
- at most 100 SNS publishes;
- at most 1,000 SQS API requests;
- at most 1,000 DynamoDB read request units and 1,000 write request units;
- at most 10 MB of CloudWatch log ingestion;
- at most 20 MB of S3 deployment artifacts; and
- synthetic order data only, with no personal or production data.

The test must stop if request counts, queue depth, repeated failures, log volume,
or billing behavior is materially different from these assumptions.

## Conservative cost estimate

The estimate deliberately does not depend on every Free Tier allowance.
Prices were checked for `eu-central-1` through the AWS Price List API on
2026-07-24 and cross-checked against the public service pricing pages.

| Component | Conservative smoke-test calculation | Estimated charge |
| --- | --- | ---: |
| API Gateway HTTP API | 30 × `$1.20 / million` | `< $0.0001` |
| Lambda requests | 100 × `$0.20 / million` | `< $0.0001` |
| Lambda duration | All 100 invocations pessimistically run for 15 seconds at 128 MB | `< $0.0033` |
| DynamoDB | 1,000 reads at `$0.1525 / million` plus 1,000 writes at `$0.7625 / million` | `< $0.0010` |
| SNS | At most 100 small Standard-topic publishes | `< $0.0001` |
| SQS | 1,000 Standard requests at `$0.40 / million` | `< $0.0005` |
| Cognito Lite | One direct-sign-in MAU, priced without assuming a free allowance | `< $0.0055` |
| CloudWatch Logs | 10 MB at `$0.63 / GB`, plus one-day storage | `< $0.0065` |
| S3 artifacts | At most 20 MB for one month plus a few deployment requests | `< $0.0010` |
| Small internet transfer and rounding margin | Synthetic payloads only | `< $0.0020` |

**Conservative planned total: less than `$0.05`.**

Actual usage should be lower because invocations should not all run to their
timeout and several services have Free Tier allowances. The estimate excludes
unrelated usage already present in the AWS account, taxes, and traffic outside
the bounded test.

Official pricing references:

- <https://aws.amazon.com/api-gateway/pricing/>
- <https://aws.amazon.com/lambda/pricing/>
- <https://aws.amazon.com/dynamodb/pricing/on-demand/>
- <https://aws.amazon.com/sns/pricing/>
- <https://aws.amazon.com/sqs/pricing/>
- <https://aws.amazon.com/cognito/pricing/>
- <https://aws.amazon.com/cloudwatch/pricing/>
- <https://aws.amazon.com/s3/pricing/>

## Deployment and teardown gates

Before deployment:

- [x] Owner approved every recommended parameter value on 2026-07-25.
- [x] Owner approved installing and using a Cloudflare Quick Tunnel.
- [x] Owner approved the bounded smoke-test workload and `< $0.05` estimate.
- [x] Owner explicitly approved the reviewed deployment on 2026-07-25.
- [x] A dry local SAM validation and build passed.
- [x] The AWS identity and region were checked again with the explicit profile.
- [x] The 32-addition CloudFormation change set was reviewed before execution;
      it contained only the approved resources and no deletion, replacement, or
      excluded fixed-cost resource.

After smoke testing:

- [ ] Stop the Quick Tunnel and local mock vendor.
- [ ] Delete the application CloudFormation stack.
- [ ] Empty and delete the SAM artifact bucket and any SAM-managed packaging
      stack created specifically for this project.
- [ ] Confirm the four Lambda functions, HTTP API, table, user pool, topic,
      four queues, five log groups, roles, and event mappings are gone.
- [ ] Check the billing dashboard and Budget status, allowing for reporting
      delay.

Approval of this document authorizes only the reviewed short deployment. Any
new fixed-cost resource, higher concurrency, longer retention, larger workload,
or different vendor-hosting approach requires another cost review.
