# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The implementation, AWS integration exercises, and final project documentation
are complete. The project is in **Phase 7.5: interview walkthrough
preparation**.

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

## Cost controls

The project ceiling is **$5 USD per month**. The account also has a `$1`
`My Zero-Spend Budget`, and the cloud-lab supervisor refuses to deploy when its
reported actual or forecast spend reaches that threshold. An AWS Budget is an
alert and deployment gate here, not a hard service-side spending limit.

The reviewed conservative estimate for one bounded deployment and smoke-test
session is less than `$0.05`, without depending on every Free Tier allowance.
Billing records can arrive late, so a `$0.00` Budget view immediately after a
lab is evidence of the current billing view rather than proof that no usage
charge will arrive.

The main cost controls are:

- local-first development and tests, which use no AWS resources;
- a short-lived application stack with verified teardown after each cloud lab;
- API throttling at one request per second with a burst of two;
- DynamoDB on-demand capacity with maximum read and write request controls;
- two-record worker batches, two concurrent workers, and bounded Lambda and
  vendor timeouts;
- one-day log and queue-message retention;
- AWS-managed encryption without customer-managed KMS request charges;
- no continuously running compute, database instance, or provisioned
  concurrency;
- a lifecycle-managed deployment bucket with a 50 MB project artifact cap; and
- an explicit account, Region, stack name, and AWS CLI profile in every cloud
  operation.

The architecture deliberately excludes NAT Gateway, VPC-attached Lambda
functions, VPC endpoints, load balancers, API Gateway caching, WAF, custom
domains, provisioned DynamoDB capacity, DAX, global tables, provisioned event
pollers, customer-managed KMS keys, Secrets Manager, paid custom metrics,
alarms, dashboards, tracing, and synthetic canaries.

The empty deployment bucket, GitHub OIDC provider, two deployment roles, and
Budget remain between sessions and have an expected recurring cost of `$0` at
the current learning scale. The detailed resource calculations, assumptions,
and teardown gates are in the
[pre-deployment cost review](docs/infrastructure/pre-deployment-cost-review.md)
and
[controlled deployment workflow](docs/infrastructure/deployment-workflows.md).
Any future fixed-cost service, higher limit, longer retention, or materially
larger test requires a new cost review.

## Security decisions

- **Client authentication:** API Gateway verifies Cognito access-token
  signature, issuer, audience, and expiry before invoking authenticated order
  routes.
- **Authorization:** the MVP maps approved test identities to the fixed
  `mrc_demo` merchant; status changes additionally require the Cognito
  `operators` group.
- **Vendor webhooks:** the public webhook verifies an HMAC over the timestamp
  and raw request body using constant-time comparison, rejects requests outside
  the five-minute replay window, and durably deduplicates provider event IDs.
- **Deployment identity:** GitHub Actions obtains short-lived AWS credentials
  through an immutable, wildcard-free OIDC trust. GitHub can operate only the
  development application stack and pass only the dedicated CloudFormation
  execution role.
- **Runtime IAM:** each Lambda role is scoped to the table, stream, topic, or
  queue operations that function needs. Provisioning permissions are isolated
  in the CloudFormation role rather than granted to GitHub or application
  code.
- **Secrets:** application secrets are stored in the protected GitHub
  `development` environment, passed as `NoEcho` CloudFormation parameters, and
  handled through permission-limited temporary files. They are never committed
  or placed in GitHub as long-lived AWS access keys.
- **Encryption and exposure:** DynamoDB, SQS, and deployment artifacts use
  service-managed encryption. The API has conservative throttling, while the
  temporary vendor boundary requires a bearer token over HTTPS.

The complete identity and permission analysis is in the
[GitHub OIDC review](docs/infrastructure/github-oidc-review.md). Authentication
and infrastructure choices are recorded in the
[architecture decisions](docs/decisions/README.md).

