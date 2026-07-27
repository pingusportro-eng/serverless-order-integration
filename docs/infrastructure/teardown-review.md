# Development AWS teardown review

Status: reviewed; deletion not yet approved or executed

Reviewed: 2026-07-27

AWS account: `454921778743`

Region: `eu-central-1`

AWS CLI profile: `pingusportro-admin`

## Decision

Destroying the development resources is recommended. All approved cloud tests
have passed, the repository and Infrastructure as Code remain available for a
future deployment, and retaining the live stack adds no current learning value.

This review was read-only. It did not delete or modify any AWS resource.

## Current billing and lifecycle state

- The application stack is `UPDATE_COMPLETE`, drift `IN_SYNC`, and termination
  protection is disabled.
- The existing `$1` budget reports `$0.00` actual and `$0.00` forecast spend.
- Only two active CloudFormation stacks exist in `eu-central-1`:
  `serverless-order-integration-dev` and `aws-sam-cli-managed-default`.
- No mock vendor, Quick Tunnel, campaign recovery state, or running Compose
  container remains.

Billing data can be delayed. The observed budget is evidence of the current
billing view, not a guarantee that every usage record has arrived.

## Application stack deletion scope

Deleting `serverless-order-integration-dev` will ask CloudFormation to delete
these 34 resources:

| Resource type | Count |
| --- | ---: |
| API Gateway HTTP API | 1 |
| API Gateway stage | 1 |
| Cognito user pool, client, and operators group | 3 |
| DynamoDB table, stream, and two GSIs | 1 table |
| IAM execution roles | 4 |
| Lambda functions | 4 |
| Lambda permissions | 5 |
| Lambda event-source mappings | 2 |
| CloudWatch log groups | 5 |
| SNS topic and subscription | 2 |
| SQS queues | 4 |
| SQS queue policies | 2 |

The table, user pool, five log groups, SNS topic, and four queues have explicit
`DeletionPolicy: Delete` declarations where data retention matters. The other
resources use CloudFormation's default delete behavior. The table and user
pool both report deletion protection disabled.

### Data that will be permanently lost

The remaining cloud data is synthetic test data:

- five DynamoDB items: one order, one idempotency item, one merchant-reference
  item, one provider-order mapping, and one processed-event marker;
- one confirmed Cognito user:
  `smoke-operator-20260725t043855z`; and
- the deployed Lambda code/configuration and API endpoint.

All four SQS queues contain zero visible, in-flight, and delayed messages. The
five one-day log groups currently report zero stored bytes. The SNS topic has
only its one stack-owned SQS subscription.

CloudFormation deletion is permanent. The synthetic records and user cannot be
recovered from AWS afterward. The source code, templates, tests, diagrams, and
test evidence remain in Git and can recreate a new empty stack.

## SAM packaging resources outside the application stack

The SAM CLI created a separate `aws-sam-cli-managed-default` stack containing:

- versioned S3 bucket
  `aws-sam-cli-managed-default-samclisourcebucket-j2b4pugchzol`; and
- the bucket policy.

The sharing audit found:

- 49 object versions totalling 22,174,164 bytes;
- zero delete markers;
- every key is under `serverless-order-integration-dev/`;
- no other prefix or regional SAM bucket;
- no other active application stack; and
- one managed-stack history created immediately before this project.

The bucket is therefore not shared by another current project in this
account/region. Deleting the managed stack is safe for the current inventory.
Future `sam deploy --resolve-s3` use can create new packaging infrastructure.

Because bucket versioning is enabled, deleting only the visible keys is
insufficient. Every version must be deleted before CloudFormation can delete
the bucket.

## Approved-target teardown sequence

The execution step must use only the identifiers recorded in this document and
must stop on any identity, state, ownership, or content mismatch.

1. Reconfirm account `454921778743`, region `eu-central-1`, profile
   `pingusportro-admin`, budget, empty queues, and both expected stack statuses.
2. Reconfirm the application has exactly 34 stack resources and the SAM bucket
   has no prefix other than `serverless-order-integration-dev`.
3. Request deletion of `serverless-order-integration-dev`.
4. Wait for `DELETE_COMPLETE`. If deletion fails, inspect stack events and do
   not manually delete individual resources.
5. Verify the API, four Lambdas, table, user pool, topic, four queues, five log
   groups, four roles, and two event-source mappings are absent.
6. Enumerate all versions and delete markers in the exact SAM bucket. Delete
   them in bounded batches and verify both lists are empty.
7. Request deletion of `aws-sam-cli-managed-default`.
8. Wait for `DELETE_COMPLETE`, then verify the bucket and bucket policy are
   absent.
9. Confirm no active project stack or project-tagged AWS resource remains,
   check the billing view, and record the final result.

Do not delete the account-level AWS Budget, IAM administrator
`pingusportro-admin`, local Git repository, local DynamoDB Docker volume, or
unrelated AWS resources. CloudFormation may retain non-billable deleted-stack
history for a period after the resources are gone.

## Failure and recovery rules

- Never broaden deletion from an exact stack, bucket, object version, or
  validated project identifier.
- Never use an unvalidated recursive S3 target.
- Do not delete SAM artifacts until the application stack reaches
  `DELETE_COMPLETE`.
- If the application stack deletion fails, leave the packaging stack intact
  while diagnosing.
- If managed-stack deletion fails after object cleanup, retain the empty bucket
  and investigate the CloudFormation event instead of deleting unrelated
  infrastructure.

## Execution approval required

The next step is destructive and requires explicit approval. Approval should
cover permanent deletion of:

1. `serverless-order-integration-dev` and its 34 resources;
2. the five synthetic DynamoDB records and one synthetic Cognito user contained
   in that stack;
3. all 49 versions in the exact SAM artifact bucket; and
4. `aws-sam-cli-managed-default`, its bucket, and its bucket policy.
