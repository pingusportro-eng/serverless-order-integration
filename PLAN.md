# Serverless Order Integration Project Plan

## Goal

Build and operate a small, production-minded order integration system while
practising the AWS and TypeScript skills required for the technical interview.

The project will demonstrate:

- RESTful API design with Node.js and TypeScript
- AWS Lambda, API Gateway, DynamoDB, DynamoDB Streams, SNS, and SQS
- Event-driven architecture, asynchronous messaging, pub/sub, and webhooks
- Third-party API integration and failure handling
- Infrastructure as Code with AWS SAM/CloudFormation
- GitHub Actions and GitHub-to-AWS OIDC
- Testing, observability, debugging, incident response, and code review
- Translating business requirements into technical specifications

## Cost constraint

The monthly AWS budget is **$5 USD**. Learning takes priority over keeping an
environment continuously deployed.

Cost rules:

- Develop and test locally whenever practical.
- Review the resources and estimated cost before every AWS deployment.
- Ask for approval before adding a fixed-cost resource or a resource that could
  realistically threaten the $5 budget.
- Use one AWS region. The proposed region is `eu-central-1`; confirm it before
  the first deployment.
- Use DynamoDB on-demand capacity.
- Do not create a NAT Gateway or place Lambda functions in a VPC.
- Do not enable API Gateway caching, WAF, a custom domain, provisioned
  concurrency, or customer-managed KMS keys without a separate cost review.
- Use AWS-managed encryption and short CloudWatch log retention.
- Tag all deployed resources with the project and environment.
- Keep deployment and destruction automated and documented.
- Keep retained project SAM artifacts below the approved 50 MB cap.
- Run small cloud smoke tests; run larger tests locally.

An AWS Budget is an alert, not a hard spending limit. The architecture and
deployment process are the primary cost controls.

## Target architecture

```text
Client
  |
  v
API Gateway -> Orders API Lambda -> DynamoDB orders table
                                        |
                                        | DynamoDB Stream
                                        v
                                  Publisher Lambda
                                        |
                                        | domain events
                                        v
                                    SNS topic
                     +------------------+------------------+
                     |                                     |
                     | filtered subscription:              | terminal subscription
                     | order.created or                     | delivery failure
                     | order.submission_retry_requested     v
                     v                              SNS subscription DLQ
              Delivery SQS queue ------> Worker DLQ
                                        |
                                        v
                                  Worker Lambda
                                        |
                                        | submit order
                                        v
                               Mock delivery vendor
                                        |
                     +------------------+------------------+
                     |                                     |
                     | synchronous result                  | signed delivery-status
                     v                                     | webhook
              Worker updates order                         v
                     |                            API Gateway webhook route
                     v                                     |
              DynamoDB orders table                        v
                     |                              Webhook Lambda
                     |                                     |
                     +------------------+------------------+
                                        |
                                        v
                              DynamoDB orders table
                                        |
                                        | DynamoDB Stream
                                        v
                                  Publisher Lambda
                                        |
                                        | for example: order.submitted,
                                        | order.submission_failed,
                                        | order.delivered
                                        v
                                    SNS topic
```

## How we will work

- Complete one numbered step, or one tightly related group, at a time.
- Keep every step small enough to review as a single diff.
- At the end of each step, review the files changed and run its verification.
- Do not begin the next step until the current result is accepted.
- Record meaningful architecture decisions in `docs/decisions/`.
- Keep application logic separate from AWS adapters so most tests run locally.
- Mark completed items in this file as the project progresses.

For every step, the review should answer:

1. What changed and why?
2. How was it verified?
3. Did it introduce or change AWS cost?
4. What is the next smallest step?

## Phase 0: Safety and local prerequisites

- [x] **0.1 — Verify local tools**
  - Check Git, Node.js, npm, Docker, AWS CLI, and AWS SAM CLI.
  - Document required versions and installation gaps.
  - Verification: each installed tool reports its version.
  - AWS cost: $0.

  Review recorded on 2026-07-21:

  | Tool | Project requirement | Detected version | Status |
  | --- | --- | --- | --- |
  | Git | Git 2.x | 2.53.0 | Ready |
  | Node.js | Node.js 24.x, matching the Lambda `nodejs24.x` runtime | 24.12.0 | Ready |
  | npm | Version compatible with Node.js 24 | 11.6.2 | Ready |
  | Docker Engine | Working Docker Engine | 29.5.2 | Ready; daemon reachable |
  | Docker Compose | Compose v2 through `docker compose` | 2.3.3 | Ready |
  | AWS CLI | AWS CLI v2 | 2.7.14 | Ready |
  | AWS SAM CLI | Latest stable release | 1.163.0 | Ready |

  AWS SAM CLI was installed for the current user at
  `/home/costel/.local/aws-sam-cli`, with its executable available through the
  existing PATH at `/home/costel/.local/bin/sam`. The installation was verified
  with `sam --version`.