### Logging safety

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
|-- .github/workflows/       Pull-request checks and controlled cloud deployment
|-- docs/
|   |-- architecture/        Editable full-stack diagram
|   |-- decisions/           Architecture decision records
|   |-- infrastructure/      Cost, IAM, deployment, test, and teardown reviews
|   |-- operations/          Observability, query, incident, and postmortem guides
|   |-- specifications/      Business, API, domain, event, data, and vendor contracts
|   `-- testing/             Error matrix and repeatable failure-drill procedures
|-- infrastructure/          Persistent GitHub OIDC and deployment-role bootstrap
|-- scripts/
|   |-- ci/                  Change-set, smoke-test, and teardown controls
|   |-- cloud/               Learning-lab supervisor and cloud failure drills
|   |-- dynamodb/            DynamoDB Local schema and bootstrap
|   |-- mock-vendor/         Local provider process entry point
|   `-- sam/                 Local SAM smoke journey
|-- src/
|   |-- application/         Use cases, ports, validation, and reconciliation
|   |-- domain/              Order model and status-transition rules
|   |-- events/              Versioned domain and AWS-event mapping
|   |-- http/                Transport handlers and HTTP contracts
|   |-- infrastructure/      DynamoDB and in-memory repository adapters
|   |-- integrations/        Delivery-provider contract and HTTP client
|   |-- lambda/              Four deployable Lambda entry points
|   |-- mock-vendor/         Deterministic delivery-provider implementation
|   `-- observability/       Structured logging and request identifiers
|-- tests/                   Unit, contract, integration, handler, and script tests
|-- compose.yaml             Loopback-only DynamoDB Local service
|-- template.yaml            Local SAM API template; never deployed
|-- template.cloud.yaml      Complete deployable application stack
|-- PLAN.md                  Roadmap, completed evidence, and definition of done
`-- package.json             Supported toolchain and executable project commands
```

Generated output under `dist/`, `coverage/`, and `.aws-sam/`, local DynamoDB
data, and `.env.development.local` are intentionally excluded from source
control.

## Documentation map

| Question | Start here |
| --- | --- |
| What problem and API does the system implement? | [Business requirements](docs/specifications/business-requirements.md), [OpenAPI contract](docs/specifications/openapi.yaml), and [domain model](docs/specifications/domain-model.md) |
| How are data and events modeled? | [DynamoDB access patterns](docs/specifications/dynamodb-access-patterns.md), [domain events](docs/specifications/domain-events.md), and [event JSON Schema](docs/specifications/domain-event.schema.json) |
| Why were these AWS services selected? | [Architecture decision index](docs/decisions/README.md) and [full-stack diagram](docs/architecture/full-cloud-stack.drawio) |
| How do I run it locally? | [Local quick start](#local-quick-start), [DynamoDB Local](#dynamodb-local), [local SAM API](#local-api-with-aws-sam), and [mock-vendor contract](docs/specifications/mock-delivery-provider.md) |
| How is AWS deployment controlled and secured? | [Deployment workflow](docs/infrastructure/deployment-workflows.md), [OIDC review](docs/infrastructure/github-oidc-review.md), and [cost review](docs/infrastructure/pre-deployment-cost-review.md) |
| What proves the real cloud wiring and failures? | [Cloud smoke-test record](docs/infrastructure/cloud-smoke-tests.md), [error and event-journey matrix](docs/testing/error-and-event-journey-matrix.md), and [failure-drill inventory](docs/testing/phase-7-failure-drill-inventory.md) |
| How do I investigate and recover an incident? | [Observability inventory](docs/operations/observability-inventory.md), [CloudWatch query cookbook](docs/operations/cloudwatch-query-cookbook.md), [incident runbook](docs/operations/delivery-worker-incident-runbook.md), and [exercise postmortem](docs/operations/postmortem-2026-07-29-vendor-rate-limit.md) |
| How do I present the system in an interview? | [Short system-design walkthrough](docs/interview/system-design-overview.md) and [synchronous API and data-integrity deep dive](docs/interview/synchronous-api-and-data-integrity.md) |
| What remains to be done? | [Project plan](PLAN.md) |

## Prerequisites

The local workflow has been verified on Linux and uses:

| Tool | Required version or capability | Used for |
| --- | --- | --- |
| Git | A current version | Cloning and source-control workflows |
| Node.js | `24.x` | Application, tests, and build scripts |
| npm | `11.x` | Locked dependency installation and project commands |
| Docker | Docker Engine with Compose v2 | DynamoDB Local and SAM Lambda containers |
| AWS CLI | Version 2 | Creating and inspecting the local DynamoDB table |
| AWS SAM CLI | A current version supporting Node.js 24 | Building and running Lambda locally |
| Bash and curl | Standard Linux versions | Local orchestration and HTTP smoke tests |

Confirm the principal versions before setup:

```bash
node --version
npm --version
docker --version
docker compose version
aws --version
sam --version
```

An AWS account and AWS credentials are **not required** for local development.
The DynamoDB scripts provide deliberately fake credentials and explicitly use
the loopback-only local endpoint. Docker must be running before starting
DynamoDB Local or AWS SAM.

## Local quick start

Clone the repository and install the exact dependency versions from
`package-lock.json`:

```bash
git clone https://github.com/pingusportro-eng/serverless-order-integration.git
cd serverless-order-integration
npm ci
```

Run the non-interactive local API journey:

```bash
npm run test:sam
```

This starts DynamoDB Local, creates its table, builds the Lambda code, starts
the API on an available loopback port, and verifies order creation, retrieval,
listing, status reconciliation, and a signed duplicate-safe webhook. It stops
the temporary API automatically but leaves DynamoDB Local running so its data
can be reused.

For an interactive API instead, run:

```bash
npm run sam:local
```

After the ready message appears, verify it from a second terminal:

```bash
curl --silent --fail 'http://127.0.0.1:3000/orders?limit=1'
```

Stop the SAM API with `Ctrl+C`, then stop the local database:

```bash
npm run dynamodb:stop
```

This quick start creates no AWS resources and incurs no AWS cost. The detailed
DynamoDB, SAM, test, and mock-vendor workflows follow.

## Local quality checks

Run every local quality check:

```bash
npm run check
```

The same checks, plus DynamoDB Local integration and deployable SAM validation,
run in the
[pull-request workflow](docs/infrastructure/pull-request-checks.md).

The exact short-lived GitHub-to-AWS identity boundary, local bootstrap template,
and protected environment gate are recorded in the
[GitHub OIDC review](docs/infrastructure/github-oidc-review.md).

The individual commands are:

- `npm run format:check` — verify formatting
- `npm run lint` — run ESLint
- `npm run lint:fix` — apply safe ESLint fixes
- `npm run typecheck` — type-check without emitting files
- `npm test` — run the unit tests once
- `npm run test:watch` — rerun relevant tests while developing
- `npm run test:coverage` — run tests and enforce coverage thresholds
- `npm run test:contracts` — verify the versioned domain-event contract
- `npm run test:delivery-worker` — test SQS validation, idempotency, and partial failures
- `npm run test:integration` — bootstrap DynamoDB Local and test its repository
- `npm run test:mock-vendor` — exercise every mock provider response mode
- `npm run test:vendor-client` — verify provider error and retry classification
- `npm run test:webhook` — verify webhook signatures, replay protection, and status changes
- `npm run test:cloud-drill` — test the SNS subscription-DLQ drill harness locally
- `npm run test:publisher-failure-drill` — test publisher poison-record recovery locally
- `npm run test:vendor-rate-limit-drill` — test worker retry, DLQ, and redrive orchestration locally
- `npm run sam:validate` — lint and validate the local SAM template
- `npm run sam:build` — bundle the local Lambda handlers for the Node.js 24 runtime
- `npm run sam:cloud:validate` — lint the deployable cloud template without deploying
- `npm run sam:cloud:build` — bundle all deployable Lambda functions locally
- `npm run deployment:validate` — verify deployment controls without contacting AWS
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

Local SAM does not reproduce the deployed API Gateway JWT authorizer. It uses
the fixed `mrc_demo` learning tenant and permits the operator route locally.
Cognito, JWT validation, operator claims, IAM, and the AWS DynamoDB resource
exist only in the reviewed cloud template; the local template must not be
deployed as the cloud stack.

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

The cloud lab is deliberately project-specific. It expects:

- AWS CLI profile `pingusportro-admin` to resolve to account `454921778743`;
- Region `eu-central-1`;
- the `My Zero-Spend Budget` actual and forecast values to remain below its
  `$1` alert threshold;
- the reviewed GitHub OIDC and artifact-bucket bootstrap to exist;
- GitHub CLI authentication for an account that can dispatch the repository
  workflow, update development-environment secrets, and approve that
  environment;
- `cloudflared`, `curl`, `dig`, `gh`, `git`, Node.js, npm, and the AWS CLI;
- a clean `master` branch whose current commit is pushed to `origin/master`;
  and
- `.env.development.local` with mode `0600` and a
  `VENDOR_AUTH_TOKEN` containing at least 32 characters.

Authenticate the GitHub CLI once if necessary:

```bash
gh auth login
gh auth status
```

Start the complete lab from the repository root:

```bash
npm run cloud:deploy
```

The command performs its preflight checks before creating the temporary cloud
lab. It then:

1. starts or safely reuses a lab-owned mock vendor on a free loopback port;
2. exposes it through a temporary Cloudflare Quick Tunnel;
3. generates the temporary webhook signing secret and synchronizes it and the
   vendor token to the GitHub `development` environment without printing them;
4. dispatches and monitors the GitHub `prepare` operation;
5. records the protected-environment approval through the authenticated GitHub
   account;
6. prints the exact non-executing CloudFormation change set;
7. validates and automatically dispatches `execute` for that exact change set;
8. creates a temporary Cognito operator and local authorization header;
9. reconnects the mock vendor to the deployed signed-webhook endpoint; and
10. prints `AWS LAB READY` with the API and vendor endpoints.

There is no later `deploy` prompt. Prepare and execute remain separate GitHub
operations with an exact change-set guard, but the authenticated supervisor
advances them automatically. The deployment can therefore be left unattended
until `AWS LAB READY` appears, provided the terminal, computer, and network
remain active.

The supervisor then remains in the foreground as a live, safely redacted vendor
exchange console. From a second terminal, submit a generated synthetic order:

```bash
npm run cloud:order:create
```

Each invocation generates a new merchant order ID, idempotency key, and
correlation ID; it prints the API response and the two identifiers needed for
CloudWatch investigation. The supervisor console shows the worker-to-vendor
request, vendor response, and signed vendor-to-API webhook exchanges without
printing secrets or order addresses.

Inspect the lab supervisor, stack, API, vendor, and tunnel state without
changing them:

```bash
npm run cloud:status
```

### Teardown and recovery

Press `Ctrl+C` once in the original deployment console when the learning
session is finished. This requests teardown; it does not abruptly terminate
the supervisor. The current operation first settles, then the supervisor:

1. dispatches and monitors the GitHub `destroy` operation;
2. verifies that the application stack is absent;
3. verifies that the project deployment-artifact prefix is empty;
4. removes the temporary Cognito user with the stack;
5. stops only the tunnel and mock-vendor processes it owns;
6. deletes its temporary local credentials and signing material; and
7. prints `AWS LAB DESTROYED` with the verified final state.

Wait for that final message before closing the terminal. A second interrupt is
ignored while cleanup is running.

If the terminal, computer, or network disappears before that verification can
finish, run the idempotent recovery command after connectivity returns:

```bash
npm run cloud:destroy
```

If the original supervisor is still active, this command asks it to begin the
same verified teardown and tells the operator to watch the original terminal.
If the supervisor is gone, the command uses the permission-limited recovery
state under `.aws-sam/cloud-lab/` to complete and verify cleanup directly.

Only one supervisor can own the lab at a time. A later run safely reuses healthy
lab-owned processes and matching cloud state, replaces stale owned processes,
and leaves unrelated mock servers untouched. A stable stack is reused only
when its reviewed commit and temporary vendor boundary match; otherwise the
workflow prepares an update. Unsafe CloudFormation states stop deployment and
enter verified teardown instead of being updated blindly.

GitHub Actions receives short-lived AWS credentials through OIDC. Long-lived
AWS access keys are never copied into GitHub. The lab removes the temporary
application stack, but deliberately retains the separately reviewed OIDC roles,
empty deployment bucket, and AWS Budget used by future sessions.

## Local mock delivery vendor

Create the ignored local environment file once and restrict it to the current
Linux user:

```bash
cp .env.example .env.development.local
chmod 600 .env.development.local
```

Replace the placeholder with a `VENDOR_AUTH_TOKEN` containing at least 32
characters. The cloud-lab supervisor synchronizes this value to the GitHub
`development` environment without printing it. Never commit or paste it into
logs or chat. Build and start the mock provider on `http://127.0.0.1:4000`:

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

