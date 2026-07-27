# Development deployment record

Status: deployed; expanded failure-campaign update pending approval
Deployed: 2026-07-25  
Stack: `serverless-order-integration-dev`  
Region: `eu-central-1`  
AWS CLI profile: `pingusportro-admin`

## Scope

This is the one short development deployment approved in the
[pre-deployment cost review](pre-deployment-cost-review.md). The approved
parameter values were used without increasing concurrency, retention, or the
bounded smoke-test workload.

No application request or message was sent during deployment verification.
The temporary authenticated mock vendor and Cloudflare Quick Tunnel remain
running for step 5.5. Their generated token was not printed or committed.

## Deployment history

The first create attempt exposed a YAML type defect:

```text
MfaConfiguration: OFF
```

YAML interpreted the unquoted `OFF` as boolean `false`; Cognito requires the
string enum value `OFF`. CloudFormation rolled the attempt back. All partially
created application resources reached `DELETE_COMPLETE`, and the failed stack
record was deleted before retrying.

The template now uses:

```text
MfaConfiguration: 'OFF'
```

A parsed built-template assertion verifies both its value and string type.

The corrected create change set contained exactly 32 reviewed additions and no
excluded fixed-cost resource. It completed successfully.

Initial drift detection then found that API Gateway normalizes its access-log
destination ARN by removing the CloudWatch Logs `:*` suffix returned by
`AWS::Logs::LogGroup.Arn`. The template was changed to construct the exact ARN
stored by API Gateway. The reviewed correction contained only:

- four in-place Lambda `Code` updates caused by rebuilt artifact hashes;
- one in-place HTTP API body update; and
- one in-place stage `AccessLogSettings` update.

It contained no addition, deletion, replacement, permission, concurrency,
retention, or cost-setting change. The final stack drift status is `IN_SYNC`
with zero drifted resources.

## Non-secret stack outputs

| Output | Deployed value |
| --- | --- |
| `ApiUrl` | `https://86cd1mjwal.execute-api.eu-central-1.amazonaws.com` |
| `OrdersTableName` | `serverless-order-integration-dev-OrdersTable-1U8V5O0NCNKSY` |
| `OrdersTableStreamArn` | `arn:aws:dynamodb:eu-central-1:454921778743:table/serverless-order-integration-dev-OrdersTable-1U8V5O0NCNKSY/stream/2026-07-25T04:15:27.732` |
| `DomainEventsTopicArn` | `arn:aws:sns:eu-central-1:454921778743:serverless-order-integration-dev-DomainEventsTopic-WoLU3XtUHzNq` |
| `DeliveryQueueUrl` | `https://sqs.eu-central-1.amazonaws.com/454921778743/serverless-order-integration-dev-DeliveryQueue-uHI8DMZh02m5` |
| `DeliveryDeadLetterQueueUrl` | `https://sqs.eu-central-1.amazonaws.com/454921778743/serverless-order-integration-dev-DeliveryDeadLetterQueue-lbW7gu1aNo9T` |
| `StreamPublisherFailureQueueUrl` | `https://sqs.eu-central-1.amazonaws.com/454921778743/serverless-order-integration-dev-StreamPublisherFailureQueue-J5wrZfmO0rkb` |
| `UserPoolId` | `eu-central-1_DkYQiGwT7` |
| `UserPoolClientId` | `1d78o6l382tglhs3vjolbh7pqq` |
| `UserPoolIssuer` | `https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_DkYQiGwT7` |

These identifiers are not credentials. The cursor secret, webhook secret, and
vendor token remain unrecorded.

## Verification results

| Boundary | Result |
| --- | --- |
| CloudFormation | Final status `UPDATE_COMPLETE`; 32 resources; drift `IN_SYNC` |
| DynamoDB | Table and both GSIs `ACTIVE`; `PAY_PER_REQUEST`; `NEW_IMAGE` Stream enabled; deployed definition in sync |
| Lambda | Four functions `Active`, last update successful, 128 MB; worker timeout 15 seconds and other timeouts 10 seconds |
| Stream mapping | `Enabled`; batch 10; two retries; one-hour age; partial failures enabled |
| SQS mapping | `Enabled`; batch 2; partial failures enabled; deployed maximum concurrency 2 |
| Delivery queue | 90-second visibility, one-day retention, SQS-managed encryption, redrive count 3 |
| Failure queues | One-day retention and SQS-managed encryption |
| HTTP API | HTTP protocol, auto-deploy, rate 1 request/second, burst 2, access logging enabled |
| Cognito | Empty Lite pool; MFA `OFF`; no test user created yet |
| Logs | Five log groups, each with one-day retention and zero stored bytes before testing |
| SAM artifacts | Ten objects totalling 4,436,520 bytes |
| Budget | Existing `$1` Zero-Spend Budget still reported `$0.00`; AWS billing can be delayed |

The installed tunnel client is `cloudflared 2026.7.3`; its published SHA-256
digest was verified before installation.

## Packaging resources outside the application stack

SAM created these approved packaging resources:

| Resource | Value |
| --- | --- |
| Managed CloudFormation stack | `aws-sam-cli-managed-default` |
| Managed S3 bucket | `aws-sam-cli-managed-default-samclisourcebucket-j2b4pugchzol` |
| Project object prefix | `serverless-order-integration-dev/` |

They are not deleted with the application stack. Step 5.6 must remove the
project artifacts and, because this managed stack and bucket were created
specifically for this project, remove them after confirming they are not
shared.

## Next boundary

The bounded [cloud smoke tests](cloud-smoke-tests.md) passed after correcting
the IAM and event-contract defects they exposed. A later review approved a
subscription DLQ before the expanded failure campaign. Its
[deployment preflight](subscription-dlq-deployment-review.md) is complete, but
the stack update still requires explicit approval. After that campaign, step
5.6 must destroy the application stack, remove the packaging resources, and
verify that no project resource remains.
