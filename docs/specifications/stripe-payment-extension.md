# Stripe payment extension

Status: Reviewed; implementation has not started  
Last reviewed: 2026-08-05

## Purpose

Extend the completed synthetic order-delivery project with one Stripe Sandbox
payment journey. The extension teaches PaymentIntents, external API
idempotency, signed webhooks, asynchronous fulfilment, reconciliation, and a
small React client without processing real money or storing card details.

The central invariant is:

> An order that has not reached verified Stripe payment success must never be
> submitted to the delivery provider.

The existing order-delivery MVP remains the baseline. This document is the
reviewed contract for the next implementation slices.

## Reviewed decisions

| Area | Decision |
| --- | --- |
| Payment ownership | One embedded payment value object in the existing order item. |
| Stripe identity | One reusable PaymentIntent per order in the first slice. |
| Creation boundary | PaymentIntent creation is synchronous; payment completion and fulfilment are asynchronous. |
| Webhook boundary | A dedicated Stripe webhook Lambda handles a public API Gateway route. |
| Authority | A signed event is a notification; the handler retrieves the PaymentIntent's current state from Stripe before applying it. |
| Payment methods | Stripe Sandbox cards only, with automatic capture. |
| Delivery handoff | `order.ready_for_submission`, not `order.created`, reaches the delivery queue. |
| Secrets | Local ignored files and AWS SSM Standard `SecureString` parameters using `alias/aws/ssm`. |
| Browser authentication | Cognito classic hosted UI with Authorization Code and PKCE in the cloud; an explicit local bypass for `mrc_demo`. |
| UI | A separate React and TypeScript application under `ui/`, served on `localhost:3002`. |
| Local feedback | One `local:lab` command exercises the application locally without deploying AWS resources. |
| Cloud webhooks | The cloud lab temporarily registers and later deletes its Stripe Sandbox webhook endpoint. |
| Recovery | Stripe retries transient webhook failures; an operator command reconciles deliveries missed beyond that window. |

## Bounded scope

The first payment slice includes:

- one Stripe PaymentIntent for one synthetic order;
- one currency and amount derived exclusively from the stored order;
- Stripe PaymentIntents, Stripe.js, and the React Payment Element;
- successful, declined, 3D Secure, and processing test scenarios;
- a dedicated signed Stripe webhook;
- duplicate and out-of-order event handling;
- conditional DynamoDB transactions;
- a local React learning console;
- a fast local lab using Stripe Sandbox; and
- one separately approved, bounded AWS exercise.

It excludes:

- live-mode keys, real money, and load testing;
- multiple PaymentIntents for one order;
- subscriptions, invoices, Connect, saved cards, refunds, disputes, tax,
  discounts, and currency conversion;
- manual capture and delayed bank-payment methods;
- customer-initiated PaymentIntent cancellation or replacement;
- a product catalogue, basket, customer profile, or production storefront;
- storing card numbers, CVCs, or raw payment-method data;
- production PCI-compliance, accounting, availability, or disaster-recovery
  claims; and
- public frontend hosting.

## End-to-end journey

```text
Authenticated client
  -> POST /orders
  -> DynamoDB transaction stores the order
       order.status = AWAITING_PAYMENT
       order.payment.status = NOT_STARTED
  <- 201 with the order representation

Authenticated client
  -> POST /orders/{orderId}/payment-intents
  -> server reloads the order and derives amount + currency
  -> Stripe creates or replays the order's PaymentIntent
  -> DynamoDB transaction records the PaymentIntent and lookup mapping
  <- clientSecret returned only after the mapping is durable

Browser
  -> Stripe Payment Element confirms payment directly with Stripe

Stripe
  -> POST /webhooks/stripe
  -> dedicated Lambda verifies the signature over the exact raw body
  -> Lambda retrieves the current PaymentIntent from Stripe
  -> DynamoDB transaction deduplicates the event and updates the order

payment_intent.succeeded
  -> payment.status = SUCCEEDED
  -> order.status = PENDING_SUBMISSION
  -> DynamoDB Stream
  -> publisher Lambda emits order.ready_for_submission
  -> SNS delivery subscription
  -> delivery SQS
  -> delivery worker
  -> delivery provider
```