- [x] **0.2 — Establish the repository baseline**
  - Initialize Git if necessary.
  - Add `.gitignore`, `README.md`, and the initial directory structure.
  - Verification: inspect the initial Git diff/status.
  - AWS cost: $0.

- [x] **0.3 — Confirm AWS cost alerts**
  - Retain the existing AWS Zero-Spend Budget instead of creating a second
    budget for now. This provides an earlier warning when usage exceeds Free
    Tier limits.
  - Keep $5 as the project's maximum intended monthly spend and require a cost
    review before every deployment.
  - Verification on 2026-07-21: the AWS Budgets dashboard showed the existing
    budget as healthy with $0 used. Verify its notification recipient again as
    part of the first pre-deployment cost review.
  - AWS cost: $0.

- [x] **0.4 — Verify AWS account safety**
  - Confirm root-user MFA and avoid using root credentials for development.
  - Confirm the selected AWS region and inspect the account for forgotten
    chargeable resources.
  - Verification: record only the results, never credentials or account secrets.
  - AWS cost: $0 unless an existing resource is already generating charges.

  Review recorded on 2026-07-21:

  - Use the explicit local profile `pingusportro-admin` for every project AWS
    command; do not rely on the machine's default profile.
  - The selected project region is `eu-central-1`.
  - The CLI identity is an IAM user, not the root user.
  - Root-user MFA is enabled and the account reports no root access keys.
  - The existing Zero-Spend Budget was confirmed in the selected account.
  - The selected region had no EC2 instances, EBS volumes or snapshots, NAT
    Gateways, Elastic IPs, load balancers, RDS instances or clusters, manual RDS
    snapshots, or active CloudFormation stacks.
  - No AWS resources or account configuration were changed.

## Phase 1: Requirements and API contract

- [x] **1.1 — Write the business requirements**
  - Describe order creation, delivery submission, and status updates.
  - State assumptions and explicitly identify ambiguous requirements.
  - Add acceptance criteria for the first vertical slice.
  - Verification: requirements are understandable without reading source code.
  - AWS cost: $0.

- [x] **1.2 — Define the domain model**
  - Define `Order`, order statuses, allowed transitions, and vendor references.
  - Define the idempotency and duplicate-event rules.
  - Verification: domain examples cover successful and invalid transitions.
  - AWS cost: $0.

- [x] **1.3 — Define the HTTP API**
  - Create an OpenAPI specification for:
    - `POST /orders`
    - `GET /orders/{orderId}`
    - `GET /orders`
    - `PATCH /orders/{orderId}/status`
    - `POST /webhooks/vendor`
  - Define validation, pagination, status codes, and error bodies.
  - Verification: validate the OpenAPI document locally.
  - AWS cost: $0.

- [x] **1.4 — Record initial architecture decisions**
  - Explain HTTP API versus API Gateway REST API.
  - Explain DynamoDB on-demand capacity.
  - Explain DynamoDB Streams, SNS, and SQS responsibilities.
  - Explain the local-first testing strategy.
  - Verification: each decision includes context, choice, and consequences.
  - AWS cost: $0.

## Phase 2: TypeScript application foundation

- [x] **2.1 — Scaffold the Node.js/TypeScript project**
  - Add package scripts, strict TypeScript configuration, linting, and formatting.
  - Keep production dependencies minimal.
  - Verification: type-check and lint pass.
  - AWS cost: $0.

- [x] **2.2 — Add the test foundation**
  - Configure Vitest and coverage reporting.
  - Add one example unit test.
  - Verification: tests and coverage run locally.
  - AWS cost: $0.

- [x] **2.3 — Add HTTP and observability primitives**
  - Add typed responses, consistent errors, request IDs, and structured logs.
  - Ensure sensitive values and full request bodies are not logged.
  - Verification: unit tests cover success and error responses.
  - AWS cost: $0.

## Phase 3: Local REST API and DynamoDB

- [x] **3.1 — Start DynamoDB Local**
  - Add a Docker Compose service using the official DynamoDB Local image.
  - Persist local data in a project-specific Docker volume.
  - Add start, stop, and reset instructions.
  - Verification: DynamoDB Local responds without contacting AWS.
  - AWS cost: $0.

