# Pull-request checks

## Purpose

The `Pull request checks` GitHub Actions workflow gives reviewers one repeatable
signal that the repository passes its local quality, test, and infrastructure
checks before code is merged into `master`.

The workflow runs for pull requests targeting `master`. It can also be started
manually with `workflow_dispatch` when the workflow itself needs verification.

## Checks

One Ubuntu runner performs these checks in order:

1. installs the exact npm dependency graph from `package-lock.json`;
2. checks formatting, linting, and TypeScript types;
3. runs unit tests and enforces coverage thresholds;
4. builds the TypeScript project;
5. starts DynamoDB Local under the CI-only Compose project name
   `serverless-order-integration-ci` and runs the integration tests;
6. removes that CI-only container and volume even when an integration assertion
   fails;
7. validates both SAM templates; and
8. builds the deployable SAM application locally.

Named workflow steps make the failed boundary visible in the pull request. A
30-minute job timeout bounds a hung tool or container, while the concurrency
group cancels an obsolete run when a newer commit is pushed to the same pull
request.

## Security and cost boundary

The workflow has read-only access to repository contents. Checkout credentials
are not persisted, no AWS credential action is used, and the workflow does not
request GitHub's `id-token: write` permission.

The DynamoDB integration suite uses deliberately fake credentials and the
loopback-only DynamoDB Local endpoint. SAM commands are limited to local
validation and builds: the workflow contains no `sam deploy` or CloudFormation
command, and no command targets an AWS service endpoint.

Consequently, the workflow creates no AWS resources and has an expected AWS
cost of `$0`. It does consume GitHub-hosted runner minutes; the single-job
layout, npm cache, cancellation policy, and timeout limit unnecessary usage.

## Local equivalent

Run the same boundaries locally before pushing:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
COMPOSE_PROJECT_NAME=serverless-order-integration-ci npm run test:integration
COMPOSE_PROJECT_NAME=serverless-order-integration-ci docker compose down --volumes
npm run sam:validate
npm run sam:cloud:validate
npm run sam:cloud:build
```

The explicit Compose project name isolates these disposable resources from the
normal development volume.

## Verification performed

The workflow file passed `actionlint` 1.7.12. Each important boundary was also
given a temporary defect and confirmed to return a failing exit status:
formatting, linting, type-checking, TypeScript build, unit coverage, DynamoDB
integration, SAM lint, and SAM build. All temporary probe files and generated
artifacts were then removed.

The clean workflow-equivalent run passed with 230 unit tests, all four coverage
thresholds above 80%, 21 DynamoDB Local integration tests, two valid SAM
templates, and a successful deployable build of all four Lambda functions. The
CI-only Docker container, network, and volume were absent after cleanup.
