# Synchronous cloud slice

Status: defined, not deployed  
Last reviewed: 2026-07-24

## Purpose

Step 5.1 introduced the first deployable AWS slice in `template.cloud.yaml`
without creating anything by itself. Step 5.2 extends the same template with
the separately documented asynchronous resources. The existing `template.yaml`
remains the local SAM template. Only the explicit deployment step after the
cost review may create AWS resources.

The editable
[full AWS cloud stack Draw.io diagram](../architecture/full-cloud-stack.drawio)
shows this synchronous path together with the asynchronous and failure paths.

The cloud template defines:

- One API Gateway HTTP API with JWT authorization and bounded request rates
- Two 128 MB Lambda functions for the order API and provider webhook
- One DynamoDB Standard table in on-demand mode with two sparse GSIs
- One Cognito Lite user pool, public app client, and `operators` group
- Three CloudWatch log groups with explicitly selected retention
- SAM-generated Lambda execution roles and invocation permissions

The complete template intentionally defines no VPC, NAT Gateway, load balancer,
custom domain, WAF, cache, provisioned concurrency, backup, customer-managed
KMS key, or test user. See
[asynchronous-cloud-slice.md](asynchronous-cloud-slice.md) for the stream and
messaging additions.

## Security boundaries

The HTTP API JWT authorizer validates the Cognito issuer, client audience, and
token time claims before invoking authenticated routes. The order Lambda maps
all approved synthetic users to the fixed `mrc_demo` learning tenant. Because
API Gateway can otherwise accept a matching Cognito ID token, the Lambda fails
closed unless the verified `token_use` claim is `access`. It also checks the
verified `cognito:groups` claim before permitting the operator status route.

The webhook route overrides the default JWT authorizer with `NONE` because its
separate Lambda verifies the HMAC signature over the unmodified body and
timestamp. The empty authorizer override does not make the other routes public.

The generated Lambda roles receive only the DynamoDB actions used by their
adapters:

| Function | Allowed DynamoDB actions |
| --- | --- |
| Orders API | `GetItem` on the table, `Query` on its indexes, and transactional `PutItem`/`UpdateItem` on the table |
| Vendor webhook | `GetItem` plus transactional `ConditionCheckItem`/`PutItem`/`UpdateItem` on the table |

The write actions are constrained by `dynamodb:EnclosingOperation` to
`TransactWriteItems`; they cannot be used as standalone writes. Lambda's
standard generated logging permission is also present. Neither function
receives permissions for account administration or unrelated tables.

## Data protection and lifecycle

DynamoDB uses `PAY_PER_REQUEST` and the `STANDARD` table class. Omitting
`SSESpecification` deliberately selects DynamoDB's default AWS-owned encryption
key, which encrypts the table at rest without a KMS charge. Point-in-time
recovery and deletion protection remain disabled for the disposable learning
environment.

CloudFormation generates the physical table name so a replacement does not
collide with a retained name. The table, Cognito pool, and log groups use delete
policies so removing the stack removes application resources and stored
synthetic data.

## Values deliberately deferred to the cost review

The template requires these values and provides no defaults:

| Parameter | Decision deferred to step 5.3 |
| --- | --- |
| `LogRetentionDays` | How many days API and Lambda logs remain billable |
| `ApiThrottleBurstLimit` | Maximum short API request burst |
| `ApiThrottleRateLimit` | Maximum steady API requests per second |
| `DynamoMaxReadRequestUnits` | Maximum on-demand reads per second for the table and each GSI |
| `DynamoMaxWriteRequestUnits` | Maximum on-demand writes per second for the table and each GSI |

The DynamoDB maximum-throughput settings are cost controls, but AWS documents
them as best-effort targets rather than absolute billing caps. The AWS Budget
remains an alert rather than a hard stop.

`CursorSigningSecret` and `WebhookSigningSecret` are also required and have no
committed defaults. They are `NoEcho` CloudFormation parameters, but deployed
values still need careful generation and handling during the reviewed
deployment workflow.

## Local verification

Validate and build the deployable template without contacting an AWS account:

```bash
npm run sam:cloud:validate
npm run sam:cloud:build
```

These commands parse, lint, transform, and bundle local source. They do not run
`sam deploy`, create a change set, or call CloudFormation.
