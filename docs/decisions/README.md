# Architecture decision records

This directory contains the important technical decisions made during the
project. Each record describes the context, options considered, decision,
consequences, cost effect, and conditions for reconsideration.

Use sequential names such as `0001-api-gateway-http-api.md`.

## Accepted decisions

- [0001: Use API Gateway HTTP API](0001-use-api-gateway-http-api.md)
- [0002: Use DynamoDB on-demand capacity](0002-use-dynamodb-on-demand.md)
- [0003: Publish order events through DynamoDB Streams, SNS, and SQS](0003-use-streams-sns-and-sqs.md)
- [0004: Use AWS SAM/CloudFormation with local-first testing](0004-use-sam-and-local-first-testing.md)
- [0005: Use Cognito Lite with an HTTP API JWT authorizer](0005-use-cognito-jwt-authentication.md)
