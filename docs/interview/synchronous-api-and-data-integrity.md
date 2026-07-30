# Synchronous API and data-integrity walkthrough

## Purpose

Use this guide for a deeper interview discussion of the path from an HTTP
request to a committed order in DynamoDB. The goal is not to memorize code. For
each design choice, be able to explain:

1. which failure or race it prevents;
2. which invariant the system protects;
3. how the implementation enforces that invariant; and
4. which limitation or trade-off remains.

The asynchronous path starts only after the DynamoDB transaction commits and is
covered separately.

## Request path

```text
Client
  |
  | HTTPS + access token
  | Idempotency-Key on POST
  | If-Match on PATCH
  v
API Gateway HTTP API
  |-- validates the Cognito JWT on protected routes
  |-- applies throttling and writes access logs
  v
Orders API Lambda
  |-- authenticates and authorizes
  |-- routes and validates
  |-- applies domain rules
  v
DynamoDB repository
  |-- transactional create
  |-- strongly consistent point read
  |-- bounded GSI query for lists
  |-- conditional version update
  v
Committed order + mutation metadata
  |
  `-- DynamoDB Stream continues the asynchronous journey
```

The Lambda does not call the delivery provider and does not publish to SNS
during the API request. That keeps provider latency outside the synchronous
response and avoids a database/message dual write.

## 1. Authentication, authorization, and tenant scope

API Gateway validates Cognito JWTs for protected order routes. The Lambda still
checks that the token is an access token. The operator status-change route also
requires membership in the `operators` Cognito group.

The security decisions are intentionally separate:

- **Authentication:** is this a valid access token issued for this API?
- **Authorization:** is this principal allowed to perform this operation?
- **Data scope:** which merchant's records may the operation access?

The MVP injects one fixed merchant, `mrc_demo`, after authentication. It is a
learning simplification, not a complete multi-tenant authorization model. A
production system should derive an authorized merchant scope from trusted
claims or an authorization service and must never accept a client-supplied
merchant ID without verifying it.

Invariant:

> An unauthenticated caller cannot use protected routes, and a normal caller
> cannot use the operator-only status mutation.

Useful interview answer:

> API Gateway performs managed JWT validation before invocation, while the
> application enforces operation-specific authorization. I would bind tenant
> scope to trusted identity claims in a multi-tenant production version.

Evidence:

- [Orders API Lambda](../../src/lambda/orders-api.ts)
- [Cloud infrastructure template](../../template.cloud.yaml)

## 2. Boundary validation and stable HTTP semantics

The HTTP layer treats all external input as untrusted:

- path and query values are checked;
- JSON is parsed safely;
- create and status-change bodies are validated;
- `Idempotency-Key` must match a bounded format;
- `If-Match` must contain a strong, positive-integer ETag; and
- list limits are restricted to `1` through `100`.

Failures use a consistent problem-details representation. Important status
codes include:

| Status | Meaning in this API |
| --- | --- |
| `400` | The request framing or required header is malformed |
| `401` | Authentication is missing or invalid |
| `403` | The authenticated principal lacks the required role |
| `404` | The order is absent or not visible in the merchant scope |
| `409` | A uniqueness rule or domain transition conflicts with current state |
| `412` | `If-Match` names an older or otherwise incorrect order version |
| `422` | The request is well formed but contains invalid business values |
| `428` | A mutation omitted the required `If-Match` precondition |

This split lets a caller distinguish “fix the request” from “refresh current
state and reconsider the operation.”

Invariant:

> Invalid external data does not enter the domain model or persistence layer.

Trade-off:

> Validation is currently implemented manually. A schema-first validator such
> as Zod could reduce drift between runtime validation and TypeScript types, but
> it would add a dependency and require a deliberate migration.

Evidence:

- [Create-order HTTP handler](../../src/http/create-order-handler.ts)
- [Change-status HTTP handler](../../src/http/change-order-status-handler.ts)
- [List-orders HTTP handler](../../src/http/list-orders-handler.ts)
- [Problem-details representation](../../src/http/problem-details.ts)

## 3. Create-order idempotency

### The problem

A client can submit an order successfully but lose the response. If it retries,
the server must not create a second order. Merely checking whether an
idempotency key exists before writing is unsafe because two concurrent requests
can both pass the check.

### The implementation

The create path:

1. validates and canonicalizes the business request;
2. hashes that canonical representation with SHA-256;
3. creates the initial order at version `1`;
4. starts one DynamoDB transaction that conditionally puts:
   - the order;
   - the idempotency-key claim and request fingerprint; and
   - the merchant order ID claim.

Every put requires its key not to exist. The transaction is all-or-nothing, so
concurrent requests cannot each claim the same idempotency key or merchant
reference.

If the transaction loses a conditional race, the repository performs strongly
consistent reads to classify the result:

- same idempotency key + same request fingerprint: return the stored order as a
  replay;
- same idempotency key + different fingerprint: return `409
  IDEMPOTENCY_CONFLICT`;
- same merchant order ID under a different request: return `409
  MERCHANT_ORDER_ID_CONFLICT`; or
- an unexpected generated order-ID collision: fail safely.

The initial response is `201 Created`. A valid replay is `200 OK` with
`Idempotency-Replayed: true`.

```text
                  same key, same payload
