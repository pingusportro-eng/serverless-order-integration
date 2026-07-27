# Controlled development deployment workflows

Status: deployment bootstrap updated and verified; application not deployed

Last reviewed: 2026-07-27

AWS account: `454921778743`  
Region: `eu-central-1`  
Application stack: `serverless-order-integration-dev`

## Approval and cost boundary

The owner approved this design before implementation:

- use GitHub `development` environment secrets instead of AWS Secrets Manager;
- use one dedicated non-versioned S3 artifact bucket;
- expire deployment artifacts after one day;
- keep the permanent artifact cap at 50 MB;
- separate preparation, execution, and destruction into manual operations; and
- continue using a free Cloudflare Quick Tunnel and the local mock vendor.

The implementation commit changed only local Infrastructure as Code and
workflow definitions. The later reviewed bootstrap update created the artifact
bucket and applied the scoped policies. GitHub secrets are not configured and
the application is not deployed.

The expected AWS cost before the first application deployment is effectively
zero:

- IAM, OIDC, STS, and CloudFormation have no separate charge here;
- an empty S3 bucket has no storage charge;
- short-lived artifacts and their few requests are expected to cost much less
  than one cent; and
- no Secrets Manager resources are created.

The existing conservative limit for one deployment and bounded smoke test
remains less than `$0.05`. The monthly project ceiling remains `$5`, and the
existing `$1` Budget is an alert rather than a hard spending cap.

## First bootstrap update result

The reviewed non-executing change set
`bootstrap-artifacts-review-20260727` exactly matched commit `58f1e27` and
contained only:

- one `Add` for `DeploymentArtifactBucket`;
- one non-replacing policy modification for
  `CloudFormationExecutionRole`; and
- one non-replacing policy modification for `GitHubDeployerRole`.

Execution failed before the bucket was created because the first deterministic
bucket name contained 64 characters. S3 bucket names have a maximum length of
63 characters. CloudFormation reached `UPDATE_ROLLBACK_COMPLETE` and restored
the original three-resource bootstrap:

- no artifact bucket exists;
- neither new inline policy remains;
- the OIDC provider and trust are unchanged; and
- the application stack remains absent.

The corrected name is:

```text
soi-artifacts-454921778743-eu-central-1
```

It contains 39 characters and still includes the account and region for global
uniqueness. The deployment validator now renders the final name and asserts
both the S3 syntax and 63-character limit. The corrected update has not been
retried at this point in the record.

## Corrected bootstrap update result

After the correction was committed as `8d61f8d`, the non-executing change set
`bootstrap-artifacts-review-20260727-v2` was created and reviewed. It contained
the same three actions as the first attempt:

- add `DeploymentArtifactBucket`;
- modify `CloudFormationExecutionRole` without replacement; and
- modify `GitHubDeployerRole` without replacement.

CloudFormation calculated the exact committed template with the 39-character
bucket name. The change set was separately approved and executed, and the stack
reached `UPDATE_COMPLETE`.

Post-update verification confirmed:

- the bootstrap contains exactly the OIDC provider, two roles, and artifact
  bucket;
- the bucket is in `eu-central-1`;
- versioning is disabled;
- S3-managed AES-256 encryption is enabled;
- every public-access block is enabled;
- ownership is `BucketOwnerEnforced`;
- the development-prefix lifecycle expires objects and aborts incomplete
  multipart uploads after one day;
- the bucket initially contains zero objects and zero bytes;
- all seven deployed inline policies exactly match the committed template;
- the immutable OIDC subject, workflow condition, and AWS audience are
  unchanged and wildcard-free;
- IAM simulation allows the GitHub deployer to list and manage objects only
  under the development prefix;
- IAM simulation denies the GitHub deployer access outside the prefix and
  denies bucket creation or deletion;
- IAM simulation allows CloudFormation to read only packaged objects below the
  prefix and denies writes and outside-prefix reads;
- the application stack remains absent; and
- the `$1` Budget reports `$0.00` actual and forecast spend, subject to normal
  billing delay.

## Persistent deployment infrastructure

The bootstrap template adds exactly one resource:

```text
soi-artifacts-454921778743-eu-central-1
```

The bucket:

- blocks every form of public access;
- enforces bucket-owner object ownership;
- uses S3-managed AES-256 encryption, with no customer-managed KMS key;
- deliberately omits versioning;
- accepts project objects only below
  `serverless-order-integration-dev/`;
- expires those objects after one day; and
- aborts incomplete multipart uploads after one day.

Keeping this bucket in the identity bootstrap prevents SAM from silently
creating the versioned `aws-sam-cli-managed-default` bucket that complicated the
previous teardown.

## Permission boundary

The GitHub deployer receives only:

