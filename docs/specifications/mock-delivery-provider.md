# Mock delivery provider contract

Status: MVP baseline  
Last reviewed: 2026-07-22

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
| `Idempotency-Key` | The order's stable provider `submissionKey`; reuse it on every retry. |
| `X-Correlation-Id` | The order-flow correlation reference. The mock echoes it on a successful response. |

Request body:

```json
{
  "platformOrderId": "ord_example_123",
  "merchantOrderReference": "merchant-order-123",
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
  "providerOrderId": "delivery_example_123",
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

| Value | Behavior |
| --- | --- |
| `success` or absent | Accept and return valid JSON. |
| `timeout` | Accept and record the delivery, then delay the HTTP response for 10 seconds. |
| `rate-limit` | Return `429` and do not accept the delivery. |
| `server-error` | Return `500` and do not accept the delivery. |
| `malformed-response` | Accept and record the delivery, then return truncated JSON. |

The timeout and malformed-response modes deliberately model an uncertain
outcome: the provider-side effect happened, but the platform did not receive a
usable confirmation. A retry with the unchanged `Idempotency-Key` recovers the
original acceptance instead of creating a second delivery.

Error responses are small JSON objects with a stable `code` and safe `detail`.
The exact retry classification and bounded retry policy are defined by the
[delivery vendor client policy](vendor-client.md).