The browser confirmation result is never authoritative for fulfilment. Only the
deduplicated processing of a verified Stripe event can make the order ready for
submission.

## Domain model

### Order transitions

Add `AWAITING_PAYMENT` before the existing delivery lifecycle:

| Current state | Next state | Authorized source | Rule |
| --- | --- | --- | --- |
| New | `AWAITING_PAYMENT` | Create-order command | The order and its embedded initial payment state commit together. |
| `AWAITING_PAYMENT` | `PENDING_SUBMISSION` | Stripe webhook | The retrieved PaymentIntent is `succeeded` and its identity, merchant, order, amount, currency, and capture mode match. |
| `AWAITING_PAYMENT` | `CANCELLED` | Stripe webhook or operator reconciliation | The one PaymentIntent is terminally canceled; the first slice does not replace it. |
| `PENDING_SUBMISSION` | Existing delivery states | Existing delivery workflow | Existing submission and delivery transition rules continue unchanged. |

`order.created` remains a domain fact, but the delivery subscription ignores
it. The order must first make the explicit payment-gated transition.

### Embedded payment value

The order item contains one value object:

| Field | Rule |
| --- | --- |
| `status` | One of the reviewed payment states below. |
| `amount` | A snapshot of the server-calculated order total. |
| `stripePaymentIntentId` | Absent before creation; immutable after it is recorded. |
| `stripeCreationKey` | Stable server-derived key reused for ambiguous Stripe creation retries. |
| `lastFailure` | Optional safe reason code and occurrence time; never raw card or payment-method data. |
| `createdAt` / `updatedAt` | UTC lifecycle timestamps. |

The payment has no separate platform identifier: in this one-payment model, the
order ID defines its ownership and lifetime. A separate payment aggregate is a
future option only if multiple intents, refunds, disputes, or accounting
workflows require independent access patterns.

Reviewed payment states:

| Status | Meaning |
| --- | --- |
| `NOT_STARTED` | No Stripe PaymentIntent is durably mapped. |
| `REQUIRES_PAYMENT_METHOD` | Stripe needs valid payment details; a decline returns here with `lastFailure`. |
| `REQUIRES_CONFIRMATION` | The PaymentIntent has a method and awaits confirmation. |
| `REQUIRES_ACTION` | Customer action such as 3D Secure authentication is required. |
| `PROCESSING` | Stripe has not produced a final outcome. |
| `SUCCEEDED` | Stripe has completed payment and fulfilment may begin. |
| `CANCELLED` | The one PaymentIntent is terminally canceled and cannot be reused. |

There is no generic terminal `FAILED` state for a card decline. A declined
attempt returns the reusable PaymentIntent to `REQUIRES_PAYMENT_METHOD` and
records a safe failure summary.

### PaymentIntent lookup item

The existing DynamoDB table also contains a small lookup item:

```text
STRIPE_PAYMENT_INTENT#pi_...
  -> merchantId
  -> orderId
  -> createdAt
```

It resolves a Stripe webhook to its order without scanning the table. The
PaymentIntent ID is stored both in this mapping and in the embedded order value;
the transaction either commits both representations or neither.

### Processed Stripe event marker

Stripe event deduplication reuses the existing processed-event item pattern:

```text
consumerName = stripe-webhook
eventId      = evt_...
payloadDigest
outcome      = APPLIED | IGNORED | RECONCILIATION_REQUIRED
```

A permanent mismatch may add a safe reason code, PaymentIntent ID, and safely
known order ID. It never stores card details, a client secret, or a full Stripe
payload.

