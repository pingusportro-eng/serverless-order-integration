import { describe, expect, it } from 'vitest';

import type {
  BindStripePaymentIntentInput,
  BindStripePaymentIntentResult,
} from '../../src/application/payment-repository.js';
import {
  PaymentPreparationNotAllowedError,
  prepareStripePaymentIntent,
  StripePaymentIntentContractError,
} from '../../src/application/prepare-stripe-payment-intent.js';
import type { Order } from '../../src/domain/order.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { FakeStripePaymentClient } from '../../src/integrations/fake-stripe-payment-client.js';
import { createOrderFixture } from '../fixtures/order.js';

const CHANGED_AT = '2026-08-07T09:30:00.000Z';

function awaitingPaymentOrder(overrides: Partial<Order> = {}): Order {
  const order = createOrderFixture({ status: 'AWAITING_PAYMENT', ...overrides });
  return {
    ...order,
    payment: createInitialOrderPayment(
      order.total,
      `stripe-payment-intent:${order.merchantId}:${order.orderId}`,
      order.createdAt,
    ),
  };
}

async function storeOrder(repository: InMemoryOrderRepository, order: Order): Promise<void> {
  await repository.create({
    order,
    idempotencyKey: `create-${order.orderId}`,
    requestFingerprint: `create-fingerprint-${order.orderId}`,
    mutation: {
      kind: 'ORDER_CREATED',
      correlationId: 'corr_create_payment_fixture',
      causationId: 'request_create_payment_fixture',
    },
  });
}

function command(order: Order) {
  return {
    merchantId: order.merchantId,
    orderId: order.orderId,
    correlationId: 'corr_prepare_payment_123',
    causationId: 'request_prepare_payment_123',
  };
}

class FailFirstPaymentBindingRepository extends InMemoryOrderRepository {
  private shouldFail = true;

  override async bindStripePaymentIntent(
    input: BindStripePaymentIntentInput,
  ): Promise<BindStripePaymentIntentResult> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('Synthetic persistence outage after Stripe accepted the request.');
    }
    return super.bindStripePaymentIntent(input);
  }
}

class ConcurrentWinnerRepository extends InMemoryOrderRepository {
  private shouldInjectWinner = true;

  override async bindStripePaymentIntent(
    input: BindStripePaymentIntentInput,
  ): Promise<BindStripePaymentIntentResult> {
    if (this.shouldInjectWinner) {
      this.shouldInjectWinner = false;
      await super.bindStripePaymentIntent(input);
    }
    return super.bindStripePaymentIntent(input);
  }
}