## Limitations

This is a production-minded learning system, not a production-ready delivery
platform:

- It supports one fixed merchant, `mrc_demo`; it does not derive a tenant from
  a trusted identity claim or provide tenant isolation.
- Cognito direct-user authentication represents synthetic operators, not
  partner machine-to-machine credentials, scopes, federation, or credential
  rotation.
- The delivery provider is a local mock exposed temporarily through a
  third-party Quick Tunnel. Cloud exercises depend on the developer computer
  and network remaining available.
- The cloud supervisor is intentionally bound to one AWS account, Region,
  repository, branch, stack, Budget, and CLI profile.
- API Gateway HTTP API does not provide the REST-API features omitted here,
  including API keys and usage plans, gateway request validation, caching, WAF
  integration, or private endpoints. Request validation therefore runs in
  Lambda.
- The single-region DynamoDB table has no point-in-time recovery, backups,
  cross-region replication, or disaster-recovery design.
- Standard SNS and SQS provide at-least-once delivery without global ordering
  or an exactly-once guarantee. Application idempotency, aggregate versions,
  conditional writes, and delivery-provider submission keys provide the safety model.
- One-day log and failure-message retention supports short exercises, not
  compliance archives or long-running incident investigations.
- The stack has structured logs and native service metrics but no custom
  alarms, dashboard, distributed tracing, or automated paging.
