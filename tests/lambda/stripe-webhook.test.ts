import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { FakeStripePaymentClient } from '../../src/integrations/fake-stripe-payment-client.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import {
  createRotatingStripeWebhookLambdaHandler,
  createStripeWebhookLambdaHandler,
} from '../../src/lambda/stripe-webhook.js';
import { createOrderFixture } from '../fixtures/order.js';

const SIGNING_SECRET = 'whsec_stripe_test_signing_secret_123456789';
const NOW = new Date('2026-08-11T09:00:00.000Z');
const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

function stripeEvent(eventId: string, eventType: string, stripePaymentIntentId: string): string {
  return JSON.stringify({
    id: eventId,
    object: 'event',
    type: eventType,
    created: TIMESTAMP,
    livemode: false,
    data: { object: { id: stripePaymentIntentId, object: 'payment_intent' } },
  });
}

function apiEvent(rawBody: string, signature?: string): APIGatewayProxyEventV2 {
  const stripeSignature =
    signature ??
    Stripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: SIGNING_SECRET,
      timestamp: TIMESTAMP,
    });
  return {
    version: '2.0',
    routeKey: 'POST /webhooks/stripe',
    rawPath: '/webhooks/stripe',
    rawQueryString: '',
    headers: { 'stripe-signature': stripeSignature },
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: 'POST',
        path: '/webhooks/stripe',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'stripe-webhook-request-123',
      routeKey: 'POST /webhooks/stripe',
      stage: '$default',
      time: '11/Aug/2026:09:00:00 +0000',
      timeEpoch: NOW.getTime(),
    },
    isBase64Encoded: false,
    body: rawBody,
  };
}

function problemCode(
  response: Awaited<ReturnType<ReturnType<typeof createStripeWebhookLambdaHandler>>>,
) {
  return typeof response.body === 'string'
    ? (JSON.parse(response.body) as Record<string, unknown>)['code']
    : undefined;
}