## HTTP contracts

### Create order

`POST /orders` retains its existing authentication and idempotency contract.
Its successful representation now has:

```text
order.status = AWAITING_PAYMENT
order.payment.status = NOT_STARTED
```

It does not contact Stripe and does not enqueue delivery work.

### Create or retrieve the PaymentIntent

```http
POST /orders/{orderId}/payment-intents
Authorization: Bearer <Cognito token>
X-Correlation-Id: <optional correlation ID>
```

The server:

1. resolves the authenticated merchant and verifies order ownership;
2. loads the order and its embedded payment;
3. derives amount and currency from the stored order;
4. returns the existing PaymentIntent when one is already mapped;
5. otherwise calls Stripe with a stable server-derived key such as
   `stripe-payment-intent:<merchantId>:<orderId>`;
6. transactionally records the order update and PaymentIntent lookup; and
7. returns the client secret only after the mapping is durable.

The operation is naturally idempotent in this bounded design: `orderId`
identifies the logical operation, the order can hold only one PaymentIntent ID,
and the server-derived Stripe key prevents concurrent or repeated HTTP attempts
from creating different logical PaymentIntents.

The first successful creation returns `201`; a valid replay returns `200`.
Amount, currency, merchant, and Stripe creation key are never accepted from the
browser. The client secret is returned only to the authenticated order owner and
is never logged or stored in DynamoDB. On replay, the server retrieves the
current PaymentIntent from Stripe and returns its client secret.

If Stripe creation succeeds but persistence fails, the server does not return
the client secret. A retry uses the same Stripe creation key and persists the
same logical result before responding.

### Stripe webhook

```http
POST /webhooks/stripe
Stripe-Signature: <Stripe signature>
Content-Type: application/json
```

This route has no Cognito authorizer because Stripe is not a platform user. The
dedicated Lambda authenticates the exact raw request bytes with Stripe's
official library before trusting parsed JSON.

The Stripe endpoint subscribes only to:

- `payment_intent.created`;
- `payment_intent.requires_action`;
- `payment_intent.processing`;
- `payment_intent.payment_failed`;
- `payment_intent.succeeded`; and
- `payment_intent.canceled`.

For a supported event, the handler retrieves the current PaymentIntent from
Stripe and treats that current object as authoritative. It validates the ID,
merchant and order metadata, stored mapping, amount, currency, and automatic
capture expectations before writing.

`payment_intent.created` can repair the mapping when Stripe creation succeeded
but the synchronous persistence attempt failed. Conditional transactions make
this safe when the API and webhook race.

Unsupported valid events receive `204` and cause no mutation. Invalid
signatures or malformed payloads receive `400`.

## Event routing

The all-events SNS topic still receives every supported order domain event.
The delivery subscription changes its filter from `order.created` to:

```text
order.ready_for_submission
order.submission_retry_requested
```

`order.ready_for_submission` is intentionally independent of Stripe. A future
cash, free, or alternative-payment workflow could make an order ready without
changing the delivery worker's responsibility.

The successful payment transaction changes the order to `PENDING_SUBMISSION`.
The resulting stream record is the durable synchronous-to-asynchronous handoff;
the API and Stripe webhook do not publish directly to SNS.

## Webhook failure and recovery policy

| Situation | HTTP response | Durable result |
| --- | ---: | --- |
| Applied successfully | `204` | Payment/order/event marker commit atomically. |
| Valid duplicate | `204` | No repeated transition. |
| Unsupported valid event | `204` | No business mutation. |
| Invalid signature or malformed input | `400` | No trusted mutation. |
| Temporary Stripe, SSM, or DynamoDB failure | `500` | No processed marker; Stripe retries. |
| Verified permanent business mismatch | `204`, only after persistence | Marker records `RECONCILIATION_REQUIRED`. |

