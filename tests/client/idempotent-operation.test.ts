import { describe, expect, it } from 'vitest';

import {
  beginIdempotentOperationAttempt,
  createIdempotentOperation,
  InvalidIdempotentOperationError,
  markIdempotentOperationOutcome,
} from '../../src/client/idempotent-operation.js';

describe('client idempotent operation journal contract', () => {
  it('retries an ambiguous operation with the same key and frozen request identity', () => {
    const request = {
      merchantOrderId: 'merchant-order-123',
      total: { amountMinor: 2500, currency: 'RON' },
    };
    const ready = createIdempotentOperation('create-order-key-123', request, 'fingerprint-123');
    request.total.amountMinor = 9999;
    const firstAttempt = beginIdempotentOperationAttempt(ready, 'fingerprint-123');
    const ambiguous = markIdempotentOperationOutcome(firstAttempt, 'OUTCOME_UNKNOWN');
    const retry = beginIdempotentOperationAttempt(ambiguous, 'fingerprint-123');

    expect(retry).toMatchObject({
      idempotencyKey: 'create-order-key-123',
      request: {
        merchantOrderId: 'merchant-order-123',
        total: { amountMinor: 2500, currency: 'RON' },
      },
      requestFingerprint: 'fingerprint-123',
      state: 'IN_FLIGHT',
      attemptCount: 2,
    });
    expect(Object.isFrozen(retry.request)).toBe(true);
    expect(Object.isFrozen(retry.request.total)).toBe(true);
  });

  it('rejects changed payload identity under an existing key', () => {
    const operation = createIdempotentOperation(
      'payment-key-123',
      { orderId: 'ord_123' },
      'fingerprint-original',
    );

    expect(() => beginIdempotentOperationAttempt(operation, 'fingerprint-changed')).toThrow(
      InvalidIdempotentOperationError,
    );
  });

  it('does not retry a known terminal outcome or overlap an in-flight attempt', () => {
    const ready = createIdempotentOperation(
      'payment-key-123',
      { orderId: 'ord_123' },
      'fingerprint-123',
    );
    const inFlight = beginIdempotentOperationAttempt(ready, 'fingerprint-123');
    const succeeded = markIdempotentOperationOutcome(inFlight, 'SUCCEEDED');

    expect(() => beginIdempotentOperationAttempt(inFlight, 'fingerprint-123')).toThrow(
      InvalidIdempotentOperationError,
    );
    expect(() => beginIdempotentOperationAttempt(succeeded, 'fingerprint-123')).toThrow(
      InvalidIdempotentOperationError,
    );
  });
});
