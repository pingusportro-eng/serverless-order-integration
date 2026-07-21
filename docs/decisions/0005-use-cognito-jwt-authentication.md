# 0005: Use Cognito Lite with an HTTP API JWT authorizer

- Status: Accepted
- Date: 2026-07-21

## Context

The API contract requires bearer authentication for merchant and operator
routes. The MVP has one merchant, no production identity provider, no user
interface, and a strict cost limit. Building a custom token issuer or validating
JWT signatures in every Lambda would add security risk and application code.

API Gateway HTTP APIs can validate JWT signature, issuer, audience, expiry, and
optional scopes before invoking Lambda. Amazon Cognito can issue compatible
access tokens.

Reference: [API Gateway JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)

## Decision

For the deployed MVP, use:

- One Cognito user pool on the Lite tier
- One public app client without a client secret
- Direct user authentication for a small number of synthetic test users
- An API Gateway HTTP API JWT authorizer configured with the user-pool issuer and
  app-client audience
- Cognito access tokens, not identity tokens, for API authorization
- An `operators` Cognito group for the status-change route

The MVP merchant is fixed to `mrc_demo`. Authentication establishes that a
caller is an approved test client; application authorization maps the merchant
test identity to this fixed tenant. Operator Lambda logic additionally requires
the `operators` group claim. A future multi-tenant implementation must derive or
look up the tenant from a trusted identity claim rather than accept
`merchantId` from the request body.

The provider webhook does not use Cognito. It uses its separate HMAC signature
and replay-protection contract.

Do not enable:

- Cognito machine-to-machine client-credentials grants
- Cognito Plus or advanced security features
- SMS messaging
- A Cognito custom domain or hosted UI
- Social, SAML, or external OIDC federation

Test passwords and tokens must never be committed, logged, placed in command
arguments that are captured in repository scripts, or returned in test output.

## Alternatives considered

### AWS IAM authorization

IAM and SigV4 avoid another identity service and work well for AWS-aware internal
clients. They do not match the existing bearer-token contract or represent a
typical partner-facing API experience as clearly.

### Lambda authorizer with a shared secret

This can support custom machine authentication but introduces custom security
logic, another Lambda invocation path, secret storage, and authorizer caching
decisions.

### Unauthenticated test endpoints

This reduces setup but contradicts the business requirement that merchant and
operator capabilities are restricted.

### Cognito machine-to-machine authorization

Client credentials better represent a POS integration, but Cognito token
requests for machine-to-machine authorization do not have a free tier. It is
outside this cost-constrained MVP.

## Consequences

### Positive

- API Gateway rejects invalid tokens before invoking business Lambdas.
- The project demonstrates JWT issuer, audience, expiry, claims, and group-based
  authorization.
- No password database or JWT cryptography is implemented in application code.
- The OpenAPI bearer-token contract remains accurate.

### Trade-offs

- Cognito adds resources and account configuration to understand and operate.
- Direct user authentication represents a test user, not true machine-to-machine
  partner authentication.
- Lambda code must still enforce tenant mapping and operator group rules; token
  validity alone is not sufficient authorization.
- Local tests must inject verified synthetic claims because the local SAM server
  is not the real Cognito/JWT integration.

## Cost effect

Cognito Lite and Essentials currently include 10,000 directly signing-in monthly
active users per month in the ongoing free tier. The MVP uses only a few test
users and is expected to cost $0. Machine-to-machine token requests, advanced
features, messaging, and optional integrations can introduce charges and are
explicitly excluded.

Reference: [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/)

## Reconsider when

Replace this test-user model when real partner systems require machine identity,
credential rotation, per-client scopes, or federation. Compare the actual
identity provider, Cognito machine-to-machine pricing, IAM/SigV4, and a dedicated
authorization service at that point.

