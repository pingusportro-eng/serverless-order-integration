# Business requirements

Status: MVP baseline  
Last reviewed: 2026-07-21

## Business context

A commerce platform needs to accept delivery orders from an authorized client,
submit those orders to an external delivery provider, and keep the platform's
view of each order synchronized with provider status updates.

External delivery providers can be slow, temporarily unavailable, rate-limited,
or inconsistent. Accepting an order must therefore not depend on the provider
responding immediately, and a temporary integration failure must not lose the
order.

This project uses a mock delivery provider and synthetic data. Its purpose is to
demonstrate the integration and operational behaviour without processing real
orders, payments, or personal information.

## Desired outcomes

- A client can submit an order once and receive a stable order reference.
- Accidental repeated submissions do not create duplicate orders.
- Accepted orders are delivered to the provider asynchronously.
- Provider status changes are reflected safely in the platform.
- Temporary failures are retried without creating duplicate side effects.
- Support engineers can trace an order and investigate failed integrations.
- The system can be developed locally and verified in AWS within the agreed
  learning budget.

## Actors

| Actor | Responsibility |
| --- | --- |
| API client | Creates orders and reads their current state. |
| Internal operator | Corrects or advances an order when an authorized manual action is required. |
| Delivery provider | Accepts delivery requests and sends later status updates. |
| Support engineer | Investigates delayed, duplicated, or failed processing. |

The learning project may use the same person or test program for several actors,
but their responsibilities must remain distinct in the design.

## Functional requirements

| ID | Requirement |
| --- | --- |
| BR-001 | The system shall accept a valid order submission and assign a stable, unique order reference. |
| BR-002 | The system shall reject invalid order submissions without creating a partial order. |
| BR-003 | Retrying the same submission shall not create more than one order. Conflicting reuse of the same idempotency reference shall be rejected. |
| BR-004 | A client shall be able to retrieve an order by its reference. |
| BR-005 | A client shall be able to list orders in bounded pages rather than loading the complete history at once. |
| BR-006 | An authorized internal operator shall be able to request a valid order status change. Invalid changes shall not alter the order. |
| BR-007 | After an order is accepted, the system shall submit it to the delivery provider asynchronously. The client shall not wait for the provider call to finish. |
| BR-008 | A successful provider submission shall associate the provider's reference with the platform order. |
| BR-009 | Temporary provider failures shall be retried. Repeated processing shall not submit the same logical order more than intended. |
| BR-010 | A permanently unprocessable delivery request shall remain visible for investigation and controlled recovery. |
| BR-011 | The system shall accept authenticated provider webhooks and apply valid status changes to the corresponding order. |
| BR-012 | Duplicate, invalid, expired, or unauthenticated webhooks shall not cause duplicate or unauthorized state changes. |
| BR-013 | The system shall preserve enough context to trace an order across the API, asynchronous processing, provider request, and webhook. |

## Quality and operating requirements

| ID | Requirement |
| --- | --- |
| QR-001 | The synchronous API path shall remain independent of provider latency and temporary provider outages. |
| QR-002 | Message processing shall assume at-least-once delivery and shall be safe when the same message is received repeatedly. |
| QR-003 | Logs shall be structured and correlate activity across components without exposing secrets or sensitive request data. |
| QR-004 | Failed work shall be diagnosable and recoverable without editing production data directly. |
| QR-005 | Access to client, operator, and webhook capabilities shall be restricted according to the actor's responsibility. |
| QR-006 | Infrastructure and deployment changes shall be reproducible and reviewable as code. |
| QR-007 | Most development and automated testing shall run locally without using paid AWS resources. |
| QR-008 | AWS deployments shall remain within the $5 monthly project budget and shall require a cost review first. |
| QR-009 | The initial deployment shall use one AWS region and avoid fixed-cost infrastructure unless separately approved. |

No contractual throughput, latency, availability, recovery-time, or
recovery-point target has been supplied. The project will measure behaviour and
document trade-offs, but it will not invent a business SLA.

## MVP scope

The MVP includes:

- One API client context
- One mock delivery provider
- Order creation, retrieval, paginated listing, and controlled status updates
- Asynchronous delivery submission
- Signed provider status webhooks
- Retry, duplicate protection, failed-message handling, and traceability
- Local development plus short, reviewed AWS integration tests

The MVP excludes:

- A user interface
- Real payments, refunds, or financial settlement
- Real customer, restaurant, or courier personal data
- Production user registration or a real external identity provider
- Multiple merchants, vendors, regions, or vendor-routing rules
- Route optimization, courier tracking, notifications, and analytics
- A production support dashboard or automated business reconciliation

Excluding a production identity provider does not make the deployed test API
public by design. The technical access-control mechanism remains a later
decision.

## Assumptions adopted for the MVP

| ID | Assumption |
| --- | --- |
| A-001 | One logical merchant submits all MVP orders. |
| A-002 | Every accepted order is routed to the same mock provider. |
| A-003 | Order acceptance and provider acceptance are separate outcomes. |
| A-004 | Provider submission and status synchronization are eventually consistent. |
| A-005 | Messaging and webhooks can be delivered more than once. |
| A-006 | Only synthetic, non-sensitive delivery data will be used. |
| A-007 | `eu-central-1` is the single AWS region for the project. |
| A-008 | The whole deployed environment can be removed and recreated from code. |

## Ambiguities to resolve

| ID | Open question | Planned resolution |
| --- | --- | --- |
| Q-001 | Which fields are required to create an order? | Resolved in the [domain model](domain-model.md#order-aggregate). |
| Q-002 | Which statuses and transitions are valid? | Resolved in the [domain state model](domain-model.md#order-status). |
| Q-003 | How long does an idempotency reference remain valid? | Resolved in the [idempotency rules](domain-model.md#create-order-idempotency). |
| Q-004 | How are client and operator calls authenticated? | Resolved by the [Cognito and JWT authorizer decision](../decisions/0005-use-cognito-jwt-authentication.md). |
| Q-005 | What is the provider request, authentication, and rate-limit contract? | Resolved in the [mock delivery provider contract](mock-delivery-provider.md). |
| Q-006 | Which provider failures are temporary versus permanent? | Resolved in the [delivery vendor client policy](vendor-client.md#failure-classification). |
| Q-007 | How long must orders and operational records be retained? | Use environment lifetime for the MVP; revisit before any production claim. |
| Q-008 | What scale and service-level objectives are required? | Measure the learning implementation; a business owner must supply real targets. |

## First vertical slice

The first vertical slice is **create and retrieve one order locally**. It does
not include AWS deployment or provider messaging.

### Acceptance criteria

1. Given a valid synthetic order and a new idempotency reference, one order is
   stored and a stable order reference is returned.
2. The created order can be retrieved by its reference and contains the accepted
   business values.
3. Invalid input creates no order and returns a clear validation failure.
4. Repeating the same request with the same idempotency reference and business
   values returns the original logical order rather than creating another.
5. Reusing the idempotency reference with different business values is rejected
   and leaves the original order unchanged.
6. An unknown order reference produces a clear not-found result.
7. The order remains available after restarting the local application while the
   local database is retained.
8. Logs contain request and order correlation references but no secret or
   sensitive delivery values.
9. Automated tests prove the behaviours above without contacting AWS.

## Change control

This document is the reviewed MVP baseline, not a permanent contract. When an
ambiguity is resolved or a requirement changes, update the relevant requirement,
record the reason, and review its effect on the domain model, API contract,
architecture, tests, and cost.