describe('prepareStripePaymentIntent', () => {
  it('creates and atomically binds a Stripe PaymentIntent', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);

    const result = await prepareStripePaymentIntent(
      { repository, stripeClient, now: () => new Date(CHANGED_AT) },
      command(order),
    );

    expect(result.outcome).toBe('created');
    expect(result.stripePaymentIntent.clientSecret).toContain('_secret_');
    expect(result.order).toMatchObject({
      status: 'AWAITING_PAYMENT',
      version: 2,
      payment: {
        status: 'REQUIRES_PAYMENT_METHOD',
        stripePaymentIntentId: result.stripePaymentIntent.stripePaymentIntentId,
      },
    });
  });

  it('replays the same HTTP operation without creating another PaymentIntent', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const dependencies = { repository, stripeClient, now: () => new Date(CHANGED_AT) };

    const first = await prepareStripePaymentIntent(dependencies, command(order));
    const replay = await prepareStripePaymentIntent(dependencies, command(order));

    expect(replay).toMatchObject({
      outcome: 'replayed',
      order: first.order,
      stripePaymentIntent: {
        stripePaymentIntentId: first.stripePaymentIntent.stripePaymentIntentId,
      },
    });
    expect(stripeClient.createCalls).toHaveLength(1);
    expect(stripeClient.retrieveCalls).toEqual([first.stripePaymentIntent.stripePaymentIntentId]);
  });

  it('recovers an ambiguous Stripe timeout using the stable server key', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient({ scenarios: ['timeout'] });
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const dependencies = { repository, stripeClient, now: () => new Date(CHANGED_AT) };

    await expect(prepareStripePaymentIntent(dependencies, command(order))).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    const recovered = await prepareStripePaymentIntent(dependencies, command(order));

    expect(recovered.outcome).toBe('created');
    expect(stripeClient.createCalls).toHaveLength(2);
    expect(stripeClient.createCalls[0]?.stripeCreationKey).toBe(
      stripeClient.createCalls[1]?.stripeCreationKey,
    );
  });

  it('recovers when Stripe succeeds but the first persistence attempt fails', async () => {
    const repository = new FailFirstPaymentBindingRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const dependencies = { repository, stripeClient, now: () => new Date(CHANGED_AT) };

    await expect(prepareStripePaymentIntent(dependencies, command(order))).rejects.toThrow(
      'Synthetic persistence outage',
    );
    const recovered = await prepareStripePaymentIntent(dependencies, command(order));

    expect(recovered.outcome).toBe('created');
    expect(stripeClient.createCalls).toHaveLength(2);
    expect(recovered.stripePaymentIntent.stripePaymentIntentId).toContain('pi_fake_');
  });

  it('returns the committed winner when another request binds the same Stripe intent first', async () => {
    const repository = new ConcurrentWinnerRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);

    const result = await prepareStripePaymentIntent(
      { repository, stripeClient, now: () => new Date(CHANGED_AT) },
      command(order),
    );

    expect(result.outcome).toBe('replayed');
    expect(result.order.version).toBe(2);
    expect(stripeClient.createCalls).toHaveLength(1);
    expect(stripeClient.retrieveCalls).toEqual([result.stripePaymentIntent.stripePaymentIntentId]);
  });

  it('does not persist inconsistent Stripe ownership data', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient({ scenarios: ['conflicting-data'] });
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);

    await expect(
      prepareStripePaymentIntent(
        { repository, stripeClient, now: () => new Date(CHANGED_AT) },
        command(order),
      ),
    ).rejects.toBeInstanceOf(StripePaymentIntentContractError);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
  });

  it('does not persist a PaymentIntent with an unexpected capture method', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const mismatchedStripeClient = {
      retrievePaymentIntent: stripeClient.retrievePaymentIntent.bind(stripeClient),
      createPaymentIntent: async (
        input: Parameters<typeof stripeClient.createPaymentIntent>[0],
      ) => ({
        ...(await stripeClient.createPaymentIntent(input)),
        captureMethod: 'MANUAL' as const,
        status: 'REQUIRES_CAPTURE' as const,
      }),
    };

    await expect(
      prepareStripePaymentIntent(
        { repository, stripeClient: mismatchedStripeClient, now: () => new Date(CHANGED_AT) },
        command(order),
      ),
    ).rejects.toMatchObject({ field: 'captureMethod' });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
  });

  it('rejects an order that is not awaiting an initial payment', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient();
    const order = createOrderFixture();
    await storeOrder(repository, order);

    await expect(
      prepareStripePaymentIntent(
        { repository, stripeClient, now: () => new Date(CHANGED_AT) },
        command(order),
      ),
    ).rejects.toBeInstanceOf(PaymentPreparationNotAllowedError);
    expect(stripeClient.createCalls).toHaveLength(0);
  });

  it('persists generic Stripe failure evidence without restricting it to card declines', async () => {
    const repository = new InMemoryOrderRepository();
    const stripeClient = new FakeStripePaymentClient({ scenarios: ['decline'] });
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);

    const result = await prepareStripePaymentIntent(
      { repository, stripeClient, now: () => new Date(CHANGED_AT) },
      command(order),
    );

    expect(result.order.payment?.lastFailure).toEqual({
      reasonCode: 'card_declined',
      occurredAt: CHANGED_AT,
    });
  });
});
