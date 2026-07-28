# GitHub-to-AWS OIDC review

Status: configured and verified end to end

Reviewed: 2026-07-27  
AWS account: `454921778743`  
AWS region: `eu-central-1`  
GitHub repository:
[`pingusportro-eng/serverless-order-integration`](https://github.com/pingusportro-eng/serverless-order-integration)

## Purpose and approval boundary

GitHub Actions should obtain short-lived AWS credentials through OpenID Connect
(OIDC). No AWS access key or secret access key will be stored in GitHub.

The account-level identity resources are defined in the
[OIDC bootstrap template](../../infrastructure/github-oidc-bootstrap.yaml) and
deployed through the `serverless-order-integration-github-oidc-bootstrap`
CloudFormation stack. The protected GitHub `development` environment and
manual OIDC diagnostic workflow are also configured and verified.

Step 6.3 will separately review the artifact bucket, application deployment,
test traffic, and their usage-based costs.

## Verified identity

The repository's public GitHub metadata and local remote establish:

| Field | Verified value |
| --- | --- |
| Owner | `pingusportro-eng` |
| Owner type | personal account (`User`) |
| Immutable owner ID | `309778154` |
| Repository | `serverless-order-integration` |
| Immutable repository ID | `1313908687` |
| Visibility | public |
| Default and deployment branch | `master` |
| Created | `2026-07-27T14:00:41Z` |
| Local remote | `git@github.com-pingusportro-eng:pingusportro-eng/serverless-order-integration.git` |

The repository was created after GitHub's 2026-07-15 immutable-subject rollout.
For a job using the `development` environment, its expected default subject is:

```text
repo:pingusportro-eng@309778154/serverless-order-integration@1313908687:environment:development
```

The first authorized OIDC diagnostic job printed decoded non-secret claims, not
the token, and confirmed this exact value before any application deployment.

The pre-deployment AWS review found no conflicting provider, role, or stack.
The approved bootstrap was created on 2026-07-27.

## Exact identity boundary

| Setting | Reviewed value |
| --- | --- |
| AWS OIDC issuer | `https://token.actions.githubusercontent.com` |
| AWS audience | `sts.amazonaws.com` |
| AWS account | `454921778743` |
| GitHub environment | `development` |
| Allowed Git ref | `refs/heads/master` |
| Allowed workflow name | `Deploy development` |
| Application stack | `serverless-order-integration-dev` |
| OIDC role | `serverless-order-integration-github-deployer` |
| CloudFormation service role | `serverless-order-integration-cloudformation-execution` |
| Maximum role session | 1 hour |
| Requested workflow session | 15 minutes |

The trust policy uses `StringEquals` for every claim and contains no wildcard:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:pingusportro-eng@309778154/serverless-order-integration@1313908687:environment:development",
    "token.actions.githubusercontent.com:repository": "pingusportro-eng/serverless-order-integration",
    "token.actions.githubusercontent.com:repository_owner_id": "309778154",
    "token.actions.githubusercontent.com:repository_id": "1313908687",
    "token.actions.githubusercontent.com:environment": "development",
    "token.actions.githubusercontent.com:ref": "refs/heads/master",
    "token.actions.githubusercontent.com:workflow": "Deploy development"
  }
}
```

The future deployment job must declare:

```yaml
name: Deploy development

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    environment: development
```

`id-token: write` belongs only on the deployment job. It is not present in the
pull-request workflow.

## Permission split

### GitHub deployer role

The GitHub role is a narrow CloudFormation client. It can:

- prepare, inspect, execute, and delete changes only for the
  `serverless-order-integration-dev` stack;
- read the template summary needed to prepare a deployment;
- pass exactly
  `serverless-order-integration-cloudformation-execution`, only to
  `cloudformation.amazonaws.com`; and
- use the regional Serverless transform.

It cannot:

- create, update, or delete an IAM OIDC provider;
- change either bootstrap role or its own trust policy;
- operate the bootstrap stack;
- pass any other role;
- create long-lived IAM access keys;
- call application services directly; or
- access S3.

The absence of S3 access is deliberate. Step 6.3 must define a project artifact
bucket and exact prefix before the role can perform a packaged SAM deployment.

### CloudFormation service role

CloudFormation receives the service permissions needed by
`template.cloud.yaml`: Lambda, DynamoDB, SQS, SNS, CloudWatch Logs, API Gateway,
Cognito, and application Lambda-role provisioning.

Application IAM access is name-scoped to the four SAM-generated Lambda function
and role logical names under the `serverless-order-*` project prefix.
CloudFormation can truncate the stack-name portion of generated names to
satisfy service length limits, so the policy matches each exact logical-name
suffix, including the two role logical names that can themselves be truncated,
instead of assuming the complete
`serverless-order-integration-dev-*` prefix survives. The generated roles may
be passed only to Lambda. The suffixes exclude both bootstrap roles. The
execution role has no OIDC-provider or CloudFormation-stack permissions, so it
cannot mutate its own identity bootstrap.

Some AWS creation and discovery APIs do not support useful resource-level
scoping. The reviewed policy therefore has six deliberate `"Resource": "*"`
boundaries:

- Lambda event-source mapping management, constrained to `eu-central-1`;
- Cognito user-pool provisioning, constrained to `eu-central-1`;
- regional messaging discovery and SNS subscription lifecycle, constrained to
  `eu-central-1`;
- CloudWatch Logs group discovery, constrained to `eu-central-1`;
- HTTP API access-log delivery control, constrained to `eu-central-1`; and
- the read-only CloudFormation `GetTemplateSummary`, constrained to
  `eu-central-1`.

HTTP API access logging uses CloudWatch Logs delivery-control APIs. AWS requires
the delivery lifecycle and account-level resource-policy actions to use
`"Resource": "*"`. Log-group creation, tagging, retention, and deletion remain
scoped to this project's explicit log-group path.

API Gateway control-plane resources also require API-ID wildcards because the
ID does not exist before creation. They are constrained to the reviewed region.
These are residual provisioning privileges of the dedicated CloudFormation
role, not permissions granted directly to GitHub.

API Gateway V2 reports its tagging calls to IAM as `apigateway:TagResource` and
`apigateway:UntagResource`. AWS IAM accepts and evaluates those actions, while
the CloudFormation linter's API Gateway action catalog does not list them.
`CloudFormationExecutionRole` therefore has a resource-local `W3037`
suppression. The deployment validator pins the complete API Gateway action list
and the exact suppression so an unrelated invalid action cannot be introduced
silently.

## GitHub environment controls

Before step 6.3, the public repository's `development` environment was
configured with:

- a required reviewer: `pingusportro-eng`;
- administrator bypass disabled;
- only the selected `master` branch permitted;
- no environment secrets; and
- be referenced only by the deployment job.

Prevent self-review is disabled because this is a personal repository with one
available reviewer. The approval is therefore a deliberate manual checkpoint,
not separation of duties. A team repository should use a different reviewer and
enable prevent self-review.

OIDC replaces AWS credentials, not the application's cursor, webhook, or vendor
secrets. Step 6.3 now defines the approved secret boundary in the
[controlled deployment workflow](deployment-workflows.md): the three values
will be GitHub environment secrets and are exposed only to non-executing
change-set preparation. They have not yet been added.

## Local validation

Run:

```bash
npm run oidc:validate
```

This performs:

- structural assertions for the exact provider, repository IDs, immutable
  subject, branch, environment, and workflow;
- an assertion that the trust policy contains no wildcard;
- assertions that the GitHub role cannot modify OIDC, IAM policies, or access
  keys;
- assertions that the CloudFormation role cannot target either bootstrap role;
  and
- local CloudFormation linting through SAM CLI.

The same check is part of the pull-request workflow. It uses no AWS credentials
and creates no cloud resource.

## Deployed AWS verification

The reviewed `bootstrap-review-20260727` change set contained exactly three
`Add` operations and was executed only after separate approval. CloudFormation
finished with `CREATE_COMPLETE`:

| Logical resource | Physical resource |
| --- | --- |
| `GitHubActionsOidcProvider` | `arn:aws:iam::454921778743:oidc-provider/token.actions.githubusercontent.com` |
| `GitHubDeployerRole` | `serverless-order-integration-github-deployer` |
| `CloudFormationExecutionRole` | `serverless-order-integration-cloudformation-execution` |

Post-deployment verification confirmed:

- the provider has only the `sts.amazonaws.com` audience;
- the deployed GitHub trust has the exact reviewed claims and no wildcard;
- all five deployed inline policies structurally match the reviewed template;
- neither role has an attached managed policy;
- the GitHub role can pass only the reviewed CloudFormation role;
- the GitHub role cannot change its trust, write to S3, pass another role, or
  delete the bootstrap stack;
- the CloudFormation role can create application-prefixed roles but cannot
  create either bootstrap role or operate the bootstrap stack; and
- IAM Access Analyzer policy validation returned no errors.

The first GitHub diagnostic run then proved the complete federation path:

| Field | Verified value |
| --- | --- |
| Workflow run | [`Deploy development #1`](https://github.com/pingusportro-eng/serverless-order-integration/actions/runs/30277647600) |
| Trigger | `workflow_dispatch` |
| Branch | `master` |
| Commit | `2d1f410bc2d4a0beb47205568a0a4676eae9ac7b` |
| Environment approval | required and granted manually |
| OIDC claim inspection | passed |
| AWS role assumption | passed |
| AWS identity assertion | account and role ARN passed |
| Result | success in 9 seconds |

