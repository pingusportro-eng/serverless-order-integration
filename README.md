# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The project is in **Phase 6: GitHub Actions CI/CD**. Pull requests targeting
`master` now run local quality, test, DynamoDB Local integration, and SAM
validation/build checks. The workflow uses no AWS credentials and creates no
AWS resources. The exact GitHub OIDC provider and two IAM roles are deployed
and verified at expected AWS cost `$0`. The protected GitHub `development`
environment and claim-only authentication run also passed. Application
deployment remains separately approval-gated.

Work is divided into small reviewable steps. See [PLAN.md](PLAN.md) for the
current checklist, architecture, verification criteria, and definition of done.

## Planned system

The system will accept orders through API Gateway and Lambda, store them in
DynamoDB, publish changes through DynamoDB Streams and SNS, process delivery
requests through SQS and Lambda, and receive signed status webhooks from a mock
delivery vendor.

Most development and testing will run locally using AWS SAM, DynamoDB Local,
and a local mock vendor. Short deployments will verify the real AWS service
integrations and IAM configuration.

## Cost boundary

The AWS budget is **$5 USD per month**. Before any deployment, we will review
the resources, expected cost, and teardown procedure. Fixed-cost infrastructure
requires explicit approval.

The initial architecture deliberately excludes NAT Gateway, VPC-attached
Lambda functions, API Gateway caching, WAF, custom domains, provisioned
concurrency, and customer-managed KMS keys.

## Logging safety

Application logs use stable event names and an allow-list of operational fields.
Do not log authorization values, secrets, full request bodies, delivery addresses,
or raw third-party responses. Request and correlation IDs provide traceability
without requiring sensitive payloads.

## Repository layout

```text
.
|-- PLAN.md                  Project roadmap and progress
|-- README.md                Project introduction
|-- docs/
|   |-- decisions/           Architecture decision records
|   `-- specifications/      Business and API specifications
|-- src/                     Application source code
`-- tests/                   Automated tests
```

Directories will gain content only when their corresponding plan step begins.

## Local development

Install the exact dependency versions recorded in `package-lock.json`:

```bash
npm ci
```

Run every local quality check:

```bash
npm run check
```

The same checks, plus DynamoDB Local integration and deployable SAM validation,
run in the
[pull-request workflow](docs/infrastructure/pull-request-checks.md).

The exact short-lived GitHub-to-AWS identity boundary, local bootstrap template,
and explicit approval gate are recorded in the
[GitHub OIDC review](docs/infrastructure/github-oidc-review.md).

The individual commands are:

- `npm run format:check` — verify formatting
- `npm run lint` — run ESLint
- `npm run typecheck` — type-check without emitting files
- `npm test` — run the unit tests once
- `npm run test:watch` — rerun relevant tests while developing
- `npm run test:coverage` — run tests and enforce coverage thresholds
- `npm run test:delivery-worker` — test SQS validation, idempotency, and partial failures
- `npm run test:integration` — bootstrap DynamoDB Local and test its repository
- `npm run test:mock-vendor` — exercise every mock provider response mode
- `npm run test:vendor-client` — verify provider error and retry classification
- `npm run test:webhook` — verify webhook signatures, replay protection, and status changes
- `npm run sam:validate` — lint and validate the local SAM template
- `npm run sam:build` — bundle the Lambda handler for the Node.js 24 runtime
- `npm run sam:cloud:validate` — lint the deployable cloud template without deploying
- `npm run sam:cloud:build` — bundle the deployable synchronous Lambda functions locally
- `npm run oidc:validate` — verify and lint the local GitHub OIDC bootstrap
- `npm run test:sam` — exercise every current API route through local SAM HTTP
- `npm run test:stream-publisher` — map saved DynamoDB Stream records and test partial failures
- `npm run test:terminal-retry-campaign` — verify the guarded terminal/retry AWS harness locally
- `npm run build` — compile TypeScript into `dist/`
- `npm run format` — apply Prettier formatting

## DynamoDB Local

DynamoDB Local runs in Docker at `http://localhost:8000`. Its data is stored in
the project-scoped `serverless-order-integration_dynamodb-data` Docker volume.
No requests are sent to an AWS account and no AWS charges are incurred.

The service runs as root inside this development-only container because fresh
named volumes are root-owned. The port remains bound to loopback and this
Compose service is not part of the deployable AWS infrastructure.

Start the service in the background:

```bash
npm run dynamodb:start
```

The start command waits until the local HTTP endpoint is healthy before it
returns.

Create the local table and its indexes. This command is safe to repeat:

```bash
npm run dynamodb:bootstrap
```

The key design and supported queries are documented in the
[DynamoDB access patterns](docs/specifications/dynamodb-access-patterns.md).

Verify the local endpoint with deliberately fake credentials:

```bash
npm run dynamodb:verify
```

The verification command supplies the dummy values required by DynamoDB Local
and pins the endpoint to `127.0.0.1`; it does not read either configured AWS
profile.

Stop the container while preserving local data:

```bash
npm run dynamodb:stop
```

Reset the service and permanently delete its local database volume:

