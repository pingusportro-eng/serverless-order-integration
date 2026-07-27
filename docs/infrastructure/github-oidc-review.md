# GitHub-to-AWS OIDC review

Status: AWS identity bootstrap deployed and verified; GitHub environment pending

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
CloudFormation stack. The GitHub `development` environment and OIDC diagnostic
workflow have not yet been created.

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

The first authorized OIDC diagnostic job must print decoded non-secret claims,
not the token, and confirm this exact value before any application deployment.

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

Application IAM access is name-scoped to
`serverless-order-integration-dev-*`, and those roles may be passed only to
Lambda. This prefix excludes both bootstrap roles. The execution role has no
OIDC-provider or CloudFormation-stack permissions, so it cannot mutate its own
identity bootstrap.

Some AWS creation and discovery APIs do not support useful resource-level
scoping. The reviewed policy therefore has four deliberate `"Resource": "*"`
boundaries:

- Lambda event-source mapping management, constrained to `eu-central-1`;
- Cognito user-pool provisioning, constrained to `eu-central-1`;
- CloudWatch Logs group discovery, constrained to `eu-central-1`; and
- the read-only CloudFormation `GetTemplateSummary`, constrained to
  `eu-central-1`.

API Gateway control-plane resources also require API-ID wildcards because the
ID does not exist before creation. They are constrained to the reviewed region.
These are residual provisioning privileges of the dedicated CloudFormation
role, not permissions granted directly to GitHub.

## GitHub environment controls

The public repository's `development` environment should:

- permit deployment only from `master`;
- require a reviewer and prevent self-review;
- contain no long-lived AWS credentials; and
- be referenced only by the deployment job.

OIDC replaces AWS credentials, not the application's cursor, webhook, or vendor
secrets. Their storage and redaction remain part of step 6.3.

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

## Cost boundary

IAM OIDC providers, IAM roles, IAM policies, and AWS STS have no additional AWS
charge. The three deployed identity resources have expected AWS cost `$0`:

1. one IAM OIDC provider;
2. one GitHub deployer role; and
3. one CloudFormation execution role.

This approval does not include an artifact bucket, application resources,
smoke-test traffic, or retained logs.

## Remaining verification and teardown

The remaining step 6.2 checks are:

1. configure the `development` GitHub environment protections;
2. use a claim-only diagnostic job to verify the exact `sub`;
3. verify the approved `master` + `development` job can assume only the
   expected role;
4. verify an unapproved ref or environment cannot assume it; and
5. confirm no AWS access-key secret exists in GitHub.

Teardown must delete the application and artifacts first. When no workflow
depends on OIDC, the bootstrap stack can remove both roles and the provider.
Because an OIDC provider is account-level, check again for other consumers
immediately before deleting it.

## Next approval

The next external action is to create the GitHub `development` environment,
restrict it to `master`, configure its approval protection, and add a
claim-only `Deploy development` diagnostic workflow. It will request short-lived
credentials but will not deploy the application or access S3.
