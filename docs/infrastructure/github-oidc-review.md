# GitHub-to-AWS OIDC review

Status: exact identity verified; bootstrap template drafted and locally validated

Reviewed: 2026-07-27  
AWS account: `454921778743`  
AWS region: `eu-central-1`  
GitHub repository:
[`pingusportro-eng/serverless-order-integration`](https://github.com/pingusportro-eng/serverless-order-integration)

## Purpose and approval boundary

GitHub Actions should obtain short-lived AWS credentials through OpenID Connect
(OIDC). No AWS access key or secret access key will be stored in GitHub.

The account-level identity resources are defined in the
[OIDC bootstrap template](../../infrastructure/github-oidc-bootstrap.yaml). The
template is local only: it has not been deployed, no GitHub environment has
been created, and no AWS or GitHub configuration has changed.

Creating the reviewed OIDC provider and roles requires a separate explicit
approval. Step 6.3 will separately review the artifact bucket, application
deployment, test traffic, and their usage-based costs.

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

Read-only AWS checks previously found no IAM OIDC provider, matching IAM role,
or active CloudFormation stack in the reviewed account and region.

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

## Cost boundary

IAM OIDC providers, IAM roles, IAM policies, and AWS STS have no additional AWS
charge. Creating only the three reviewed identity resources has expected AWS
cost `$0`:

1. one IAM OIDC provider;
2. one GitHub deployer role; and
3. one CloudFormation execution role.

This approval does not include an artifact bucket, application resources,
smoke-test traffic, or retained logs.

## External verification and teardown

Before creation:

1. review this template and every wildcard;
2. validate it locally;
3. create and inspect a CloudFormation change set using the local administrator
   profile; and
4. obtain explicit approval before executing that change set.

After creation:

1. inspect the provider URL and audience;
2. inspect both effective role policies;
3. configure the `development` GitHub environment protections;
4. use a claim-only diagnostic job to verify the exact `sub`;
5. verify the approved `master` + `development` job can assume only the
   expected role;
6. verify an unapproved ref or environment cannot assume it; and
7. confirm no application resource, artifact bucket, or AWS access-key secret
   was created.

Teardown must delete the application and artifacts first. When no workflow
depends on OIDC, the bootstrap stack can remove both roles and the provider.
Because an OIDC provider is account-level, check again for other consumers
immediately before deleting it.

## Next approval

The next external action is limited to creating a CloudFormation change set for
this bootstrap in account `454921778743`, region `eu-central-1`, using
`pingusportro-admin`. Creating a change set is non-billing and does not execute
it. We will inspect the exact three-resource change set before separately
asking whether to execute it.
