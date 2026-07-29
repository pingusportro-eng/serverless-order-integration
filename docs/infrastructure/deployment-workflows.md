# Controlled development deployment workflows

Status: first controlled deployment cycle completed and destroyed

Last reviewed: 2026-07-28

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
bucket and applied the scoped policies. The three GitHub environment secrets
are configured. A separately approved application deployment was subsequently
created, smoke-tested, and destroyed.

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

CloudFormation drift detection later began inspecting CloudWatch Logs field
index policies for managed log groups. The execution role therefore also needs
the read-only regional action `logs:DescribeIndexPolicies`; without it, drift
detection ends as `DETECTION_FAILED` before it can report `IN_SYNC` or
`DRIFTED`.

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

The GitHub `development` environment contains:

- `CURSOR_SIGNING_SECRET`;
- `WEBHOOK_SIGNING_SECRET`; and
- `VENDOR_AUTH_TOKEN`.

Each value must contain at least 32 characters. They are exposed only to the
prepare step after environment approval and are written to a permission-limited
temporary parameter file. The file is deleted by a shell trap. The values are
passed to CloudFormation parameters marked `NoEcho`; they are not committed,
printed, placed in a workflow artifact, or stored in AWS Secrets Manager.

`CURSOR_SIGNING_SECRET` and `WEBHOOK_SIGNING_SECRET` remain only in GitHub.
The local mock needs the vendor bearer token after each reboot, so the rotated
`VENDOR_AUTH_TOKEN` is also stored in `.env.development.local`. That file:

- contains only the vendor token;
- is covered by the repository's `.env.*` ignore rule;
- has mode `0600`; and
- is loaded by Node's built-in `--env-file` option.

This is a deliberate personal-development tradeoff: processes running as the
same Linux user and unencrypted backups can read the file. The value must never
be committed, logged, or copied into documentation or chat.

The GitHub environment page was visually checked to contain exactly:

- `CURSOR_SIGNING_SECRET`;
- `WEBHOOK_SIGNING_SECRET`; and
- `VENDOR_AUTH_TOKEN`.

Post-rotation checks inspected only the local file's mode, ignore rule, variable
name, and value length. They did not display the token.

`vendor_base_url` is a non-secret manual input. The prepare script accepts only
a root `https://*.trycloudflare.com` URL and verifies that it reaches the mock
vendor before creating a change set.

## Manual operations

The workflow has only `workflow_dispatch`; it cannot run on a push, pull
request, or schedule. Every operation uses the protected `development`
environment and therefore requires its manual approval.

### Terminal-supervised learning operation

The manual operations remain the security and deployment primitives. For
repeated observability sessions, `npm run cloud:deploy` drives them through the
authenticated GitHub CLI:

1. discover existing local processes, workflow runs, change sets, and the real
   application stack;
2. reuse only healthy lab-owned processes and matching cloud state;
3. select a free loopback port rather than interfering with an unrelated mock;
4. start and verify a Quick Tunnel without copying its URL;
5. dispatch and terminal-approve the protected `prepare` job;
6. print the exact CloudFormation resource changes;
7. validate and automatically dispatch `execute` for that exact change set;
8. terminal-approve the protected `execute` job;
9. create a temporary Cognito operator and secure local header file;
10. remain active as a live mock-vendor request/response console; and
11. treat the first `Ctrl+C` as a request for verified `destroy`.

The environment approval API removes browser navigation, but it does not merge
prepare and execute or bypass the exact change-set guard. Invoking
`npm run cloud:deploy` runs the complete guarded deployment without requiring
later terminal input, so it can be left unattended.

The supervisor stores recovery state only under the ignored
`.aws-sam/cloud-lab/` directory with user-only permissions. Authorization
tokens and webhook signing material are never printed. The local webhook secret
is generated for the lab and sent to the GitHub environment secret API over
standard input. The local copy is deleted after verified teardown; a future lab
run rotates the GitHub value again before preparing its stack.

If a healthy stack already matches the pushed commit and active tunnel, it is
attached rather than duplicated. A changed commit or tunnel creates an UPDATE
change set. An exact available change set is resumed. Running workflow
operations are reused or allowed to settle. Unrecoverable CloudFormation
statuses stop deployment and enter the exact verified teardown path instead of
being updated blindly.

The first interrupt is not an immediate process exit. It starts or queues the
destroy operation, streams its progress, verifies the stack and exact S3 prefix
are absent, stops owned local processes, and prints the final status. Power
loss, `SIGKILL`, or lost connectivity cannot guarantee automatic cleanup, so
`npm run cloud:destroy` is the idempotent recovery command.

A destroy run is matched by its exact operation even if `master` advanced after
the lab started. Prepare and execute remain bound to their reviewed commit, but
teardown must not fail merely because a documentation or safety fix was pushed
during a live lab.

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

## First controlled deployment result

The first complete GitHub Actions deployment cycle finished on 2026-07-28:

1. a temporary Quick Tunnel exposed the local mock vendor;
2. `prepare` created the non-executing change set
   `github-316bd9678109-30362002953`, bound to commit `316bd96`;
3. the reviewed change set was separately approved and executed;
4. all 34 application resources reached `CREATE_COMPLETE`;
5. the unauthenticated orders request returned `401`;
6. the unsigned webhook request returned `401`, and the webhook Lambda log
   confirmed that it processed the request;
7. the table and all four queues remained empty because the bounded smoke test
   deliberately created no business data; and
8. the separately approved `destroy` operation removed the application stack
   and deployment artifacts.

The early reviewed attempts exposed narrowly scoped CloudFormation execution
role gaps for SAM-truncated role and function names, API Gateway stage tagging,
CloudWatch Logs delivery configuration, and resource-provider read actions.
Each failure rolled back without leaving a usable application stack. The
permissions were expanded only for the observed resource patterns and actions,
then validated with IAM simulations before the successful deployment.

The final cleanup audit checked each owning AWS service rather than relying
only on the Resource Groups Tagging API, which temporarily returned stale
identifiers. It confirmed:

- the application CloudFormation stack is absent;
- the application Lambda functions, DynamoDB table, SQS queues, SNS topic,
  HTTP API, Cognito user pool, log groups, IAM execution roles, and event source
  mappings are absent;
- the artifact prefix contains no objects or incomplete multipart uploads;
- the local mock vendor and Quick Tunnel are stopped; and
- the bootstrap stack remains `UPDATE_COMPLETE` with its empty, lifecycle-
  managed artifact bucket and OIDC roles.

No application resource remains active. The retained bootstrap resources have
an expected recurring AWS cost of `$0` at the current empty learning scale.
Billing data can arrive later, so the `$1` Budget remains the independent alert.

Phase 6.3 is complete. Any future deployment is still a new external operation
that requires the same separate preparation, execution, cost awareness, and
destruction decisions.
