# DynamoDB access patterns

Status: MVP baseline  
Last reviewed: 2026-07-23

## Purpose

This document defines the access patterns and keys for the order table before
repository code is written. Every application operation must use `GetItem`,
`PutItem`, `UpdateItem`, `TransactWriteItems`, or a bounded `Query`; request
paths must not depend on `Scan`.

The local table is named `serverless-order-integration-local`. Deployed table
names will be supplied by infrastructure configuration rather than embedded in
application code.

## Table keys

The table uses generic string attributes so multiple entity types can share one
table:

| Attribute | Role |
| --- | --- |
| `pk` | Table partition key |
| `sk` | Table sort key |
| `gsi1pk` | `byMerchantCreatedAt` partition key |
| `gsi1sk` | `byMerchantCreatedAt` sort key |
| `gsi2pk` | `byMerchantStatusCreatedAt` partition key |
| `gsi2sk` | `byMerchantStatusCreatedAt` sort key |

Only order items carry GSI attributes, making both indexes sparse. Sentinel and
deduplication items are absent from the indexes.

## Item key shapes

| Item | `pk` | `sk` | Additional index keys |
| --- | --- | --- | --- |
| Order | `MERCHANT#<merchantId>` | `ORDER#<orderId>` | Both GSIs below |
| Idempotency record | `MERCHANT#<merchantId>` | `IDEMPOTENCY#<idempotencyKey>` | None |
| Merchant reference claim | `MERCHANT#<merchantId>` | `ORDER_REFERENCE#<merchantOrderReference>` | None |
| Provider order mapping | `PROVIDER#<providerCode>` | `ORDER#<providerOrderId>` | None |
| Processed event | `CONSUMER#<consumerName>` | `EVENT#<eventId>` | None |

Each item also carries an `entityType` and a numeric `schemaVersion` so the
repository can validate and evolve stored representations.

Every order item also carries a `mutation` object written atomically with its
latest aggregate state. It identifies an order creation or status change and
preserves the correlation ID, causation ID, previous status, and optional
operator reason needed by the DynamoDB Stream publisher. It is internal event
source metadata and is not returned by the order API.

An order has these sparse index keys:

```text
gsi1pk = MERCHANT#<merchantId>
gsi1sk = ORDER#<createdAt>#<orderId>

gsi2pk = MERCHANT#<merchantId>#STATUS#<status>
gsi2sk = ORDER#<createdAt>#<orderId>
```

UTC timestamps use one fixed ISO 8601 representation. Appending the order ID
provides deterministic ordering when two orders have the same creation time.

## Access patterns

| ID | Operation | DynamoDB operation and key condition |
| --- | --- | --- |
| AP-01 | Create one order | One transaction conditionally puts the order, idempotency record, and merchant-reference claim. |
| AP-02 | Resolve an idempotent retry | `GetItem` using the merchant partition and `IDEMPOTENCY#<key>`. |
| AP-03 | Get an order for its merchant | Strongly consistent `GetItem` using `MERCHANT#<merchantId>` and `ORDER#<orderId>`. |
| AP-04 | List a merchant's orders | Query `byMerchantCreatedAt` by merchant, descending, with a bounded limit. |
| AP-05 | List a merchant's orders by status | Query `byMerchantStatusCreatedAt` by merchant and status, descending, with a bounded limit. |
| AP-06 | Change order status | Conditional `UpdateItem` checks the aggregate version and updates the status index key atomically. |
| AP-07 | Resolve a provider webhook | `GetItem` using `PROVIDER#<providerCode>` and `ORDER#<providerOrderId>`. |
| AP-08 | Deduplicate an event for a consumer | Conditional `PutItem` using consumer identity and event ID, normally in the same transaction as its state change. |

List cursors are versioned and HMAC-signed. They carry only the logical last
position (`createdAt` and `orderId`) plus the merchant and optional status
scope. The repository reconstructs DynamoDB's `ExclusiveStartKey`; clients
never receive raw table or index key attribute names. Signing prevents a client
from modifying a position or reusing a cursor for another merchant or filter.

## Index choices and consistency

Both GSIs project all order attributes. This lets a list request return a page
with one query instead of issuing a second batch read. The trade-off is greater
index storage and write amplification. It is acceptable for the small learning
dataset and will be measured before making any production-scale claim.

GSI reads are eventually consistent. A newly created or updated order can take
a short time to appear in a list, while AP-03 reads the source table and can be
strongly consistent. This distinction must be explicit in API and test
expectations.

The MVP has one low-volume merchant. If future requirements introduce a tenant
large enough to create a hot merchant partition, the key design must be
revisited with measured traffic before adding write sharding.

## Local and cloud differences

The local bootstrap creates the keys, indexes, and `PAY_PER_REQUEST` billing
mode used by the eventual AWS table. Streams, encryption, deletion protection,
tags, alarms, and throughput safety controls belong to the deployable
infrastructure definition and are not configured by this local script.

Changing the local key schema requires `npm run dynamodb:reset` followed by
`npm run dynamodb:bootstrap`. The reset deletes all local table data.