retry ------------------------------------------> return existing order

                  same key, different payload
unsafe reuse -----------------------------------> 409 conflict

                  different key, same merchant order ID
duplicate business order ----------------------> 409 conflict
```

Invariant:

> For one merchant, an idempotency key identifies one canonical create request,
> and a merchant order ID identifies one order.

Why the fingerprint matters:

> Without it, accidentally reusing a key for a different order would silently
> return the first result and hide a client bug.

Why this is not “exactly once”:

> The API provides idempotent effects for this operation. The surrounding
> distributed system still uses at-least-once delivery and duplicate detection.

Trade-offs:

- idempotency records currently live for the lifetime of the table; a
  production retention and TTL policy would need to match the client retry
  contract;
- each create consumes a three-item transaction, which costs more than one
  unconditional write; and
- canonicalization must evolve carefully when the request schema changes.

Evidence:

- [Create-order application service](../../src/application/create-order.ts)
- [DynamoDB order repository](../../src/infrastructure/dynamodb/dynamodb-order-repository.ts)

## 4. DynamoDB single-table model

The table stores several related item types behind generic `pk` and `sk`
attributes:

| Item | Purpose |
| --- | --- |
| `ORDER` | Current order aggregate plus the mutation metadata for the stream |
| `IDEMPOTENCY` | Binds a client key and request fingerprint to an order |
| `MERCHANT_ORDER_ID` | Enforces merchant order ID uniqueness |
| `DELIVERY_PROVIDER_ORDER` | Resolves a delivery-provider order ID back to the platform order |
| `PROCESSED_EVENT` | Deduplicates one webhook event for one consumer |

The key design starts from access patterns, not from an attempt to reproduce
relational tables:

| Operation | DynamoDB access |
| --- | --- |
| Create order | Conditional three-item `TransactWriteItems` |
| Get one order | Strongly consistent `GetItem` by merchant and order ID |
| List merchant orders | Bounded `Query` on `byMerchantCreatedAt` |
| List by status | Bounded `Query` on `byMerchantStatusCreatedAt` |
| Change status | Version-conditional update, optionally in a transaction |
| Resolve provider order | Strong point read of a delivery-provider mapping |

Only order items contain GSI attributes, so the indexes are sparse. Both list
indexes project the order, avoiding a second read per item at the cost of index
storage and write amplification.

Invariant:

> Every request path uses a known key lookup or bounded query; no request path
> depends on a table scan.

Trade-offs:

- point reads can be strongly consistent, but GSI queries are eventually
  consistent, so a new or updated order may briefly be absent from a list;
- all orders for one merchant share an index partition, which fits the
  low-volume MVP but could become hot for a very large tenant; and
- duplicating the order in two projected indexes increases storage and write
  work.

At higher measured volume, options include merchant partition sharding,
time-bucketed keys, narrower index projections, or a purpose-built read model.
Those changes should follow access and traffic requirements rather than be
added pre-emptively.

Evidence:

- [DynamoDB access patterns](../specifications/dynamodb-access-patterns.md)
- [DynamoDB order repository](../../src/infrastructure/dynamodb/dynamodb-order-repository.ts)

## 5. Optimistic concurrency and state-machine integrity

### The lost-update problem

Suppose two actors read version `3`. One changes the order to `CANCELLED`; the
other tries to change it to `PICKED_UP`. If both writes are unconditional, the
last writer can silently overwrite the first.

### The implementation

GET and mutation responses expose the order version as a strong ETag:

```http
ETag: "3"
```

A status mutation must send:

```http
If-Match: "3"
```

The application first checks the version it read, but that check alone is not
enough: another writer can commit immediately afterward. The DynamoDB update
therefore contains a condition that the stored version still equals the
expected version. It atomically writes:

- the new order representation;
- the new top-level status and version;
- the status-index partition key; and
- mutation metadata used by the stream publisher.

If the condition loses a race, the API returns `412 VERSION_MISMATCH` and the
current ETag. The caller can fetch current state and decide whether its intended
operation is still valid.

The domain state machine separately restricts legal transitions. For example,
`DELIVERED` is terminal, submission failures require `SUBMISSION` failure
details, and a delivery-provider order ID is first established when the provider accepts
the order.

When submission is accepted, the order update and delivery-provider-order lookup item
are written in one DynamoDB transaction. This prevents an accepted order from
being committed without the mapping required to resolve later webhooks.

Invariant:

> A mutation applies only to the version it was based on, and committed state
> always satisfies the order transition rules.

Useful interview distinction:

> Domain validation says whether a transition is logically legal. Optimistic
> concurrency says whether the state I validated is still current when I write.
> Both are required.

Evidence:

- [Order status state machine](../../src/domain/order-status-transition.ts)
- [Change-status application service](../../src/application/change-order-status.ts)
- [DynamoDB order repository](../../src/infrastructure/dynamodb/dynamodb-order-repository.ts)

## 6. Pagination without exposing database internals

List requests use a default page size of `25` and a maximum of `100`. DynamoDB
returns a `LastEvaluatedKey`, but the API does not expose raw table and index
keys.

Instead, the cursor contains:

- a cursor schema version;
- merchant scope;
- optional status-filter scope;
- the last order's creation time; and
- the last order ID.

The payload is Base64URL encoded and signed with HMAC-SHA256. Decoding verifies
the signature with constant-time comparison, validates the payload, and checks
that the cursor belongs to the current merchant and status filter. The
repository reconstructs the DynamoDB `ExclusiveStartKey`.

Invariant:

> A client cannot alter its list position or reuse a cursor to cross merchant
> or filter boundaries.

The cursor is signed, not encrypted. Its contents are integrity-protected but
should not contain secrets.

Trade-offs:

- a cursor-signing-secret rotation strategy is not implemented;
- the cursor format is versioned, but only version `1` is currently accepted;
  and
- an eventually consistent GSI can change while a client moves between pages,
  so this is not a snapshot-isolated traversal.

Evidence:

- [Order cursor codec](../../src/http/order-cursor.ts)
- [List-orders HTTP handler](../../src/http/list-orders-handler.ts)

## 7. The durable handoff to asynchronous processing

The order item stores both current aggregate state and the mutation that caused
that state. The create transaction or conditional status write commits them
together.

Only after that commit does DynamoDB Streams expose the change. Therefore:

- a failed API transaction emits no committed order change;
- a successful API write does not depend on SNS being available at that
  moment; and
- the publisher can derive a domain event from the committed mutation.

This avoids the classic dual-write sequence:

```text
write database -> publish message
```

where the process can crash after either step and leave the two systems
inconsistent.

The design is similar in purpose to a transactional outbox, but it stores the
latest mutation on the aggregate item and uses DynamoDB Streams as change-data
capture. It is not a permanent, queryable event store.

Invariant:

> An event is eligible for publication only for an order mutation that
> committed.

Trade-off:

> Updating the same order again can replace the previous mutation on the table
> item, but each committed stream record retains its own `NEW_IMAGE` for the
> stream retention period. Long-term event history requires another store.

## 8. Walk through three interview scenarios

### Scenario A: the client loses a successful create response

1. The first request commits all three items, but the response is lost.
2. The client retries with the same idempotency key and body.
3. The conditional transaction is cancelled because the claim exists.
4. A strongly consistent read finds the same fingerprint.
5. The API returns the existing order with `200` and
   `Idempotency-Replayed: true`.

No second order is created.

### Scenario B: two operators update the same order

1. Both read version `4`.
2. Operator A commits a valid transition to version `5`.
3. Operator B's DynamoDB condition still expects version `4`.
4. DynamoDB rejects B's write.
5. B receives `412` with ETag `"5"` and must refresh.

The later request cannot overwrite the earlier commit silently.

### Scenario C: a list omits a just-created order

1. Create returns successfully after the source-table transaction commits.
2. An immediate point GET finds the order because it is strongly consistent.
3. An immediate list query may not yet show it because a GSI is eventually
   consistent.
4. The order appears after index propagation.

That is an accepted consistency trade-off, not evidence that the create failed.

## 9. Questions an interviewer may ask

### Why not store only the idempotency key?

Because the same key could then be reused accidentally with different business
data. Binding it to a canonical payload fingerprint distinguishes a safe retry
from a conflicting command.

### Why use a transaction instead of “check, then put”?

Check-then-put has a race between the read and write. Conditional items in one
DynamoDB transaction make the order and uniqueness claims succeed or fail as
one unit.

### Why check the version in the application and DynamoDB?

The application check gives an early, clear failure. The DynamoDB condition is
the actual concurrency guarantee because it closes the race between read and
write.

### Why use `412` instead of `409` for a stale version?

The failed condition came from the HTTP `If-Match` precondition, so `412
Precondition Failed` communicates the protocol-level cause. `409` is used for
domain or uniqueness conflicts.

### Does a successful create mean the delivery provider accepted the order?

No. It means the platform durably accepted the order in
`PENDING_SUBMISSION`. Provider submission is asynchronous, and its result
creates a later version.

### Is the list read-after-write consistent?

No. A direct source-table GET is strongly consistent, while both list GSIs are
eventually consistent.

### Is this complete multi-tenancy?

No. Keys are merchant-scoped, but the deployed MVP uses one fixed merchant.
Production needs identity-to-tenant authorization, tenant lifecycle controls,
and a hot-partition review based on measured traffic.

## 10. A two-minute deep-dive answer

> On the synchronous path, I protect three kinds of integrity: request
> identity, aggregate concurrency, and query scope. Create requires an
> idempotency key. I canonicalize the validated payload and store its SHA-256
> fingerprint with the order and merchant order ID claim in one conditional
> DynamoDB transaction. That makes a lost-response retry return the original
> order, while conflicting key reuse or a duplicate merchant order ID returns
> a conflict.
>
> Orders carry a monotonically increasing version. Status changes require an
> `If-Match` ETag and the repository repeats that expected version in the
> DynamoDB condition, so a concurrent writer cannot cause a lost update. The
> domain state machine independently rejects illegal transitions and missing
> provider or failure details. When provider acceptance is stored, its lookup
> mapping is in the same transaction as the order update.
>
> The data model is access-pattern driven: strong point reads use the base
> table, while bounded list queries use sparse GSIs by merchant and by
> merchant-plus-status. I explicitly accept eventual consistency for lists.
> Pagination cursors are versioned, merchant- and filter-scoped, and HMAC-signed
> so clients cannot modify DynamoDB positions.
>
> Finally, the API commits order state and mutation metadata together. DynamoDB
> Streams observes only committed changes, so the API never performs a fragile
> database-plus-SNS dual write. The main limitations are a fixed MVP merchant,
> permanent idempotency records, eventual list consistency, and no partition
> sharding for a very large tenant.

## Practice checklist

Before moving to the asynchronous walkthrough, explain without reading:

- the difference between a valid idempotent replay and conflicting key reuse;
- why the create operation needs three conditional items in one transaction;
- why the application version check is not sufficient by itself;
- the difference between a domain conflict and a failed HTTP precondition;
- why GET can be current while LIST briefly looks stale;
- why the cursor is signed and scope-bound;
- how the delivery-provider-order mapping remains consistent with provider acceptance;
  and
- exactly where the synchronous transaction hands work to the asynchronous
  system.

Source material:

- [OpenAPI contract](../specifications/openapi.yaml)
- [DynamoDB access patterns](../specifications/dynamodb-access-patterns.md)
- [Domain model](../specifications/domain-model.md)
- [Short system-design walkthrough](system-design-overview.md)