- Local SAM and DynamoDB Local cannot prove IAM, Cognito authorization, managed
  retries, service quotas, CloudWatch behavior, or real event-source wiring;
  bounded cloud exercises remain necessary.

## Architectural trade-offs

| Decision | Benefit for this project | Accepted cost or limitation |
| --- | --- | --- |
| API Gateway HTTP API instead of REST API | Lower-cost serverless HTTPS routing with JWT authorization | Fewer API-management and gateway-validation features |
| DynamoDB on-demand | No idle throughput charge or capacity forecasting | Every request is metered; good keys and request bounds still matter |
| DynamoDB Streams, SNS, and SQS | Avoids the database/message dual write and demonstrates fan-out, buffering, retries, and DLQs | More services, IAM, eventual consistency, duplicate delivery, and operational paths |
| Standard messaging instead of FIFO | Simple fan-out and scalable asynchronous delivery | Ordering and deduplication are application responsibilities |
| SAM and CloudFormation | Concise serverless IaC plus local Lambda/API execution | AWS-specific tooling; Terraform remains a useful follow-up exercise |
| Local-first layered tests | Fast feedback and `$0` normal development cost | Managed-service behavior still requires targeted AWS verification |
| GitHub environment secrets instead of Secrets Manager | Avoids three continuously stored paid secrets in this learning stack | Secret rotation and local-file handling are operator responsibilities |
| Temporary Quick Tunnel instead of a hosted vendor | Exercises real outbound HTTPS and webhooks without continuously deployed compute | Learning-only third-party dependency with no availability guarantee |

The detailed alternatives and reconsideration conditions are maintained in the
[architecture decision records](docs/decisions/README.md).

## Working agreement

- Complete and review one numbered plan step at a time.
- Explain what changed, how it was verified, and whether it affects AWS cost.
- Prefer local tests over cloud iterations.
- Never commit credentials, secrets, or local environment files.
- Do not deploy AWS resources before an explicit cost review.
