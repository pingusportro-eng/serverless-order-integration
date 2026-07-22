# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The project is in **Phase 3: local REST API and DynamoDB**. The local TypeScript
and DynamoDB development foundations are configured; no AWS infrastructure has
been deployed.

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

The individual commands are:

- `npm run format:check` — verify formatting
- `npm run lint` — run ESLint
- `npm run typecheck` — type-check without emitting files
- `npm test` — run the unit tests once
- `npm run test:watch` — rerun relevant tests while developing
- `npm run test:coverage` — run tests and enforce coverage thresholds
- `npm run test:integration` — bootstrap DynamoDB Local and test its repository
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

## Working agreement

- Complete and review one numbered plan step at a time.
- Explain what changed, how it was verified, and whether it affects AWS cost.
- Prefer local tests over cloud iterations.
- Never commit credentials, secrets, or local environment files.
- Do not deploy AWS resources before an explicit cost review.
