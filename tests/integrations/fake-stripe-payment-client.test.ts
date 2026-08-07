import { describe, expect, it } from 'vitest';

import type { CreateStripePaymentIntentInput } from '../../src/application/stripe-payment-client.js';
import { asMerchantId, asOrderId } from '../../src/domain/order.js';
import {
  FakeStripePaymentClient,
  type FakeStripeScenario,
} from '../../src/integrations/fake-stripe-payment-client.js';

function input(overrides: Partial<CreateStripePaymentIntentInput> = {}) {
  return {
    merchantId: asMerchantId('mrc_stripe_fake'),
    orderId: asOrderId('ord_stripe_fake'),
    amount: { amountMinor: 2500, currency: 'RON' },
    stripeCreationKey: 'stripe-payment-intent:mrc_stripe_fake:ord_stripe_fake',
    ...overrides,
  } satisfies CreateStripePaymentIntentInput;
}

describe('fake Stripe payment client', () => {
  it.each([
    ['requires-payment-method', 'REQUIRES_PAYMENT_METHOD', undefined],
    ['success', 'SUCCEEDED', undefined],
    ['decline', 'REQUIRES_PAYMENT_METHOD', 'card_declined'],
    ['requires-action', 'REQUIRES_ACTION', undefined],
    ['processing', 'PROCESSING', undefined],
    ['cancellation', 'CANCELLED', undefined],
  ] as const)(
    'provides the deterministic %s scenario',
    async (scenario, expectedStatus, expectedFailure) => {
      const client = new FakeStripePaymentClient({ scenarios: [scenario] });

      const result = await client.createPaymentIntent(input());

      expect(result).toMatchObject({
        status: expectedStatus,
        amount: { amountMinor: 2500, currency: 'RON' },
        merchantId: 'mrc_stripe_fake',
        orderId: 'ord_stripe_fake',
        captureMethod: 'AUTOMATIC',
      });
      expect(result.stripePaymentIntentId).toMatch(/^pi_fake_/);
      expect(result.clientSecret).toContain('_secret_synthetic');
      expect(result.lastFailureReasonCode).toBe(expectedFailure);
    },
  );

  it('recovers an ambiguously successful timeout with the stable creation key', async () => {
    const client = new FakeStripePaymentClient({ scenarios: ['timeout'] });

    await expect(client.createPaymentIntent(input())).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    const replay = await client.createPaymentIntent(input());

    expect(replay.stripePaymentIntentId).toMatch(/^pi_fake_/);
    expect(replay.status).toBe('REQUIRES_PAYMENT_METHOD');
    expect(client.createCalls).toHaveLength(2);
  });

  it('rejects conflicting reuse of one Stripe creation key', async () => {
    const client = new FakeStripePaymentClient({ scenarios: ['success'] });
    await client.createPaymentIntent(input());

    await expect(
      client.createPaymentIntent(input({ amount: { amountMinor: 3000, currency: 'RON' } })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  it('can return valid but conflicting ownership data for application tests', async () => {
    const client = new FakeStripePaymentClient({ scenarios: ['conflicting-data'] });

    const result = await client.createPaymentIntent(input());

    expect(result.merchantId).toBe('mrc_stripe_fake-conflict');
    expect(result.orderId).toBe('ord_stripe_fake');
  });

  it('retrieves and deliberately advances a fake PaymentIntent', async () => {
    const client = new FakeStripePaymentClient({ scenarios: ['decline'] });
    const created = await client.createPaymentIntent(input());

    client.setPaymentIntentStatus(created.stripePaymentIntentId, 'SUCCEEDED');

    const retrieved = await client.retrievePaymentIntent(created.stripePaymentIntentId);
    expect(retrieved).toMatchObject({
      stripePaymentIntentId: created.stripePaymentIntentId,
      status: 'SUCCEEDED',
    });
    expect(retrieved.lastFailureReasonCode).toBeUndefined();
    expect(client.retrieveCalls).toEqual([created.stripePaymentIntentId]);
  });

  it('rejects retrieval of an unknown PaymentIntent', async () => {
    const client = new FakeStripePaymentClient();

    await expect(client.retrievePaymentIntent('pi_fake_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
      statusCode: 404,
    });
  });

  it.each([
    { amount: { amountMinor: 0, currency: 'RON' }, message: 'positive safe integer' },
    { amount: { amountMinor: 100, currency: 'ron' }, message: 'uppercase letters' },
  ])('validates create input before consuming a scenario', async ({ amount, message }) => {
    const scenarios: FakeStripeScenario[] = ['success'];
    const client = new FakeStripePaymentClient({ scenarios });

    await expect(client.createPaymentIntent(input({ amount }))).rejects.toThrow(message);
    await expect(client.createPaymentIntent(input())).resolves.toMatchObject({
      status: 'SUCCEEDED',
    });
  });
});
