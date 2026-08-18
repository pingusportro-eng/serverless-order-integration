import { describe, expect, it, vi } from 'vitest';

import type { PreparedPaymentIntent } from '../src/api/contracts.js';
import {
  PaymentPreparationOutcomeUnknownError,
  PaymentPreparationRejectedError,
  type OrdersApiClient,
} from '../src/api/orders-api-client.js';
import { PaymentPreparationError, PreparePaymentIntent } from '../src/prepare-payment-intent.js';

const PAYMENT: PreparedPaymentIntent = {
  orderId: 'ord_12345678',
  orderVersion: 2,
  stripePaymentIntentId: 'pi_12345678',
  status: 'REQUIRES_PAYMENT_METHOD',
  amount: { amountMinor: 1299, currency: 'RON' },
  clientSecret: 'pi_12345678_secret_do-not-expose',
};

function client(preparePaymentIntent: OrdersApiClient['preparePaymentIntent']): OrdersApiClient {
  return {
    createOrder: vi.fn<OrdersApiClient['createOrder']>(),
    preparePaymentIntent,
    getOrder: vi.fn<OrdersApiClient['getOrder']>(),
  };
}

describe('payment preparation controller', () => {
  it('retries an ambiguous outcome for the same order and correlation ID', async () => {
    const preparePaymentIntent = vi
      .fn<OrdersApiClient['preparePaymentIntent']>()
      .mockRejectedValueOnce(new PaymentPreparationOutcomeUnknownError())
      .mockResolvedValueOnce(PAYMENT);
    const preparation = new PreparePaymentIntent(client(preparePaymentIntent), () => 'attempt-123');

    await expect(preparation.prepare('ord_12345678')).rejects.toBeInstanceOf(
      PaymentPreparationOutcomeUnknownError,
    );
    expect(preparation.snapshot()).toMatchObject({ state: 'RETRYABLE', attemptCount: 1 });
    await expect(preparation.retry()).resolves.toEqual(PAYMENT);

    expect(preparePaymentIntent).toHaveBeenCalledTimes(2);
    expect(preparePaymentIntent.mock.calls[1]).toEqual(preparePaymentIntent.mock.calls[0]);
    expect(preparation.snapshot()).toMatchObject({
      state: 'SUCCEEDED',
      attemptCount: 2,
      stripePaymentIntentId: 'pi_12345678',
      amountLabel: '12.99 RON',
    });
  });

  it('keeps the client secret in memory but outside the renderable snapshot', async () => {
    const preparation = new PreparePaymentIntent(
      client(vi.fn<OrdersApiClient['preparePaymentIntent']>().mockResolvedValue(PAYMENT)),
      () => 'attempt-123',
    );

    await preparation.prepare('ord_12345678');

    expect(preparation.clientSecret()).toBe(PAYMENT.clientSecret);
    expect(JSON.stringify(preparation.snapshot())).not.toContain(PAYMENT.clientSecret);
    expect(preparation.snapshot()).not.toHaveProperty('clientSecret');
  });

  it('records a definite rejection separately and does not retry it', async () => {
    const rejected = new PaymentPreparationRejectedError(409, {
      status: 409,
      code: 'PAYMENT_PREPARATION_NOT_ALLOWED',
      title: 'Payment preparation not allowed',
      detail: 'The order cannot prepare a payment.',
    });
    const preparation = new PreparePaymentIntent(
      client(vi.fn<OrdersApiClient['preparePaymentIntent']>().mockRejectedValue(rejected)),
      () => 'attempt-123',
    );

    await expect(preparation.prepare('ord_12345678')).rejects.toBe(rejected);
    expect(preparation.snapshot()).toMatchObject({
      state: 'REJECTED',
      error: 'The order cannot prepare a payment.',
    });
    expect(() => preparation.retry()).toThrow(PaymentPreparationError);
  });

  it('blocks concurrent attempts', async () => {
    let resolvePayment: ((payment: PreparedPaymentIntent) => void) | undefined;
    const preparePaymentIntent = vi.fn(
      () =>
        new Promise<PreparedPaymentIntent>((resolve) => {
          resolvePayment = resolve;
        }),
    );
    const preparation = new PreparePaymentIntent(client(preparePaymentIntent), () => 'attempt-123');
    const pending = preparation.prepare('ord_12345678');

    expect(preparation.snapshot().state).toBe('IN_FLIGHT');
    expect(() => preparation.prepare('ord_12345678')).toThrow(PaymentPreparationError);
    resolvePayment?.(PAYMENT);
    await expect(pending).resolves.toEqual(PAYMENT);
  });
});
