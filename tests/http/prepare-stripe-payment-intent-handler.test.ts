import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StripePaymentIntentBindingConflictError } from '../../src/application/payment-repository.js';
import { StripeClientError } from '../../src/application/stripe-payment-client.js';
import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { handlePrepareStripePaymentIntent } from '../../src/http/prepare-stripe-payment-intent-handler.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { FakeStripePaymentClient } from '../../src/integrations/fake-stripe-payment-client.js';
import { createOrderFixture } from '../fixtures/order.js';

const CHANGED_AT = '2026-08-11T09:30:00.000Z';

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
      correlationId: 'corr_create_payment_handler_fixture',
      causationId: 'request_create_payment_handler_fixture',
    },
  });
}

function request(order: Order) {
  return {
    merchantId: order.merchantId,
    requestId: 'request_prepare_payment_123',
    orderId: order.orderId,
    headers: { 'x-correlation-id': 'corr_prepare_payment_123' },
  };
}

describe('POST /orders/{orderId}/payment-intents handler', () => {
  let repository: InMemoryOrderRepository;
  let stripeClient: FakeStripePaymentClient;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    stripeClient = new FakeStripePaymentClient();
  });

  it('returns 201 with the safely prepared PaymentIntent', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const bindStripePaymentIntent = vi.spyOn(repository, 'bindStripePaymentIntent');

    const response = await handlePrepareStripePaymentIntent(
      { repository, stripeClient, now: () => new Date(CHANGED_AT) },
      request(order),
    );

    expect(response).toMatchObject({
      statusCode: 201,
      headers: {
        'Cache-Control': 'no-store',
        ETag: '"2"',
        'X-Request-Id': 'request_prepare_payment_123',
      },
      body: {
        orderId: order.orderId,
        orderVersion: 2,
        status: 'REQUIRES_PAYMENT_METHOD',
        amount: order.total,
      },
    });
    expect(response.body).toHaveProperty('stripePaymentIntentId');
    expect(response.body).toHaveProperty('clientSecret');
    expect(response.body).not.toHaveProperty('stripeCreationKey');
    expect(bindStripePaymentIntent.mock.calls[0]?.[0].mutation).toMatchObject({
      correlationId: 'corr_prepare_payment_123',
      causationId: 'request_prepare_payment_123',
    });
  });

  it('returns 200 and the same PaymentIntent on a natural replay', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const dependencies = { repository, stripeClient, now: () => new Date(CHANGED_AT) };

    const first = await handlePrepareStripePaymentIntent(dependencies, request(order));
    const replay = await handlePrepareStripePaymentIntent(dependencies, {
      ...request(order),
      requestId: 'request_prepare_payment_replay',
    });

    expect(first.statusCode).toBe(201);
    if (!('stripePaymentIntentId' in first.body)) {
      throw new Error('Expected a successful first PaymentIntent response.');
    }
    expect(replay).toMatchObject({
      statusCode: 200,
      headers: { ETag: '"2"', 'Cache-Control': 'no-store' },
      body: {
        orderVersion: 2,
        stripePaymentIntentId: first.body.stripePaymentIntentId,
        clientSecret: first.body.clientSecret,
      },
    });
    expect(stripeClient.createCalls).toHaveLength(1);
  });

  it('uses the authenticated merchant boundary and hides malformed or inaccessible orders', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const dependencies = { repository, stripeClient };

    const malformed = await handlePrepareStripePaymentIntent(dependencies, {
      ...request(order),
      orderId: 'invalid',
    });
    const hidden = await handlePrepareStripePaymentIntent(dependencies, {
      ...request(order),
      merchantId: asMerchantId('mrc_someone_else'),
    });

    expect(malformed).toMatchObject({ statusCode: 404, body: { code: 'ORDER_NOT_FOUND' } });
    expect(hidden.body).toEqual(malformed.body);
    expect(stripeClient.createCalls).toHaveLength(0);
  });

  it('returns 409 when the order cannot prepare a payment', async () => {
    const order = createOrderFixture();
    await storeOrder(repository, order);

    const response = await handlePrepareStripePaymentIntent(
      { repository, stripeClient },
      request(order),
    );

    expect(response).toMatchObject({
      statusCode: 409,
      body: { code: 'PAYMENT_PREPARATION_NOT_ALLOWED' },
    });
  });

  it('returns 503 with bounded retry guidance for a retryable Stripe failure', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    stripeClient.createPaymentIntent = () =>
      Promise.reject(
        new StripeClientError({
          code: 'RATE_LIMITED',
          retryable: true,
          message: 'Synthetic Stripe rate limit.',
          retryAfterMs: 1_500,
        }),
      );

    const response = await handlePrepareStripePaymentIntent(
      { repository, stripeClient },
      request(order),
    );

    expect(response).toMatchObject({
      statusCode: 503,
      headers: { 'Retry-After': '2' },
      body: {
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        detail: 'Payment preparation can be retried safely.',
      },
    });
  });

  it('does not expose permanent Stripe failure details', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const stripeError = new StripeClientError({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      message: 'Synthetic sensitive Stripe adapter detail.',
      stripeRequestId: 'req_sensitive_upstream_identifier',
    });
    stripeClient.createPaymentIntent = () => Promise.reject(stripeError);

    const response = await handlePrepareStripePaymentIntent(
      { repository, stripeClient },
      request(order),
    );

    expect(response).toMatchObject({
      statusCode: 502,
      body: { code: 'PAYMENT_PROVIDER_ERROR' },
    });
    expect(JSON.stringify(response)).not.toContain(stripeError.message);
    expect(JSON.stringify(response)).not.toContain(stripeError.stripeRequestId);
  });

  it('maps inconsistent Stripe responses and payment bindings to safe gateway errors', async () => {
    const contractOrder = awaitingPaymentOrder();
    await storeOrder(repository, contractOrder);
    const conflictingStripe = new FakeStripePaymentClient({ scenarios: ['conflicting-data'] });

    const contractResponse = await handlePrepareStripePaymentIntent(
      { repository, stripeClient: conflictingStripe },
      request(contractOrder),
    );

    const conflictOrder = awaitingPaymentOrder({
      orderId: asOrderId('ord_conflict12345678'),
      merchantOrderId: 'merchant-payment-conflict',
    });
    await storeOrder(repository, conflictOrder);
    repository.bindStripePaymentIntent = () =>
      Promise.reject(new StripePaymentIntentBindingConflictError());
    const bindingResponse = await handlePrepareStripePaymentIntent(
      { repository, stripeClient },
      request(conflictOrder),
    );

    expect(contractResponse).toMatchObject({
      statusCode: 502,
      body: { code: 'PAYMENT_PROVIDER_ERROR' },
    });
    expect(bindingResponse).toMatchObject({
      statusCode: 409,
      body: { code: 'PAYMENT_INTENT_CONFLICT' },
    });
  });
});
