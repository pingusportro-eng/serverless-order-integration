# 0004: Use AWS SAM/CloudFormation with local-first testing

- Status: Accepted
- Date: 2026-07-21

## Context

The project must teach real AWS serverless behavior while keeping cloud cost and
feedback time low. Fully emulating every managed AWS integration locally is not
realistic, but deploying every code change is slow and creates unnecessary
usage.

The interview requirement accepts Terraform or CloudFormation. AWS SAM extends
CloudFormation with concise serverless resources and provides local Lambda and
API Gateway execution through Docker.

Reference: [AWS SAM local testing](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-local-testing.html)

## Decision

Use AWS SAM templates, which transform into CloudFormation, and use a layered
local-first test strategy.

| Layer | Environment | Purpose |
| --- | --- | --- |
| Unit | Node.js process | Domain rules, validation, mapping, retries, and error behavior using fakes. |
| Repository integration | DynamoDB Local container | Real DynamoDB API expressions, conditional writes, and pagination behavior. |
| Handler integration | SAM Lambda containers | Lambda event parsing, response mapping, and runtime compatibility. |
| API integration | `sam local start-api` | Exercise local HTTP routes through API Gateway-like events. |
| Async component | Saved AWS event fixtures | Test DynamoDB Stream and SQS batches, duplicates, and partial failures. |
| Vendor contract | Local mock HTTP server | Test success, timeout, rate limit, server error, and malformed response behavior. |
| Cloud smoke test | Temporary AWS development stack | Verify IAM, triggers, service wiring, retries, DLQ behavior, and real service differences. |

Application dependencies use explicit interfaces. Local configuration points the
AWS SDK at DynamoDB Local; deployed configuration omits the local endpoint and
uses the Lambda execution role.

Local commands must not inherit production resource endpoints accidentally.
Placeholder local credentials and explicit local endpoints will be used where
the AWS SDK requires credentials. `sam deploy`, `sam sync`, and remote commands
are not part of the local development script.

## Alternatives considered

### Develop and test every change in AWS

This provides the highest fidelity but increases feedback time, request/log
costs, and the risk of forgotten environments.

### Emulate the complete AWS stack with LocalStack

LocalStack can emulate several services, but it adds setup and CI complexity and
cannot prove IAM policies or exact managed-service behavior. It is not part of
the baseline; targeted use can be reconsidered if event-flow tests justify it.

### Use Terraform

Terraform is broadly useful and remains a valuable follow-up exercise. SAM is
chosen first because it provides the most direct local Lambda/API workflow and
still produces CloudFormation infrastructure as code.

### Run only a conventional local Node.js web server

This is fast but does not exercise Lambda handler shapes, runtime packaging, or
API Gateway proxy events.

## Consequences

### Positive

- Most feedback is fast, deterministic, and free of AWS charges.
- Domain and adapter separation improves testability and code review.
- SAM exercises the Lambda runtime more closely than a plain Node.js process.
- CloudFormation provides reviewable creation and deletion of the whole stack.

### Trade-offs

- SAM and DynamoDB Local are approximations, not proof of deployed behavior.
- Local tests cannot verify IAM, actual triggers, service quotas, CloudWatch,
  network behavior, or every retry interaction.
- Developers need Docker and SAM CLI.
- Some behavior is tested twice: quickly with fixtures and finally in AWS.

## Cost effect

The normal development loop costs $0 in AWS. Cloud smoke tests happen only after
a resource and cost review, use a small request count, and end with deliberate
stack retention or destruction.

## Reconsider when

Add targeted emulation only when it provides more value than event fixtures.
Consider Terraform as a second implementation after the serverless behavior is
understood, or when a target team standard requires it.

