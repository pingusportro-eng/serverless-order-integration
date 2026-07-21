# 0001: Use API Gateway HTTP API

- Status: Accepted
- Date: 2026-07-21

## Context

The project needs a public HTTPS entry point for a Lambda-based RESTful API and
a provider webhook. It must support bearer-token authorization, remain within a
$5 learning budget, and avoid continuously running infrastructure.

API Gateway offers two RESTful products: REST APIs and HTTP APIs. REST APIs have
more API-management features, while HTTP APIs provide a smaller feature set at a
lower request price. AWS recommends REST APIs when features such as API keys,
per-client throttling, gateway request validation, WAF integration, or private
API endpoints are required. The MVP does not require those features.

Reference: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)

## Decision

Use an API Gateway **HTTP API** with Lambda proxy integrations.

- Client and operator routes use an API Gateway JWT authorizer.
- The webhook route does not use the JWT authorizer. Its Lambda handler verifies
  the HMAC signature over the timestamp and unmodified request body.
- The application validates bodies, parameters, domain rules, and response
  formatting because HTTP APIs do not provide gateway request validation.
- The OpenAPI document remains the source contract even though application code
  performs validation.
- Use the AWS-provided regional hostname during the MVP. Do not create a custom
  domain, cache, WAF, private endpoint, or VPC integration.

## Alternatives considered

### API Gateway REST API

REST API supports request validation, API keys and usage plans, caching, WAF,
private endpoints, execution logs, and other advanced controls. Those features
do not justify its higher request price and extra configuration for this MVP.

### Lambda function URLs

Function URLs are simpler, but they do not demonstrate API Gateway routing, JWT
authorization, throttling, or API lifecycle decisions required by the project.

### Application Load Balancer

An Application Load Balancer has hourly capacity-related charges and is a poor
fit for a small scale-to-zero learning workload.

## Consequences

### Positive

- No idle API server or load balancer is required.
- HTTP APIs provide the routing, Lambda integration, CORS, access logs, and JWT
  authorization needed by the MVP.
- Request pricing is lower than API Gateway REST APIs.
- OpenAPI 3.0 can describe and import the API contract.

### Trade-offs

- Invalid bodies can invoke Lambda before application validation rejects them.
- The MVP cannot use REST-API-only features such as API keys, usage plans,
  gateway request validation, caching, WAF integration, or private endpoints.
- HMAC webhook verification remains application security logic and must use the
  raw body, constant-time comparison, and replay protection.
- HTTP API access logs are useful, but REST API execution logs and X-Ray support
  are not available at the gateway layer.

## Cost effect

HTTP API has no minimum or fixed hourly charge. Charges are request- and
data-transfer-based. At the planned smoke-test volume, expected API Gateway cost
is negligible, but it remains part of every deployment review.

Reference: [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/)

## Reconsider when

Choose REST API if the business requires API keys and usage plans, per-client
quotas, gateway request validation, WAF, a private endpoint, caching, or other
REST-API-only controls.

