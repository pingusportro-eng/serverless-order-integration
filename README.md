# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The project is in **Phase 2: TypeScript application foundation**. The local
TypeScript toolchain is configured; no AWS infrastructure has been deployed.

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
- `npm run build` — compile TypeScript into `dist/`
- `npm run format` — apply Prettier formatting

## Working agreement

- Complete and review one numbered plan step at a time.
- Explain what changed, how it was verified, and whether it affects AWS cost.
- Prefer local tests over cloud iterations.
- Never commit credentials, secrets, or local environment files.
- Do not deploy AWS resources before an explicit cost review.
