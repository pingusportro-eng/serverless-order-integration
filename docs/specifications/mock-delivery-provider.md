# Mock delivery provider contract

Status: MVP baseline  
Last reviewed: 2026-07-23

## Purpose

The local mock behaves like the single delivery provider in the MVP. It gives
the vendor client a real HTTP boundary and deterministic success and failure
modes without contacting AWS or an external service. Only synthetic data may be
sent to it.

## Submit a delivery

`POST /deliveries`

Required request headers:

| Header | Rule |
| --- | --- |
| `Authorization` | `Bearer <token>` using the configured mock token. |
| `Content-Type` | `application/json`. |
| `Idempotency-Key` | The order's stable provider `deliveryProviderSubmissionKey`; reuse it on every retry. |
| `X-Correlation-Id` | The order-flow correlation reference. The mock echoes it on a successful response. |

Request body:

```json
{
  "platformOrderId": "ord_example_123",
  "merchantOrderId": "merchant-order-123",
  "items": [{ "itemReference": "item-1", "quantity": 2 }],
  "pickup": {
    "addressLine": "10 Example Street",
    "city": "Bucharest",
    "postalCode": "010101",
    "countryCode": "RO"
  },
  "dropoff": {
    "addressLine": "20 Example Avenue",
    "city": "Bucharest",
    "postalCode": "020202",
    "countryCode": "RO"
  }
}
```

A new accepted submission returns `201 Created`:

```json
{
  "deliveryProviderOrderId": "delivery_example_123",
  "status": "ACCEPTED",
  "acceptedAt": "2026-07-22T10:30:00.000Z"
}
```

The mock stores accepted submissions in memory. Repeating the same delivery
data with the same `Idempotency-Key` returns the original acceptance. Reusing a
key for different delivery data returns `409 IDEMPOTENCY_CONFLICT`. Restarting
the mock clears this local state.

## Authentication and rate limiting

An absent or incorrect bearer token returns `401 UNAUTHORIZED`. The token is
configuration, must not be logged, and will later come from environment or
secret configuration rather than an order or event.

The deterministic rate-limit mode returns `429 RATE_LIMITED` with
`Retry-After: 1`. The future vendor client must treat that header as a retry
hint, not as permission for unbounded retries.

## Deterministic local scenarios

Tests select behavior with `X-Mock-Vendor-Scenario`. This header is a local
testing control and is not part of a real provider integration.

The executable local server accepts `MOCK_VENDOR_SCENARIO` as its default for
requests that do not carry the test header. This lets an unmodified vendor
client exercise one deterministic mode. Invalid configured values prevent the
server from starting instead of silently falling back to success.

For controlled cloud drills, `MOCK_VENDOR_ATTEMPT_LOG` optionally enables an
append-only JSON-lines journal. Each authenticated attempt contains only its
timestamp, selected scenario, correlation ID, SHA-256 idempotency-key digest,
and response status. It excludes the bearer token, raw idempotency key, request
body, addresses, and provider response. The option is absent during ordinary
local use.

| Value | Behavior |
| --- | --- |
| `success` or absent | Accept and return valid JSON. |
| `timeout` | Accept and record the delivery, then delay the HTTP response for 10 seconds. |
| `rate-limit` | Return `429` and do not accept the delivery. |
| `server-error` | Return `500` and do not accept the delivery. |
| `request-rejected` | Return `422` and do not accept the delivery. |
| `malformed-response` | Accept and record the delivery, then return truncated JSON. |

The timeout and malformed-response modes deliberately model an uncertain
outcome: the provider-side effect happened, but the platform did not receive a
usable confirmation. A retry with the unchanged `Idempotency-Key` recovers the
original acceptance instead of creating a second delivery.

Error responses are small JSON objects with a stable `code` and safe `detail`.
The exact retry classification and bounded retry policy are defined by the
[delivery vendor client policy](vendor-client.md).

The executable server can emit a safe live activity stream through its
`onActivity` boundary. It records each inbound delivery request and response,
plus each outbound webhook attempt and response. Records may contain method,
path, status, scenario, correlation ID, platform and delivery-provider order IDs, event
identity, event type, and attempt number. They never contain authorization
values, signing values, raw idempotency keys, request bodies, addresses, or raw
provider responses.

## Delivery-status webhook

The provider sends status events to `POST /webhooks/vendor`. Each event has a
stable `eventId`, `deliveryProviderOrderId`, occurrence time, and one of the event types
defined by the OpenAPI `ProviderWebhookRequest` schema.

The provider sends:

| Header | Rule |
| --- | --- |
| `X-Webhook-Timestamp` | Ten-digit Unix time in seconds. |
| `X-Webhook-Signature` | `sha256=<lowercase hex HMAC>`. |
| `X-Correlation-Id` | Optional trace reference propagated into the resulting order event. |

The signed UTF-8 value is the timestamp, one literal period, and the unmodified
HTTP request body:

```text
<X-Webhook-Timestamp>.<raw request body>
```

HMAC-SHA256 uses the configured webhook secret. Verification uses a
constant-time comparison and happens before JSON parsing. The local tolerance
is 300 seconds in either direction; an absent, malformed, invalid, or expired
signature returns `401` without changing an order.

The timestamp limits captured-request replay, while the stable provider event
ID supplies durable business deduplication. A successfully processed duplicate
returns `204` without incrementing the order version. Reusing an event ID with
different validated event values returns `409 EVENT_ID_CONFLICT`. A delayed
event that would move the order backward is recorded as stale and returns `204`
without changing the aggregate.

When `MOCK_VENDOR_WEBHOOK_URL` and
`MOCK_VENDOR_WEBHOOK_SECRET`/`WEBHOOK_SIGNING_SECRET` are configured together,
the executable mock performs the provider side of this contract. A newly
accepted delivery schedules:

1. one signed `DELIVERY_PICKED_UP` callback after a short persistence delay;
2. one signed `DELIVERY_DELIVERED` callback after pickup succeeds.

Event IDs are deterministic for the accepted delivery-provider order and event type, and
the original delivery correlation ID is propagated. Replaying the original
delivery submission does not schedule another callback journey. A `404`, `429`,
`5xx`, network error, or timeout receives at most three callback attempts with
a bounded delay. Other `4xx` responses stop immediately. Delivery is not sent
if pickup exhausts its attempts, which preserves provider event order.

The delay plus retry covers the real integration race in which the delivery
worker has received the provider's `201` but has not yet committed the
`SUBMITTED` order/provider index needed by the webhook Lambda.
