# GitHub-to-AWS OIDC review

Status: design reviewed; external configuration blocked on repository identity

Reviewed: 2026-07-27  
AWS account: `454921778743`  
AWS region: `eu-central-1`  
Local AWS profile used for read-only verification: `pingusportro-admin`

## Purpose and approval boundary

GitHub Actions should obtain short-lived AWS credentials through OpenID Connect
(OIDC). No AWS access key or secret access key will be stored in GitHub.

This document does not authorize an AWS or GitHub change. A later approved
action would create account-level IAM resources and a GitHub deployment
environment. Step 6.3 would separately authorize any application deployment and
its usage-based costs.

## Verified starting state

Read-only checks found:

- the selected profile reaches account `454921778743`;
- the account has no IAM OIDC provider;
- no IAM role name contains `GitHub` or
  `serverless-order-integration`; and
- there is no active CloudFormation stack in `eu-central-1`.

The local Git repository has no remote. Therefore its GitHub owner, repository
name, immutable owner ID, immutable repository ID, visibility, and OIDC subject
format are not yet known. The local Git author name and email do not prove any
of those security-sensitive values.

## Proposed identity boundary

The deployment job will use:

| Setting | Proposed value |
| --- | --- |
| AWS OIDC issuer | `https://token.actions.githubusercontent.com` |
| AWS audience | `sts.amazonaws.com` |
| AWS account | `454921778743` |
| GitHub environment | `development` |
| Allowed Git ref | `refs/heads/master` |
| Application stack | `serverless-order-integration-dev` |
| OIDC role | `serverless-order-integration-github-deployer` |
| CloudFormation service role | `serverless-order-integration-cloudformation-execution` |
| Maximum role session | 1 hour |
| Requested workflow session | 15 minutes |

The final trust policy will use `StringEquals`, not a repository or branch
wildcard:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::454921778743:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "<exact verified GitHub subject>",
          "token.actions.githubusercontent.com:repository_owner_id": "<verified numeric owner ID>",
          "token.actions.githubusercontent.com:repository_id": "<verified numeric repository ID>",
          "token.actions.githubusercontent.com:environment": "development",
          "token.actions.githubusercontent.com:ref": "refs/heads/master"
        }
      }
    }
  ]
}
```

The `sub` value cannot be filled safely until the repository exists and its OIDC
configuration is inspected. GitHub's current immutable format can include both
owner and repository numeric IDs, so a guessed name-based subject could either
fail authentication or trust the wrong future namespace.

The future deployment job must declare:

```yaml
permissions:
  contents: read
  id-token: write

environment: development
```

`id-token: write` will be granted only to the deployment job. It will not be
added to the pull-request workflow.

## Proposed permission split

### GitHub deployer role

The OIDC role will be a narrow CloudFormation client:

- create, inspect, execute, and delete change sets only for
  `serverless-order-integration-dev`;
- inspect stack events and outputs for that stack;
- delete that application stack only through the deliberate destruction
  workflow;
- pass exactly
  `serverless-order-integration-cloudformation-execution`, only to
  `cloudformation.amazonaws.com`; and
- access only the future project artifact bucket and project prefix reviewed in
  step 6.3.

It will have no permission to:

- create, update, or delete an IAM OIDC provider;
- change its own trust or permission policy;
- operate the OIDC/bootstrap CloudFormation stack;
- pass any other role;
- create long-lived IAM access keys; or
- call application services directly.

The CloudFormation policy will constrain the fixed stack ARN, required
Serverless transform, fixed service-role ARN, region, and account wherever the
AWS action supports those constraints. Some discovery calls do not support
resource-level permissions and will require `"Resource": "*"`, but they will be
read-only and listed explicitly.

### CloudFormation service role

CloudFormation will receive a separate service role containing only the
service actions required by `template.cloud.yaml`. This keeps DynamoDB, Lambda,
API Gateway, Cognito, SNS, SQS, Logs, and application-IAM provisioning
permissions out of the GitHub identity.

The service role will be prevented from modifying the OIDC provider, GitHub
deployer role, or its own bootstrap stack. Its IAM permissions must be limited
to the application Lambda roles and policies. The exact action/resource matrix
will be validated before any role is created.

The OIDC provider and both roles will be installed from a separate bootstrap
template using the local administrator profile. The GitHub role will not be
allowed to deploy or mutate that bootstrap template.

## GitHub environment controls

The `development` environment should:

- permit deployments only from `master`;
- require a reviewer and prevent self-review when the repository visibility and
  GitHub plan support those protections; and
- contain deployment secrets only, never long-lived AWS credentials.

OIDC replaces AWS credentials, not the application's cursor, webhook, or vendor
secrets. Their storage and redaction remain a separate step 6.3 design.

Required-reviewer availability differs by repository visibility and GitHub
plan. The repository visibility and plan must therefore be confirmed before
the environment control is treated as an approval gate.

## Cost boundary

IAM OIDC providers, IAM roles, IAM policies, and AWS STS are available without
an additional AWS charge. Creating only the reviewed identity resources has
expected AWS cost `$0`.

The following are outside this approval:

- GitHub-hosted runner minutes, which depend on repository visibility and the
  GitHub plan;
- S3 artifact storage and requests;
- application stack resources; and
- smoke-test traffic and logs.

These costs must be reviewed before step 6.3 creates an artifact bucket or
deploys the application.

## Verification and teardown plan

Before creation:

1. add and verify the GitHub remote;
2. record the exact repository URL, visibility, owner ID, repository ID, and
   actual OIDC subject format;
3. validate the bootstrap template and both IAM policies locally;
4. run IAM policy validation and inspect every wildcard;
5. review the CloudFormation change set; and
6. obtain explicit approval for the external changes.

After creation:

1. inspect the provider audience and URL;
2. inspect the role trust policy and effective attached/inline policies;
3. verify an allowed `master` + `development` job can obtain only the expected
   role;
4. verify an unapproved ref or environment cannot assume it;
5. confirm no AWS access-key secret exists in GitHub; and
6. confirm no application resource or artifact bucket was created.

Teardown will delete the application stack and artifacts first. When no workflow
depends on OIDC, the bootstrap stack can remove both roles and the provider.
Because the provider is account-level, it must be checked for other consumers
again immediately before deletion.

## Required input

The next safe action requires:

- the exact GitHub repository URL, after it is created and added as this
  repository's remote; and
- whether it is public or private, plus the GitHub plan if it is private.

No IAM template should be finalized or deployed before those values are
verified.
