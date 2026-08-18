import { describe, expect, it, vi } from 'vitest';

import type { TrackedOrder } from '../src/api/contracts.js';
import {
  OrderTrackingRejectedError,
  OrderTrackingUnavailableError,
  type OrdersApiClient,
} from '../src/api/orders-api-client.js';
import {
  OrderJourneyTracker,
  type OrderJourneyTrackingSnapshot,
} from '../src/order-journey-tracker.js';

function client(getOrder: OrdersApiClient['getOrder']): OrdersApiClient {
  return {
    createOrder: vi.fn<OrdersApiClient['createOrder']>(),
    preparePaymentIntent: vi.fn<OrdersApiClient['preparePaymentIntent']>(),
    getOrder,
  };
}

const PENDING: TrackedOrder = {
  orderId: 'ord_12345678',
  status: 'PENDING_SUBMISSION',
  version: 3,
  payment: { status: 'SUCCEEDED' },
};

const DELIVERED: TrackedOrder = {
  orderId: 'ord_12345678',
  status: 'DELIVERED',
  version: 6,
  payment: { status: 'SUCCEEDED' },
};

function tracker(getOrder: OrdersApiClient['getOrder'], maxAttempts = 3) {
  return new OrderJourneyTracker(client(getOrder), {
    maxAttempts,
    intervalMs: 0,
    createId: () => 'tracking-123',
    wait: async () => Promise.resolve(),
  });
}

describe('OrderJourneyTracker', () => {
  it('polls stored state until delivery reaches its successful terminal status', async () => {
    const getOrder = vi
      .fn<OrdersApiClient['getOrder']>()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(DELIVERED);
    const updates: OrderJourneyTrackingSnapshot[] = [];

    const result = await tracker(getOrder).start('ord_12345678', (snapshot) => {
      updates.push(snapshot);
    });

    expect(result).toMatchObject({ state: 'DELIVERED', attemptCount: 2, order: DELIVERED });
    const firstCall = getOrder.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      orderId: 'ord_12345678',
      correlationId: 'ui-track-order:ord_12345678:tracking-123',
    });
    expect(firstCall?.signal).toBeInstanceOf(AbortSignal);
    expect(updates.some((snapshot) => snapshot.order?.status === 'PENDING_SUBMISSION')).toBe(true);
  });

  it('keeps a transient read failure inside the fixed polling budget', async () => {
    const getOrder = vi
      .fn<OrdersApiClient['getOrder']>()
      .mockRejectedValueOnce(new OrderTrackingUnavailableError('Temporary API failure.'))
      .mockResolvedValueOnce(DELIVERED);

    await expect(tracker(getOrder).start('ord_12345678', () => undefined)).resolves.toMatchObject({
      state: 'DELIVERED',
      attemptCount: 2,
    });
  });

  it.each([
    ['SUBMISSION_FAILED', 'SUCCEEDED'],
    ['DELIVERY_FAILED', 'SUCCEEDED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)('stops for operator attention on %s', async (status, paymentStatus) => {
    const getOrder = vi.fn<OrdersApiClient['getOrder']>().mockResolvedValue({
      ...PENDING,
      status,
      payment: { status: paymentStatus },
    });

    await expect(tracker(getOrder).start('ord_12345678', () => undefined)).resolves.toMatchObject({
      state: 'ATTENTION_REQUIRED',
      attemptCount: 1,
      error: `Order processing stopped in ${status}.`,
    });
  });

  it('stops immediately when the API definitively rejects tracking', async () => {
    const getOrder = vi.fn<OrdersApiClient['getOrder']>().mockRejectedValue(
      new OrderTrackingRejectedError(401, {
        status: 401,
        code: 'UNAUTHORIZED',
        title: 'Unauthorized',
        detail: 'A valid access token is required.',
      }),
    );

    await expect(tracker(getOrder).start('ord_12345678', () => undefined)).resolves.toMatchObject({
      state: 'REJECTED',
      attemptCount: 1,
      error: 'A valid access token is required.',
    });
    expect(getOrder).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured maximum rather than polling forever', async () => {
    const getOrder = vi.fn<OrdersApiClient['getOrder']>().mockResolvedValue(PENDING);

    await expect(
      tracker(getOrder, 2).start('ord_12345678', () => undefined),
    ).resolves.toMatchObject({
      state: 'TIMED_OUT',
      attemptCount: 2,
      order: PENDING,
      error: 'Tracking stopped after 2 bounded attempts.',
    });
    expect(getOrder).toHaveBeenCalledTimes(2);
  });
});