```bash
npm run dynamodb:reset
```

The reset command affects only resources belonging to this Compose project.
Always include the local `--endpoint-url` when using the AWS CLI here; omitting
it would select the real AWS DynamoDB endpoint instead.

## Local API with AWS SAM

The SAM template runs the current REST operations and signed vendor webhook
through Node.js 24 Lambda containers:

- `POST /orders`
- `GET /orders`
- `GET /orders/{orderId}`
- `PATCH /orders/{orderId}/status`
- `POST /webhooks/vendor`

Start DynamoDB Local, build the Lambda bundle, and serve the API at
`http://127.0.0.1:3000`:

```bash
npm run sam:local
```

Stop the API with `Ctrl+C`. DynamoDB Local remains available so its data can be
reused; stop it separately with `npm run dynamodb:stop` when finished.

Run the repeatable smoke test instead when you want a non-interactive check:

```bash
npm run test:sam
```

The smoke test creates an order, retrieves it, lists orders, reconciles provider
acceptance, and sends the same signed delivery webhook twice. It verifies that
the duplicate changes the order only once. The script starts and stops the SAM
API automatically and writes local runtime output under the ignored
`.aws-sam/` directory.

SAM containers join the project Compose network and reach DynamoDB at
`http://dynamodb-local:8000`. The checked-in
[SAM local fixture](sam-local-fixture.json) contains only an explicit DynamoDB
Local endpoint and known local-only signing values; it is test data, not a
configuration file for real credentials. The Lambda adapters use fixed dummy
credentials whenever that endpoint is present, so they do not load an AWS
profile or contact the DynamoDB service in an AWS account.

Local SAM does not reproduce the planned API Gateway JWT authorizer. It uses the
fixed `mrc_demo` learning tenant and permits the operator route locally. Cognito,
JWT validation, operator claims, IAM, and the deployable DynamoDB resource are
part of the reviewed cloud-infrastructure phase; this local template must not
be deployed as the cloud stack.

## Deployable cloud template

[template.cloud.yaml](template.cloud.yaml) defines the deployable AWS stack:
HTTP API, Cognito JWT authorization, application Lambdas, DynamoDB and its
Stream, SNS, SQS failure paths, least-privilege IAM policies, bounded event
sources, throttling inputs, and short-retention log groups. It is separate from
the local SAM template.

Several cost-control values deliberately have no defaults and must be agreed
during the pre-deployment review. Building or validating this template does not
contact AWS or create resources. See the
[synchronous cloud slice](docs/infrastructure/synchronous-cloud-slice.md) for
the HTTP/data resource inventory and the
[asynchronous cloud slice](docs/infrastructure/asynchronous-cloud-slice.md) for
streaming, messaging, retry, and DLQ details. The
[pre-deployment cost review](docs/infrastructure/pre-deployment-cost-review.md)
records the complete resource inventory, recommended deployment parameters,
bounded smoke-test estimate, and approval gates. The
[development deployment record](docs/infrastructure/development-deployment.md)
captures the non-secret stack outputs and deployment verification. The
[development AWS teardown review](docs/infrastructure/teardown-review.md)
records the exact deletion scope, ordering, safeguards, and approval boundary.
The
[cloud smoke-test record](docs/infrastructure/cloud-smoke-tests.md) captures the
real service-boundary results, defects found, retry/DLQ recovery, and final
cost evidence. The
[error and event-journey test matrix](docs/testing/error-and-event-journey-matrix.md)
tracks every stable error contract and its completed evidence. The
[terminal failure and operator-retry campaign](docs/testing/terminal-retry-campaign.md)
records the final public-error, event-journey, duplicate, webhook, and native
throttling results.

The editable [full AWS cloud stack diagram](docs/architecture/full-cloud-stack.drawio)
shows both paths and their security, observability, and failure boundaries.

## Local mock delivery vendor

Build and start the mock provider on `http://127.0.0.1:4000`:

```bash
npm run mock-vendor:start
```

The default `local-development-token` is deliberately local test data. Override
it with `MOCK_VENDOR_TOKEN` when practising configuration, and use
`MOCK_VENDOR_PORT` to select another port. Set `MOCK_VENDOR_SCENARIO` to
`success`, `timeout`, `rate-limit`, `server-error`, `request-rejected`, or
`malformed-response` to choose the default response mode for an unmodified
vendor client. Invalid scenario values prevent startup. Stop the server with
`Ctrl+C`.

The provider contract documents `POST /deliveries`, idempotency, authentication,
and the deterministic success, timeout, `429`, `500`, and malformed-response
modes. Run all of its HTTP contract tests without starting the server manually:

```bash
npm run test:mock-vendor
```

See the [mock delivery provider contract](docs/specifications/mock-delivery-provider.md)
for request examples and scenario controls. The server is local-only and does
not contact AWS or incur AWS cost.

## Working agreement

- Complete and review one numbered plan step at a time.
- Explain what changed, how it was verified, and whether it affects AWS cost.
- Prefer local tests over cloud iterations.
- Never commit credentials, secrets, or local environment files.
- Do not deploy AWS resources before an explicit cost review.
