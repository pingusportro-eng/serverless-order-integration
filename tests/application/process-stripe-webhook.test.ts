import { beforeEach, describe, expect, it } from 'vitest';

import {
  processStripeWebhook,
  type ProcessStripeWebhookCommand,
} from '../../src/application/process-stripe-webhook.js';
import { StripeEventIdConflictError } from '../../src/application/stripe-webhook-repository.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { FakeStripePaymentClient } from '../../src/integrations/fake-stripe-payment-client.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

const NOW = new Date('2026-08-11T08:00:00.000Z');

function awaitingOrder() {
  const base = createOrderFixture({ status: 'AWAITING_PAYMENT' });
  return {
    ...base,
    payment: createInitialOrderPayment(
      base.total,
      `stripe-payment-intent:${base.merchantId}:${base.orderId}`,
      base.createdAt,
    ),
  };
}

function command(
  overrides: Partial<ProcessStripeWebhookCommand> = {},
): ProcessStripeWebhookCommand {
  return {
    eventId: 'evt_stripe_webhook_123456789',
    eventType: 'payment_intent.created',
    stripePaymentIntentId: 'pi_placeholder',
    eventFingerprint: 'a'.repeat(64),
    correlationId: 'stripe-webhook-request-123',
    ...overrides,
  };
}