- [x] **3.2 — Create the local table**
  - Add a repeatable table bootstrap command.
  - Document the partition key, indexes, and access patterns first.
  - Verification: the command can create the table from a clean local database.
  - AWS cost: $0.

- [x] **3.3 — Implement the order repository**
  - Add a DynamoDB-backed repository and a fake repository for unit tests.
  - Use conditional writes for order creation and status transitions.
  - Verification: repository integration tests run against DynamoDB Local.
  - AWS cost: $0.

- [x] **3.4 — Implement `POST /orders`**
  - Validate input and require an idempotency key.
  - Prevent duplicate order creation.
  - Verification: unit and local database integration tests pass.
  - AWS cost: $0.

- [x] **3.5 — Implement `GET /orders/{orderId}`**
  - Return the order or the documented not-found response.
  - Verification: unit and integration tests pass.
  - AWS cost: $0.

- [x] **3.6 — Implement paginated `GET /orders`**
  - Use a bounded page size and an opaque continuation token.
  - Do not expose raw internal keys to clients.
  - Verification: pagination tests cover first, middle, and final pages.
  - AWS cost: $0.

- [x] **3.7 — Implement status updates**
  - Enforce valid transitions and optimistic concurrency.
  - Verification: concurrent and invalid-transition tests pass.
  - AWS cost: $0.

- [x] **3.8 — Run the API locally with AWS SAM**
  - Define the local Lambda/API entry points.
  - Connect the SAM containers to DynamoDB Local.
  - Verification: exercise all current routes through local HTTP requests.
  - AWS cost: $0.

## Phase 4: Asynchronous vendor integration

- [x] **4.1 — Define the event contract**
  - Define event ID, type, version, timestamp, correlation ID, and payload.
  - Add compatibility and duplicate-processing rules.
  - Verification: event schema and representative fixtures are validated.
  - AWS cost: $0.

- [x] **4.2 — Build the mock vendor**
  - Implement a local HTTP server for the delivery provider.
  - Support success, timeout, `429`, `500`, and malformed-response scenarios.
  - Verification: automated contract tests exercise each response mode.
  - AWS cost: $0.

- [x] **4.3 — Implement the vendor client**
  - Add timeouts, safe error mapping, and bounded retry rules.
  - Keep retry ownership clear between code, Lambda, and SQS.
  - Verification: tests use the mock vendor and deterministic failures.
  - AWS cost: $0.

- [x] **4.4 — Implement the stream publisher handler**
  - Convert DynamoDB Stream records into versioned domain events.
  - Handle partial batch failures and malformed records.
  - Verification: invoke the handler with saved AWS event fixtures.
  - AWS cost: $0.

- [x] **4.5 — Implement the SQS worker handler**
  - Submit orders to the vendor.
  - Make processing idempotent and return partial batch failures.
  - Verification: test successes, duplicates, transient failures, and poison
    messages using SQS event fixtures.
  - AWS cost: $0.

- [x] **4.6 — Implement the vendor webhook**
  - Verify the HMAC signature and timestamp.
  - Reject replayed requests and invalid status transitions.
  - Verification: test valid, invalid, expired, and duplicate webhooks.
  - AWS cost: $0.

## Phase 5: Cloud infrastructure

- [x] **5.1 — Define the synchronous cloud slice**
  - Define the API Gateway HTTP API, Lambda functions, DynamoDB table, IAM, and
    log retention using AWS SAM/CloudFormation.
  - Use on-demand DynamoDB and AWS-managed encryption.
  - Verification: build and validate the template locally.
  - AWS cost before deployment: $0.

- [x] **5.2 — Define the asynchronous cloud slice**
  - Define the DynamoDB Stream mapping, SNS topic, SQS queue, DLQ, subscriptions,
    and worker Lambda mapping.
  - Configure visibility timeout, redrive, batch size, and least-privilege IAM.
  - Verification: build and validate the template locally.
  - AWS cost before deployment: $0.

- [x] **5.3 — Perform the pre-deployment cost review**
  - List every resource that will be created.
  - Confirm there is no NAT Gateway, paid cache, custom KMS key, or other
    fixed-cost resource.
  - Estimate the cost of the planned smoke tests.
  - Obtain explicit approval to deploy.
  - AWS cost: $0.

- [x] **5.4 — Deploy the development stack**
  - Deploy only the reviewed stack to the confirmed region.
  - Record stack outputs without committing secrets.
  - Verification: inspect CloudFormation and the AWS billing dashboard.
  - Expected AWS cost: within $0–$1 for learning-scale use.