describe('Stripe webhook Lambda adapter', () => {
  let repository: InMemoryOrderRepository;
  let stripeClient: FakeStripePaymentClient;
  let order: ReturnType<typeof createOrderFixture> & {
    payment: ReturnType<typeof createInitialOrderPayment>;
  };

  beforeEach(async () => {
    repository = new InMemoryOrderRepository();
    stripeClient = new FakeStripePaymentClient();
    const base = createOrderFixture({ status: 'AWAITING_PAYMENT' });
    order = {
      ...base,
      payment: createInitialOrderPayment(
        base.total,
        `stripe-payment-intent:${base.merchantId}:${base.orderId}`,
        base.createdAt,
      ),
    };
    await repository.create({
      order,
      idempotencyKey: `create-${order.orderId}`,
      requestFingerprint: `fingerprint-${order.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_create_stripe_webhook',
        causationId: 'request_create_stripe_webhook',
      },
    });
  });

  async function intent() {
    return stripeClient.createPaymentIntent({
      merchantId: order.merchantId,
      orderId: order.orderId,
      amount: order.total,
      stripeCreationKey: order.payment.stripeCreationKey,
    });
  }

  function handler(logSink: (line: string) => void = () => undefined) {
    return createStripeWebhookLambdaHandler({
      repository,
      stripeClient,
      signingSecret: SIGNING_SECRET,
      signatureToleranceSeconds: 300,
      now: () => NOW,
      logSink,
    });
  }

  it('verifies exact raw bytes and applies a supported event exactly once', async () => {
    const paymentIntent = await intent();
    const rawBody = stripeEvent(
      'evt_stripe_created_123',
      'payment_intent.created',
      paymentIntent.stripePaymentIntentId,
    );

    expect((await handler()(apiEvent(rawBody))).statusCode).toBe(204);
    expect((await handler()(apiEvent(rawBody))).statusCode).toBe(204);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'AWAITING_PAYMENT',
      version: 2,
      payment: {
        status: 'REQUIRES_PAYMENT_METHOD',
        stripePaymentIntentId: paymentIntent.stripePaymentIntentId,
      },
    });

    const changedAfterSigning = apiEvent(
      `${rawBody} `,
      apiEvent(rawBody).headers['stripe-signature'],
    );
    const rejected = await handler()(changedAfterSigning);
    expect(rejected.statusCode).toBe(400);
    expect(problemCode(rejected)).toBe('INVALID_STRIPE_WEBHOOK');
  });

  it('resolves the rotating signing secret for every warm invocation', async () => {
    const nextSecret = 'whsec_stripe_rotated_signing_secret_987654321';
    const resolveSigningSecret = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(SIGNING_SECRET)
      .mockResolvedValueOnce(nextSecret);
    const rotatingHandler = createRotatingStripeWebhookLambdaHandler({
      repository,
      stripeClient,
      resolveSigningSecret,
      signatureToleranceSeconds: 300,
      now: () => NOW,
    });
    const firstBody = stripeEvent('evt_before_rotation', 'charge.succeeded', 'pi_before_rotation');
    const secondBody = stripeEvent('evt_after_rotation', 'charge.succeeded', 'pi_after_rotation');
    const secondSignature = Stripe.webhooks.generateTestHeaderString({
      payload: secondBody,
      secret: nextSecret,
      timestamp: TIMESTAMP,
    });

    expect((await rotatingHandler(apiEvent(firstBody))).statusCode).toBe(204);
    expect((await rotatingHandler(apiEvent(secondBody, secondSignature))).statusCode).toBe(204);
    expect(resolveSigningSecret).toHaveBeenCalledTimes(2);
  });

  it('uses retrieved Stripe success as authority and releases the order for delivery', async () => {
    const paymentIntent = await intent();
    stripeClient.setPaymentIntentStatus(paymentIntent.stripePaymentIntentId, 'SUCCEEDED');
    const rawBody = stripeEvent(
      'evt_stripe_succeeded_123',
      'payment_intent.succeeded',
      paymentIntent.stripePaymentIntentId,
    );

    expect((await handler()(apiEvent(rawBody))).statusCode).toBe(204);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'PENDING_SUBMISSION',
      version: 2,
      payment: { status: 'SUCCEEDED' },
    });
  });

  it('ignores a valid unsupported event without retrieving a PaymentIntent', async () => {
    const rawBody = stripeEvent('evt_charge_123', 'charge.succeeded', 'pi_not_retrieved');

    expect((await handler()(apiEvent(rawBody))).statusCode).toBe(204);
    expect(stripeClient.retrieveCalls).toEqual([]);
  });

  it('returns 400 for an invalid signature and 500 for a transient processing failure', async () => {
    const invalid = await handler()(apiEvent('{}', 't=1,v1=invalid'));
    expect(invalid.statusCode).toBe(400);
    expect(problemCode(invalid)).toBe('INVALID_STRIPE_WEBHOOK');

    const rawBody = stripeEvent(
      'evt_stripe_missing_123',
      'payment_intent.processing',
      'pi_missing',
    );
    const unavailable = await handler()(apiEvent(rawBody));
    expect(unavailable.statusCode).toBe(500);
    expect(problemCode(unavailable)).toBe('INTERNAL_ERROR');
  });

  it('rejects an otherwise valid signature outside the replay tolerance', async () => {
    const rawBody = stripeEvent(
      'evt_stripe_expired_signature_123',
      'payment_intent.created',
      'pi_expired_signature_123',
    );
    const expiredSignature = Stripe.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: SIGNING_SECRET,
      timestamp: TIMESTAMP - 301,
    });

    const response = await handler()(apiEvent(rawBody, expiredSignature));

    expect(response.statusCode).toBe(400);
    expect(problemCode(response)).toBe('INVALID_STRIPE_WEBHOOK');
    expect(stripeClient.retrieveCalls).toEqual([]);
  });

  it('logs a newly durable reconciliation outcome as an error exactly once', async () => {
    const missingOrder = createOrderFixture({ status: 'AWAITING_PAYMENT' });
    const paymentIntent = await stripeClient.createPaymentIntent({
      merchantId: missingOrder.merchantId,
      orderId: missingOrder.orderId,
      amount: missingOrder.total,
      stripeCreationKey: `stripe-payment-intent:${missingOrder.merchantId}:${missingOrder.orderId}`,
    });
    const rawBody = stripeEvent(
      'evt_stripe_reconciliation_123',
      'payment_intent.created',
      paymentIntent.stripePaymentIntentId,
    );
    const logLines: string[] = [];
    const webhook = handler((line) => logLines.push(line));

    expect((await webhook(apiEvent(rawBody))).statusCode).toBe(204);
    expect((await webhook(apiEvent(rawBody))).statusCode).toBe(204);

    const entries = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      entries.filter((entry) => entry['event'] === 'stripe.webhook.reconciliation_required'),
    ).toEqual([
      expect.objectContaining({
        level: 'error',
        eventId: 'evt_stripe_reconciliation_123',
        stripePaymentIntentId: paymentIntent.stripePaymentIntentId,
        outcome: 'reconciliation_required',
        reasonCode: 'ORDER_NOT_FOUND',
      }),
    ]);
  });

  it('logs only safe identifiers and outcomes', async () => {
    const paymentIntent = await intent();
    const rawBody = stripeEvent(
      'evt_stripe_observable_123',
      'payment_intent.created',
      paymentIntent.stripePaymentIntentId,
    );
    const logLines: string[] = [];

    expect((await handler((line) => logLines.push(line))(apiEvent(rawBody))).statusCode).toBe(204);
    expect(logLines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        event: 'stripe.webhook.started',
        requestId: 'stripe-webhook-request-123',
      }),
      expect.objectContaining({
        event: 'stripe.webhook.completed',
        eventId: 'evt_stripe_observable_123',
        eventType: 'payment_intent.created',
        stripePaymentIntentId: paymentIntent.stripePaymentIntentId,
        orderId: order.orderId,
        orderVersion: 2,
        outcome: 'applied',
        statusCode: 204,
      }),
    ]);
    expect(logLines.join('')).not.toContain(SIGNING_SECRET);
    expect(logLines.join('')).not.toContain('_secret_');
  });
});