describe('processStripeWebhook', () => {
  let repository: InMemoryOrderRepository;
  let stripeClient: FakeStripePaymentClient;
  let order: ReturnType<typeof awaitingOrder>;

  beforeEach(async () => {
    repository = new InMemoryOrderRepository();
    stripeClient = new FakeStripePaymentClient();
    order = awaitingOrder();
    await repository.create({
      order,
      idempotencyKey: `create-${order.orderId}`,
      requestFingerprint: `fingerprint-${order.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_create_payment_order',
        causationId: 'request_create_payment_order',
      },
    });
  });

  async function createIntent() {
    return stripeClient.createPaymentIntent({
      merchantId: order.merchantId,
      orderId: order.orderId,
      amount: order.total,
      stripeCreationKey: order.payment.stripeCreationKey,
    });
  }

  it('repairs the missing mapping, tracks payment, and releases delivery only after success', async () => {
    const intent = await createIntent();
    const dependencies = { repository, stripeClient, now: () => NOW };

    await expect(
      processStripeWebhook(
        dependencies,
        command({ stripePaymentIntentId: intent.stripePaymentIntentId }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      order: {
        status: 'AWAITING_PAYMENT',
        version: 2,
        payment: {
          status: 'REQUIRES_PAYMENT_METHOD',
          stripePaymentIntentId: intent.stripePaymentIntentId,
        },
      },
    });
    await expect(
      repository.getByStripePaymentIntentId(intent.stripePaymentIntentId),
    ).resolves.toMatchObject({ orderId: order.orderId, version: 2 });

    stripeClient.setPaymentIntentStatus(intent.stripePaymentIntentId, 'SUCCEEDED');
    const succeededCommand = command({
      eventId: 'evt_stripe_succeeded_123456789',
      eventType: 'payment_intent.succeeded',
      stripePaymentIntentId: intent.stripePaymentIntentId,
      eventFingerprint: 'b'.repeat(64),
    });
    await expect(processStripeWebhook(dependencies, succeededCommand)).resolves.toMatchObject({
      outcome: 'applied',
      order: {
        status: 'PENDING_SUBMISSION',
        version: 3,
        payment: { status: 'SUCCEEDED' },
      },
    });
    await expect(processStripeWebhook(dependencies, succeededCommand)).resolves.toMatchObject({
      outcome: 'ignored',
      order: { status: 'PENDING_SUBMISSION', version: 3 },
    });
  });

  it('keeps a declined payment blocked and records only a safe failure code', async () => {
    const intent = await createIntent();
    stripeClient.setPaymentIntentStatus(
      intent.stripePaymentIntentId,
      'REQUIRES_PAYMENT_METHOD',
      'card_declined',
    );

    await expect(
      processStripeWebhook(
        { repository, stripeClient, now: () => NOW },
        command({
          eventType: 'payment_intent.payment_failed',
          stripePaymentIntentId: intent.stripePaymentIntentId,
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      order: {
        status: 'AWAITING_PAYMENT',
        payment: {
          status: 'REQUIRES_PAYMENT_METHOD',
          lastFailure: { reasonCode: 'card_declined', occurredAt: NOW.toISOString() },
        },
      },
    });
  });

  it('ignores a delayed failure event when current Stripe state is already successful', async () => {
    const intent = await createIntent();
    const dependencies = { repository, stripeClient, now: () => NOW };
    stripeClient.setPaymentIntentStatus(intent.stripePaymentIntentId, 'SUCCEEDED');

    await processStripeWebhook(
      dependencies,
      command({
        eventId: 'evt_stripe_succeeded_before_delayed_failure',
        eventType: 'payment_intent.succeeded',
        stripePaymentIntentId: intent.stripePaymentIntentId,
        eventFingerprint: 'd'.repeat(64),
      }),
    );

    await expect(
      processStripeWebhook(
        dependencies,
        command({
          eventId: 'evt_stripe_delayed_payment_failure',
          eventType: 'payment_intent.payment_failed',
          stripePaymentIntentId: intent.stripePaymentIntentId,
          eventFingerprint: 'e'.repeat(64),
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'ignored',
      order: { status: 'PENDING_SUBMISSION', payment: { status: 'SUCCEEDED' }, version: 2 },
    });
  });

  it('durably classifies a verified amount mismatch without releasing delivery', async () => {
    const intent = await createIntent();
    const stripeClientWithMismatch = {
      createPaymentIntent: stripeClient.createPaymentIntent.bind(stripeClient),
      retrievePaymentIntent: async () => ({
        ...(await stripeClient.retrievePaymentIntent(intent.stripePaymentIntentId)),
        amount: { amountMinor: order.total.amountMinor + 1, currency: order.total.currency },
      }),
    };
    const mismatched = command({ stripePaymentIntentId: intent.stripePaymentIntentId });

    await expect(
      processStripeWebhook(
        { repository, stripeClient: stripeClientWithMismatch, now: () => NOW },
        mismatched,
      ),
    ).resolves.toEqual({
      outcome: 'reconciliation_required',
      reasonCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
      recorded: true,
      order,
    });
    await expect(
      processStripeWebhook(
        { repository, stripeClient: stripeClientWithMismatch, now: () => NOW },
        mismatched,
      ),
    ).resolves.toMatchObject({
      outcome: 'reconciliation_required',
      reasonCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
      recorded: false,
    });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
    await expect(
      repository.getByStripePaymentIntentId(intent.stripePaymentIntentId),
    ).resolves.toBeUndefined();
  });

  it('rejects the same signed event ID with different raw values', async () => {
    const intent = await createIntent();
    const dependencies = { repository, stripeClient, now: () => NOW };
    const first = command({ stripePaymentIntentId: intent.stripePaymentIntentId });
    await processStripeWebhook(dependencies, first);

    await expect(
      processStripeWebhook(dependencies, { ...first, eventFingerprint: 'c'.repeat(64) }),
    ).rejects.toBeInstanceOf(StripeEventIdConflictError);
  });

  it('converges safely when two different events race on the same PaymentIntent', async () => {
    const intent = await createIntent();
    const dependencies = { repository, stripeClient, now: () => NOW };
    stripeClient.setPaymentIntentStatus(intent.stripePaymentIntentId, 'SUCCEEDED');
    const created = command({
      eventId: 'evt_stripe_concurrent_created_123',
      eventType: 'payment_intent.created',
      stripePaymentIntentId: intent.stripePaymentIntentId,
      eventFingerprint: 'f'.repeat(64),
    });
    const succeeded = command({
      eventId: 'evt_stripe_concurrent_succeeded_123',
      eventType: 'payment_intent.succeeded',
      stripePaymentIntentId: intent.stripePaymentIntentId,
      eventFingerprint: '1'.repeat(64),
    });

    const results = await Promise.all([
      processStripeWebhook(dependencies, created),
      processStripeWebhook(dependencies, succeeded),
    ]);

    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['applied', 'ignored']);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'PENDING_SUBMISSION',
      version: 2,
      payment: {
        status: 'SUCCEEDED',
        stripePaymentIntentId: intent.stripePaymentIntentId,
      },
    });
    await expect(processStripeWebhook(dependencies, created)).resolves.toMatchObject({
      outcome: 'ignored',
      order: { status: 'PENDING_SUBMISSION', version: 2 },
    });
    await expect(processStripeWebhook(dependencies, succeeded)).resolves.toMatchObject({
      outcome: 'ignored',
      order: { status: 'PENDING_SUBMISSION', version: 2 },
    });
  });
});