Permanent mismatches include amount or currency changes, conflicting mappings,
unexpected manual-capture state, or inconsistent merchant/order metadata. If
the reconciliation marker cannot be committed, the handler returns `500`.

After a new reconciliation marker commits, the Lambda writes one structured
`stripe.webhook.reconciliation_required` error entry containing only safe
identifiers and the reason code. A duplicate delivery does not repeat that error
entry. This lab deliberately has no proactive reconciliation alarm; an operator
must inspect the error logs or query the durable markers. A production design
would normally add a metric filter and alarm or a dedicated reconciliation
workflow.

There is no Lambda DLQ on this synchronous API Gateway invocation. Stripe owns
automatic delivery retry. A separate webhook inbox queue is deliberately out
of scope for the first slice.

Current Stripe behavior is three Sandbox retry attempts over a few hours and up
to three days of retries in live mode. Stripe's Events API lists up to 30 days
of history. The operator command:

```bash
npm run stripe:reconcile
```

finds relevant failed deliveries and resends or reprocesses them after the
endpoint is restored. Reprocessing still retrieves the PaymentIntent's current
state and uses the same transactional deduplication path. An outage beyond
automatic retry therefore reduces availability but does not permit unpaid
fulfilment.

References:

- [Stripe webhook delivery behavior](https://docs.stripe.com/webhooks?lang=node)
- [Stripe Events API](https://docs.stripe.com/api/events/list)

## Safety invariants

| ID | Invariant |
| --- | --- |
| PAY-I01 | An order cannot enter `PENDING_SUBMISSION` before payment is transactionally recorded as `SUCCEEDED`. |
| PAY-I02 | Amount and currency sent to Stripe equal the server-calculated stored order total. |
| PAY-I03 | The browser cannot select or override amount, currency, merchant, order, capture mode, or Stripe creation key. |
| PAY-I04 | One order uses one stable Stripe creation key and one application-mapped PaymentIntent. |
| PAY-I05 | The client receives a client secret only after the Stripe intent mapping is durable. |
| PAY-I06 | Browser confirmation cannot directly start fulfilment. |
| PAY-I07 | Stripe signature verification uses the exact raw body before JSON is trusted. |
| PAY-I08 | A Stripe event ID is durably claimed with its canonical fingerprint. |
| PAY-I09 | Payment success, order eligibility, and the processed-event marker commit in one DynamoDB transaction. |
| PAY-I10 | `SUCCEEDED` and `CANCELLED` are terminal; delayed events cannot move them backward. |
| PAY-I11 | Delivery SQS never receives `order.created` as a submission request. |
| PAY-I12 | Card data, Stripe secret keys, webhook secrets, and client secrets are absent from application logs and DynamoDB. |
| PAY-I13 | Correlation ID, order ID, PaymentIntent ID, Stripe event ID, and safe outcome remain traceable. |
| PAY-I14 | A permanent mismatch is acknowledged only after durable reconciliation evidence exists. |
| PAY-I15 | Automatic capture is required; `requires_capture` cannot start fulfilment. |

## Secret handling and cost controls

### Local

- Stripe test secrets live in an ignored local environment file with mode
  `0600`.
- Only the `pk_test_...` publishable key may enter browser configuration.
- `sk_test_...`, `whsec_...`, and PaymentIntent client secrets are never logged.

### AWS

- The Stripe test secret and current webhook signing secret use SSM Parameter
  Store **Standard** `SecureString` parameters.
- The parameters use the existing AWS-managed `alias/aws/ssm` key.
- The Orders API Lambda may read the Stripe key needed for creation.
- The Stripe webhook Lambda may read the signing secret and Stripe key needed
  for current-state retrieval.
- Values are cached within warm Lambda execution environments.
- Parameter names, not values, may appear in CloudFormation configuration.

Deployment validation rejects:

- Advanced Parameter Store parameters;
- Parameter Store higher throughput;
- a customer-managed KMS key;
- Cognito Essentials or Plus;
- Cognito SMS features or a custom Cognito domain; and
- live-mode Stripe keys.

Standard parameters and standard-throughput Parameter Store interactions have
no additional charge. The AWS-managed KMS key has no monthly storage fee, and
this lab is expected to remain inside the KMS request free tier. These choices
have expected incremental cost `$0`, but ordinary Lambda, API Gateway,
DynamoDB, and CloudWatch usage remains subject to the existing bounded cloud
budget.

## Browser authentication and CORS

The cloud UI uses the existing Cognito user pool and operator account through
the classic hosted UI:

```text
Authorization Code + PKCE
callback: http://localhost:3002/auth/callback
logout:   http://localhost:3002/
```

The SPA is a public OAuth client and has no client secret. It enables no
implicit grant. Tokens remain in browser memory for the learning session.
Only exact localhost UI origins are permitted by API CORS configuration.

The local lab uses the existing fixed `mrc_demo` identity because SAM local does
not reproduce API Gateway's Cognito authorizer. The UI must display a prominent
`LOCAL AUTH BYPASS` banner in that mode. Cognito and JWT enforcement are proven
only by the cloud lab.

## React UI workspace

The frontend is a separate npm workspace:

```text
ui/
  src/
  tests/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
```

It uses React, TypeScript, Vite, Stripe's official React bindings, Vitest, and
React Testing Library. Source is committed; `ui/.env.local`, build output, and
runtime state are ignored.

Only public browser configuration may use `VITE_` variables:

```text
VITE_API_BASE_URL
VITE_STRIPE_PUBLISHABLE_KEY
VITE_COGNITO_DOMAIN
VITE_COGNITO_CLIENT_ID
```

The learning console presents this state-aware flow:

1. Create order.
2. Prepare the PaymentIntent.
3. Enter a Stripe test card in the Payment Element.
4. Confirm payment.
5. Observe payment and delivery state.

It shows safe identifiers, amount, statuses, copyable test-card examples, a
manual refresh action, and a client-observed timeline. While work is active it
polls `GET /orders/{orderId}` once per second for a bounded interval. This is a
learning convenience, not an audit log; CloudWatch remains authoritative for
the internal event journey.

Stripe owns the iframe containing card fields. Application code cannot read,
store, log, or programmatically fill those fields.

## Local and cloud labs

### Fast local lab

```bash
npm run local:lab
```

Before its first run, the two ignored mode-`0600` environment files contain:

```text
.env.development.local  -> STRIPE_SECRET_KEY=sk_test_...
ui/.env.local           -> VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

The Stripe CLI must be installed. The supervisor supplies the Sandbox API key
through the Stripe process environment, never through command arguments. It
obtains the CLI signing secret, injects it only into a temporary mode-`0600`
SAM runtime file, redacts Stripe credentials from combined output, and deletes
the runtime file when SAM stops.

The command starts and supervises:

- DynamoDB Local on `127.0.0.1:8000`;
- the local API on `127.0.0.1:3000`;
- the React UI on `127.0.0.1:3002`;
- Stripe CLI forwarding Sandbox events to the local webhook.

It provides combined labelled logs and watch-mode feedback. `Ctrl+C` stops its
owned API, UI, and Stripe forwarding processes. DynamoDB Local data is
preserved for inspection. It does not deploy or contact AWS. The local
payment exercise is not presented as proof of Cognito, IAM, API Gateway,
managed Lambda event-source mappings, SNS, SQS, DLQs, or CloudFormation
behavior. Extending the same supervisor with the local publisher/delivery relay
and mock vendor remains a separate reviewable slice.

### Reviewed cloud lab

The cloud lab remains the final AWS integration proof. After the stack is
deployed, its orchestrator:

1. obtains the API Gateway URL;
2. removes or reconciles an earlier lab-owned Stripe endpoint;
3. creates a temporary Stripe Sandbox webhook endpoint for the exact event
   allowlist;
4. writes its new signing secret to Standard SSM `SecureString`;
5. starts the local UI and reports `PAYMENT LAB READY`; and
6. refuses to report readiness if any boundary is unavailable.

Verified teardown stops new UI work, deletes the temporary Stripe endpoint,
stops owned local processes, destroys the AWS stack, and verifies both Stripe
and AWS cleanup. The reusable Stripe test API key may remain in SSM; the obsolete
webhook signing secret is deleted. Incomplete cleanup preserves recovery state
and reports an explicit command rather than silently claiming success.

No cloud exercise is authorized merely by this specification. Each real AWS run
still requires a separate bounded cost review and user approval.

## Test strategy and acceptance checklist

### Always-local automated tests

- [ ] Domain tests cover every payment and order transition.
- [ ] The Stripe port uses deterministic fakes for success, timeout, decline,
      action-required, processing, cancellation, and conflicting data.
- [x] Repository tests prove atomic order and PaymentIntent-mapping writes plus
      atomic webhook event-marker writes.
- [ ] Webhook tests use exact raw bytes and valid, invalid, duplicate, stale,
      out-of-order, and concurrent events.
- [x] A delayed failure cannot overwrite `SUCCEEDED`.
- [ ] Automatic-capture mismatch becomes `RECONCILIATION_REQUIRED`.
- [ ] Stripe creation ambiguity reuses the stable Stripe key.
- [ ] Stripe success followed by a DynamoDB failure is recovered without
      returning an unsafe client secret.
- [ ] UI component tests cover button states, safe rendering, polling bounds,
      decline retry, and auth modes.
- [ ] Unpaid orders never reach the delivery application handler.

These tests use no AWS service and no Stripe network connection. They remain in
normal pull-request checks.

### Opt-in local Stripe exercise

- [ ] Success proceeds from `AWAITING_PAYMENT` through provider delivery.
- [ ] A declined card keeps delivery blocked and then succeeds using the same
      PaymentIntent.
- [ ] A 3D Secure test completes through the Payment Element.
- [ ] Duplicate delivery changes state once.
- [ ] A temporary webhook outage is recovered with `stripe:reconcile`.
- [ ] Logs and persisted items contain no secret or card data.

### Separately approved AWS exercise

- [ ] Cognito Authorization Code + PKCE protects authenticated routes.
- [ ] API Gateway preserves the raw webhook body for signature verification.
- [ ] Payment success produces `order.ready_for_submission` through DynamoDB
      Stream, publisher Lambda, SNS, and SQS.
- [ ] `order.created` does not reach the delivery worker.
- [ ] CloudWatch correlation shows the complete payment and delivery journey.
- [ ] Temporary Stripe webhook registration and verified deletion succeed.
- [ ] AWS teardown leaves no unexplained resource or recovery state.
- [ ] Cost evidence remains within the separately approved test bound.

Tests that contact Stripe are opt-in and never run in ordinary pull-request
checks. Stripe Sandbox is not used for load testing.

## Small reviewable implementation slices

1. Add reviewed payment/order contracts and domain tests.
2. Add embedded-payment persistence and PaymentIntent mapping repository tests.
3. Add the Stripe client port, deterministic fake, and adapter contract tests.
4. Add the authenticated PaymentIntent HTTP operation and local SAM route.
5. Add the dedicated Stripe webhook application logic and raw-body adapter.
6. Change the domain event and delivery subscription contracts.
7. Add the separate React/TypeScript workspace and component tests.
8. Add `local:lab`, Stripe forwarding, and local happy-path exercises.
9. Add the reviewed cloud resources, SSM access, Cognito PKCE configuration,
   and temporary Stripe endpoint lifecycle.
10. Run the separately approved cloud acceptance exercise and verified teardown.

Every slice must keep ordinary checks green and remain independently
reviewable. Runtime implementation begins only after this documentation change
is committed.