- `GetBucketLocation` on the exact artifact bucket;
- `ListBucket` constrained to the exact development prefix; and
- `GetObject`, `PutObject`, and `DeleteObject` below that prefix.

It cannot create or delete buckets, change bucket configuration, use another
prefix, or access unrelated S3 objects.

The CloudFormation execution role receives only `GetObject` and
`GetObjectVersion` below the same prefix. This lets CloudFormation retrieve
packaged Lambda code without granting GitHub the application service
permissions.

The existing stack restrictions remain unchanged:

- GitHub can operate only `serverless-order-integration-dev`;
- it must pass the exact CloudFormation execution role;
- the execution role provisions only the reviewed application services; and
- neither role can mutate the OIDC provider or bootstrap stack.

## Secret boundary

The GitHub `development` environment will contain:

- `CURSOR_SIGNING_SECRET`;
- `WEBHOOK_SIGNING_SECRET`; and
- `VENDOR_AUTH_TOKEN`.

Each value must contain at least 32 characters. They are exposed only to the
prepare step after environment approval and are written to a permission-limited
temporary parameter file. The file is deleted by a shell trap. The values are
passed to CloudFormation parameters marked `NoEcho`; they are not committed,
printed, placed in a workflow artifact, or stored in AWS Secrets Manager.

`vendor_base_url` is a non-secret manual input. The prepare script accepts only
a root `https://*.trycloudflare.com` URL and verifies that it reaches the mock
vendor before creating a change set.

## Manual operations

The workflow has only `workflow_dispatch`; it cannot run on a push, pull
request, or schedule. Every operation uses the protected `development`
environment and therefore requires its manual approval.

### `prepare`

The prepare operation:

1. verifies the immutable GitHub OIDC claims and assumed AWS identity;
2. runs the local quality checks;
3. validates the bootstrap and deployable SAM templates;
4. builds the application;
5. rejects a SAM build larger than 50 MB;
6. refuses to package when existing objects plus the build could exceed 50 MB;
7. packages below the exact non-versioned prefix;
8. selects `CREATE` or `UPDATE` only from a stable stack state;
9. creates a named CloudFormation change set with the reviewed parameters and
   fixed execution role;
10. waits until the change set is ready; and
11. prints only its identity and resource-level changes.

The name has this binding:

```text
github-<first 12 characters of commit SHA>-<prepare workflow run ID>
```

Preparation never calls `ExecuteChangeSet`.

### `execute`

Execution requires the exact change-set name printed by prepare. Before
execution, the script verifies:

- the name contains the current commit prefix;
- status is `CREATE_COMPLETE`;
- execution status is `AVAILABLE`;
- its description contains the full current commit SHA;
- it uses the exact CloudFormation execution role; and
- its type is only `CREATE` or `UPDATE`.

After CloudFormation completes, a two-request smoke test verifies:

1. the protected orders route returns `401` without a JWT; and
2. the public webhook returns `401` without a valid signature.

These checks exercise API Gateway and both authorization boundaries without
creating a Cognito user, order, DynamoDB item, domain event, vendor call, or
queue message. The complete event journey was already proven during Phase 5.

The deployed stack remains live after this operation so it can be inspected.
It is not automatically destroyed.

### `destroy`

Destruction requires the user to type:

```text
serverless-order-integration-dev
```

The script verifies the account, uses the fixed CloudFormation role, deletes
and waits for only that stack, then constructs and rechecks this exact cleanup
target:

```text
s3://soi-artifacts-454921778743-eu-central-1/serverless-order-integration-dev/
```

It removes only objects below that prefix and verifies both the stack and
prefix are absent. The empty lifecycle-managed bucket and OIDC identities
remain in the bootstrap for future learning sessions. Their expected retained
AWS cost is `$0`.

## Local verification

Run:

```bash
npm run deployment:validate
npm run oidc:validate
npm run sam:cloud:validate
npm run sam:cloud:build
```

The deployment validator locks:

- bucket encryption, public-access, non-versioning, lifecycle, and prefix;
- exact S3 actions and resources for both roles;
- immutable OIDC claims;
- absence of wildcard IAM actions;
- manual workflow inputs and protected environment;
- pinned deployment action commits;
- exact account, region, stack, role, bucket, prefix, and 50 MB cap;
- the three-operation separation; and
- absence of `sam deploy`, `--resolve-s3`, bucket deletion, recursive local
  deletion, or Secrets Manager use.

## Remaining external steps

No further external step is authorized merely by this document. Continue in
small, reviewable operations:

1. add the three GitHub `development` environment secrets;
2. start the local mock vendor and Quick Tunnel;
3. manually run `prepare` and inspect its change set;
4. separately approve and run `execute`;
5. inspect the live application and billing view;
6. separately approve and run `destroy`; and
7. verify the application is absent, the prefix is empty, and no unexpected
   billed resource remains.