The claim inspector asserted the issuer, AWS audience, immutable subject,
repository and owner IDs, workflow and workflow ref, `master` ref,
`development` environment, public visibility, event type, run ID, and commit
SHA. It emitted only those allow-listed claims and never emitted the JWT or its
request token.

The AWS identity assertion verified:

```text
arn:aws:sts::454921778743:assumed-role/serverless-order-integration-github-deployer/github-30277647600
```

The final AWS inventory contained only the bootstrap stack. No application
stack or application resource was created.

## Cost boundary

IAM OIDC providers, IAM roles, IAM policies, and AWS STS have no additional AWS
charge. The three deployed identity resources have expected AWS cost `$0`:

1. one IAM OIDC provider;
2. one GitHub deployer role; and
3. one CloudFormation execution role.

This approval does not include an artifact bucket, application resources,
smoke-test traffic, or retained logs.

The public-repository diagnostic used nine seconds of GitHub-hosted runner time
and made only OIDC and STS calls. Its expected AWS cost is `$0`.

Teardown must delete the application and artifacts first. When no workflow
depends on OIDC, the bootstrap stack can remove both roles and the provider.
Because an OIDC provider is account-level, check again for other consumers
immediately before deleting it.

## Next approval

Step 6.2 is complete. Step 6.3 must separately review:

- the artifact bucket and object-lifecycle policy;
- exact S3 permissions added to the two roles;
- application parameters and secrets;
- deployment and destruction workflow controls;
- maximum test traffic and log retention; and
- expected cost and teardown verification.

No step 6.3 resource or permission is approved by this document.
