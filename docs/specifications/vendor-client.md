# Delivery vendor client policy

Status: MVP baseline  
Last reviewed: 2026-07-22

## Responsibility

The delivery vendor client translates an internal `Order` into the mock
provider's `POST /deliveries` contract, sends the stable provider
`submissionKey` as `Idempotency-Key`, propagates the correlation ID, enforces an
HTTP timeout, and converts untrusted provider responses into safe typed results
or errors.

The client returns only `providerOrderId`, `status`, and `acceptedAt`. It does
not expose raw provider error bodies, authorization values, or submitted
addresses through its errors.

## Failure classification

| Condition | Client code | Retryable | Reason |
| --- | --- | --- | --- |
| HTTP timeout or abort | `TIMEOUT` | Yes | Provider acceptance may have happened before the response was lost. |
| Network failure | `NETWORK_ERROR` | Yes | The provider may be temporarily unreachable and the outcome can be uncertain. |
| `429` | `RATE_LIMITED` | Yes | Retry later; preserve a valid `Retry-After` hint, capped at 60 seconds. |
| `5xx` | `PROVIDER_UNAVAILABLE` | Yes | Provider-side availability failure. |
| Unexpected status or unusable success JSON | `INVALID_RESPONSE` | Yes | Treat acceptance as uncertain; retry safely with the same idempotency key. |
| `401` or `403` | `AUTHENTICATION_FAILED` | No | Configuration or credentials require operator action. |
| `409` | `IDEMPOTENCY_CONFLICT` | No | Repeating the request cannot repair conflicting provider data. |
| Other `4xx` | `REQUEST_REJECTED` | No | The request or contract must be corrected. |

Retryable means the future SQS worker may leave the message unacknowledged for
another delivery attempt. It does not mean the HTTP client loops internally.

## Retry ownership and bounds

The vendor client makes exactly one HTTP request per `submitDelivery` call. It
does not sleep or retry inside the Lambda invocation, including for `429`.

The future processing path owns retries as follows:

1. The worker calls the client once and reports retryable SQS records as failed.
2. The Lambda SQS event-source mapping makes the record available again after
   the queue visibility timeout.
3. SQS `maxReceiveCount` bounds total deliveries and moves exhausted work to the
   DLQ. Its exact value will be configured and reviewed with the asynchronous
   infrastructure.
4. The unchanged provider `submissionKey` protects the external side effect
   across every attempt, including uncertain timeout and malformed-response
   outcomes.

Non-retryable provider failures are application outcomes for the future worker
to record safely before acknowledging the SQS message. Unexpected worker or
Lambda failures remain retryable through the same bounded queue mechanism.

This division prevents nested client, Lambda, and queue retry loops from
multiplying calls, Lambda duration, and cost.
