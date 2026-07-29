# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The implementation and AWS integration exercises are complete. The project is
in **Phase 7.4: final project documentation**, followed by the interview
walkthrough.

The REST API, DynamoDB persistence, asynchronous event path, mock delivery
integration, signed webhook reconciliation, failure queues, observability, and
controlled CI/CD deployment have all been exercised locally and in the
development AWS account. The completed cloud exercises include successful order
delivery, provider failures, bounded retries, DLQ isolation, managed redrive,
and verified teardown.

Pull requests targeting `master` run local quality checks, tests, DynamoDB Local
integration, and SAM validation and build checks without AWS credentials.
Development deployments use short-lived GitHub OIDC credentials, reviewed
CloudFormation change sets, and an automated teardown that verifies the
application resources are absent.

Work is divided into small reviewable steps. See [PLAN.md](PLAN.md) for the
current checklist, architecture, verification criteria, and definition of done.

## Architecture

The deployed system has a synchronous REST boundary and an asynchronous
delivery-integration path:

```text
Client
  |
  v
API Gateway HTTP API -> Orders API Lambda -> DynamoDB
                                                |
                                         DynamoDB Stream
                                                |
                                                v
                                        Publisher Lambda
                                                |
                                                v
                                              SNS
                                                |
                             filtered order events
                                                |
                                                v
                                      Delivery SQS queue
                                                |
                                                v
                                      Delivery Worker Lambda
                                                |
                                                v
                                      Mock delivery vendor
                                                |
                                    signed status webhook
                                                |
                                                v
API Gateway public webhook route -> Webhook Lambda -> DynamoDB
```

The order routes use Cognito JWT authentication; status changes additionally
require the operators group. The public vendor-webhook route uses an HMAC
signature, a five-minute replay window, and durable event deduplication.

DynamoDB Streams captures committed order changes. The publisher converts
those changes into versioned domain events and publishes them to SNS. An SNS
subscription selects `order.created` and
`order.submission_retry_requested` for the Delivery Queue. The delivery worker
calls the vendor with bounded concurrency, an HTTP timeout, and a stable
idempotency key, then records the outcome transactionally.

The failure boundaries are independent: discarded stream records have a
publisher failure queue, failed SNS deliveries have a subscription DLQ, and
messages that exhaust Delivery Queue receives move to the worker DLQ. Lambda
event-source mappings use partial-batch responses so successfully processed
records do not need to be retried with a failed neighbor.

The editable
[full AWS cloud-stack diagram](docs/architecture/full-cloud-stack.drawio)
includes the runtime paths, authentication, IAM, observability, retry behavior,
and all three retained-failure boundaries.

Most development and testing runs locally with AWS SAM, DynamoDB Local, and the
mock vendor. Short-lived cloud labs verify the real AWS service integrations,
IAM permissions, failure behavior, and cleanup.

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

The current signal path, identifier semantics, native AWS signals, and known
successful-trace gaps are recorded in the
[observability inventory](docs/operations/observability-inventory.md).
Practical correlation, order, event, retry, and failure investigations are in
the
[CloudWatch Logs Insights query cookbook](docs/operations/cloudwatch-query-cookbook.md).

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

## Supervised cloud learning lab

The normal repeated-learning path is terminal-driven:

```bash
npm run cloud:deploy
```

This command verifies the fixed AWS account, Region, Budget, repository, clean
pushed commit, local secret-file permissions, and required tools. It starts a
mock vendor on an automatically selected loopback port, starts a temporary
Quick Tunnel, synchronizes the two mock-boundary secrets to the GitHub
`development` environment without printing them, and drives the existing
prepare/execute GitHub Actions workflow.

The exact non-executing CloudFormation change set is printed in the terminal.
Execution still requires typing `deploy`. After deployment, the command creates
one temporary operator identity, prints a usable `POST /orders` command, and
remains in the foreground as a live, safely redacted vendor exchange console.
Use a second terminal to submit one generated synthetic order:

```bash
npm run cloud:order:create
```

Inspect the current local and AWS state without changing it:

```bash
npm run cloud:status
```

The first `Ctrl+C` in the deployment console requests an orderly teardown. The
supervisor waits for any current workflow operation, runs and watches the
GitHub destroy operation, verifies that the application stack and artifact
prefix are absent, stops only its owned tunnel and vendor processes, removes
temporary credentials, and prints the final cleanup status. A second interrupt
is ignored while cleanup is running.

If the terminal, computer, or network disappears before that verification can
finish, recover idempotently with:

```bash
npm run cloud:destroy
```

An existing healthy lab-owned vendor/tunnel is reused. Stale owned processes
are replaced. An unrelated mock server is never killed or reconfigured; the lab
selects another free port. A stable existing application stack is reused only
when both its reviewed commit and live vendor URL match, otherwise the workflow
prepares an update. In-progress operations are allowed to settle, and unsafe
CloudFormation failure states stop deployment and enter verified teardown.

The command requires GitHub CLI authentication once (`gh auth login`). It uses
GitHub OIDC for deployment; it never places long-lived AWS credentials in
GitHub.

## Local mock delivery vendor

Create the ignored local environment file once and restrict it to the current
Linux user:

```bash
cp .env.example .env.development.local
chmod 600 .env.development.local
```

Replace the placeholder with the same `VENDOR_AUTH_TOKEN` configured in the
GitHub `development` environment. Never commit or paste this value into logs or
chat. Build and start the mock provider on `http://127.0.0.1:4000`:

```bash
npm run mock-vendor:start
```

The command requires a token containing at least 32 characters; there is no
default bearer token. Direct test harnesses may provide `MOCK_VENDOR_TOKEN`
instead. Use `MOCK_VENDOR_PORT` to select another port. Set
`MOCK_VENDOR_SCENARIO` to `success`, `timeout`, `rate-limit`, `server-error`,
`request-rejected`, or `malformed-response` to choose the default response mode
for an unmodified vendor client. Invalid scenario values prevent startup. Stop
the server with `Ctrl+C`.

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
