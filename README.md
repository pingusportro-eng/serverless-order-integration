# Serverless Order Integration

A learning project for building and operating a production-minded RESTful API
and asynchronous third-party integration with Node.js, TypeScript, and AWS.

## Status

The project is in **Phase 0: safety and local prerequisites**. There is no
application code or deployed AWS infrastructure yet.

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

## Working agreement

- Complete and review one numbered plan step at a time.
- Explain what changed, how it was verified, and whether it affects AWS cost.
- Prefer local tests over cloud iterations.
- Never commit credentials, secrets, or local environment files.
- Do not deploy AWS resources before an explicit cost review.