- [x] **5.5 — Run cloud smoke tests**
  - Verify the REST flow, stream publication, SNS-to-SQS delivery, vendor worker,
    webhook, retry, and DLQ behavior.
  - Keep the request count small and record results.
  - Verification: all smoke-test assertions pass or produce a documented defect.
  - Expected AWS cost: negligible at the planned volume.

- [x] **5.6 — Destroy or retain deliberately**
  - Review resources and current spend after the test session.
  - Destroy the stack unless there is a reviewed reason to retain it.
  - Verify that no unexpected resource remains.
  - AWS cost after destruction: $0 from application resources.

## Phase 6: GitHub Actions CI/CD

- [x] **6.1 — Add pull-request checks**
  - Run formatting, linting, type-checking, unit tests, integration tests that can
    run locally, build, and template validation.
  - Verification: intentionally fail and then pass each important check.
  - AWS cost: $0.

- [x] **6.2 — Configure GitHub-to-AWS OIDC**
  - Define a narrowly scoped deployment role and trust policy.
  - Do not store long-lived AWS access keys in GitHub.
  - Verification: inspect the effective trust and permission policies.
  - AWS cost: $0.

- [x] **6.3 — Add controlled deployment and destruction workflows**
  - Require manual invocation or environment approval for AWS changes.
  - Deploy, smoke-test, and expose a separate deliberate destroy action.
  - Approved local design and controls:
    [controlled development deployment workflows](docs/infrastructure/deployment-workflows.md).
  - Verification: run one reviewed end-to-end pipeline.
  - AWS cost: reviewed before running the workflow.

## Phase 7: Operations and interview preparation

- [ ] **7.1 — Add production-minded observability**
  - Confirm structured logs and correlation IDs across HTTP and messages.
  - Use existing service metrics first.
  - Review cost before adding custom metrics or paid alarms.
  - Verification: trace one order through every component.

- [ ] **7.2 — Run failure drills**
  - Exercise vendor timeout, `429`, `500`, duplicate delivery, poison message,
    invalid webhook, and conditional-write conflict scenarios.
  - Verification: capture detection, diagnosis, recovery, and prevention notes.

- [ ] **7.3 — Write an incident runbook and postmortem**
  - Document how to inspect logs, queues, DLQ messages, and failed Lambda calls.
  - Write one concise example incident postmortem with root cause and follow-ups.
  - Verification: follow the runbook from a deliberately introduced failure.

- [ ] **7.4 — Finish the project documentation**
  - Add the final architecture, setup, local workflow, deployment, teardown, cost
    model, security decisions, limitations, and trade-offs to the README.
  - Verification: a new developer can follow the documented workflow.

- [ ] **7.5 — Prepare the interview walkthrough**
  - Prepare a short system-design explanation and a deeper technical walkthrough.
  - Practise questions about scaling, idempotency, retries, consistency, IAM,
    observability, incident response, CI/CD, and cost.
  - Verification: explain every major choice and one credible alternative.

## Definition of done

- The complete API and its dependencies can be exercised locally.
- The AWS stack is fully reproducible and removable through Infrastructure as
  Code.
- Cloud integration tests prove the real service wiring and IAM permissions.
- CI/CD uses short-lived OIDC credentials and controlled deployments.
- Duplicate events and transient vendor failures are handled safely.
- Logs support tracing an order across synchronous and asynchronous boundaries.
- The repository contains an OpenAPI contract, decision records, runbook,
  postmortem, architecture documentation, and cost notes.
- No unexplained AWS resource or recurring charge remains.
- Total AWS spending stays within the agreed $5 monthly budget.

## Next step

Continue **7.1 — Add production-minded observability** by adding the
CloudWatch Logs Insights query cookbook identified in the
[observability inventory](docs/operations/observability-inventory.md).

The safe structured-log improvement is complete locally. Orders API logs always
carry the effective correlation ID. Publisher, worker, and webhook completion
records now carry the safe event, order, version, outcome, and retry context
known at each boundary. A cross-boundary test proves that one correlation ID
selects the successful API, publication, and worker records.

The next documentation-and-test step defines practical correlation, order,
event, retry, and failure queries and validates their parsing against
representative Lambda text-format records. It creates no AWS resources and
costs `$0`. Running queries in CloudWatch, adding custom metrics, alarms,
dashboards or tracing, increasing retention, and deploying the extra success
logs remain separate cost-reviewed decisions.
