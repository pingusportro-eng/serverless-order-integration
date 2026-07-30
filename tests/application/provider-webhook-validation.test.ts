import { describe, expect, it } from 'vitest';

import { validateProviderWebhookEvent } from '../../src/application/provider-webhook-validation.js';

describe('provider webhook validation', () => {
  it('normalizes a valid delivery failure', () => {
    const result = validateProviderWebhookEvent({
      eventId: 'provider-event-1001',
      eventType: 'DELIVERY_FAILED',
      occurredAt: '2026-07-21T12:35:00Z',
      deliveryProviderOrderId: 'delivery-789',
      failure: {
        stage: 'DELIVERY',
        reasonCode: 'CUSTOMER_UNAVAILABLE',
        summary: 'The customer could not receive the order.',
        occurredAt: '2026-07-21T12:34:59Z',
      },
    });

    expect(result).toEqual({
      valid: true,
      value: {
        eventId: 'provider-event-1001',
        eventType: 'DELIVERY_FAILED',
        occurredAt: '2026-07-21T12:35:00.000Z',
        deliveryProviderOrderId: 'delivery-789',
        failure: {
          stage: 'DELIVERY',
          reasonCode: 'CUSTOMER_UNAVAILABLE',
          summary: 'The customer could not receive the order.',
          occurredAt: '2026-07-21T12:34:59.000Z',
        },
      },
    });
  });

  it('rejects unknown fields and failure details on a successful event', () => {
    const result = validateProviderWebhookEvent({
      eventId: 'provider-event-1002',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: 'not-a-date',
      deliveryProviderOrderId: 'delivery-789',
      failure: {
        stage: 'SUBMISSION',
        reasonCode: 'bad-code',
        summary: '',
        occurredAt: 'not-a-date',
      },
      unexpected: true,
    });

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error('Expected invalid webhook values.');
    }
    expect(result.issues).toContainEqual({ pointer: '#/unexpected', detail: 'is not allowed' });
    expect(result.issues).toContainEqual({
      pointer: '#/occurredAt',
      detail: 'must be a valid date-time',
    });
    expect(result.issues).toContainEqual({
      pointer: '#/failure',
      detail: 'is only allowed for DELIVERY_FAILED',
    });
  });
});
