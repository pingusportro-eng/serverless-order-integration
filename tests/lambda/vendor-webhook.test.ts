import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import { applyOrderStatusChange } from '../../src/domain/order-status-transition.js';
import type { Order } from '../../src/domain/order.js';
import { signWebhook } from '../../src/http/webhook-signature.js';
import type { ProviderWebhookRepository } from '../../src/application/provider-webhook-repository.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createVendorWebhookLambdaHandler } from '../../src/lambda/vendor-webhook.js';
import { createOrderFixture } from '../fixtures/order.js';

const SECRET = 'webhook-test-signing-secret-0123456789';
const NOW = new Date('2026-07-21T12:35:00.000Z');
const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));

function eventFixture(rawBody: string, timestamp = NOW_SECONDS): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /webhooks/vendor',
    rawPath: '/webhooks/vendor',
    rawQueryString: '',
    headers: {
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signWebhook(SECRET, timestamp, rawBody),
      'x-correlation-id': 'corr_provider_webhook_123',
    },
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: 'POST',
        path: '/webhooks/vendor',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'webhook-request-123',
      routeKey: 'POST /webhooks/vendor',
      stage: '$default',
      time: '21/Jul/2026:12:35:00 +0000',
      timeEpoch: NOW.getTime(),
    },
    isBase64Encoded: false,
    body: rawBody,
  };
}

function problemBody(response: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  if (typeof response.body !== 'string') {
    throw new Error('Expected a problem response body.');
  }
  return JSON.parse(response.body) as Record<string, unknown>;
}

function submittedOrder(order: Order): Order {
  return applyOrderStatusChange(
    order,
    {
      targetStatus: 'SUBMITTED',
      providerOrderId: 'delivery-789',
      acceptedAt: '2026-07-21T12:31:00.000Z',
    },
    '2026-07-21T12:31:00.000Z',
  );
}

describe('vendor webhook Lambda adapter', () => {
  let repository: InMemoryOrderRepository;
  let order: Order;

  beforeEach(async () => {
    repository = new InMemoryOrderRepository();
    const pendingOrder = createOrderFixture();
    order = submittedOrder(pendingOrder);
    await repository.create({
      order: pendingOrder,
      idempotencyKey: `create-${pendingOrder.orderId}`,
      requestFingerprint: `fingerprint-${pendingOrder.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_create_123',
        causationId: 'request_create_123',
      },
    });
    await repository.saveStatusChange(order, pendingOrder.version, {
      kind: 'ORDER_STATUS_CHANGED',
      previousStatus: pendingOrder.status,
      correlationId: 'corr_submit_123',
      causationId: 'event_submit_123',
    });
  });

  function handler() {
    return createVendorWebhookLambdaHandler({
      repository,
      signingSecret: SECRET,
      signatureToleranceSeconds: 300,
      now: () => NOW,
      logSink: () => undefined,
    });
  }

  it('authenticates and applies a valid webhook exactly once', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1001',
      eventType: 'DELIVERY_PICKED_UP',
      occurredAt: '2026-07-21T12:32:00.000Z',
      providerOrderId: 'delivery-789',
    });

    const first = await handler()(eventFixture(rawBody));
    const duplicate = await handler()(eventFixture(rawBody));
    const storedOrder = await repository.get(order.merchantId, order.orderId);

    expect(first).toEqual({
      statusCode: 204,
      headers: { 'X-Request-Id': 'webhook-request-123' },
    });
    expect(duplicate.statusCode).toBe(204);
    expect(storedOrder).toMatchObject({ status: 'PICKED_UP', version: 3 });
  });

  it('rejects an invalid signature without changing the order', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1002',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });
    const event = eventFixture(rawBody);
    event.headers['x-webhook-signature'] = `sha256=${'0'.repeat(64)}`;

    const response = await handler()(event);

    expect(response.statusCode).toBe(401);
    expect(problemBody(response)).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'SUBMITTED',
      version: 2,
    });
  });

  it('rejects an otherwise valid signature outside the replay window', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1003',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });
    const expiredTimestamp = String(Number(NOW_SECONDS) - 301);

    const response = await handler()(eventFixture(rawBody, expiredTimestamp));

    expect(response.statusCode).toBe(401);
    expect(problemBody(response)).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });

  it('records a stale webhook without changing a terminal order', async () => {
    const deliveredBody = JSON.stringify({
      eventId: 'provider-event-1004',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });
    const stalePickupBody = JSON.stringify({
      eventId: 'provider-event-1005',
      eventType: 'DELIVERY_PICKED_UP',
      occurredAt: '2026-07-21T12:33:00.000Z',
      providerOrderId: 'delivery-789',
    });

    expect((await handler()(eventFixture(deliveredBody))).statusCode).toBe(204);
    expect((await handler()(eventFixture(stalePickupBody))).statusCode).toBe(204);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'DELIVERED',
      version: 3,
    });
  });

  it('rejects reuse of an event ID with different values', async () => {
    const firstBody = JSON.stringify({
      eventId: 'provider-event-1006',
      eventType: 'DELIVERY_PICKED_UP',
      occurredAt: '2026-07-21T12:32:00.000Z',
      providerOrderId: 'delivery-789',
    });
    const conflictingBody = JSON.stringify({
      eventId: 'provider-event-1006',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });

    expect((await handler()(eventFixture(firstBody))).statusCode).toBe(204);
    const response = await handler()(eventFixture(conflictingBody));

    expect(response.statusCode).toBe(409);
    expect(problemBody(response)).toMatchObject({ code: 'EVENT_ID_CONFLICT' });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'PICKED_UP',
      version: 3,
    });
  });

  it('validates the authenticated body before resolving an order', async () => {
    const rawBody = JSON.stringify({
      eventId: 'short',
      eventType: 'UNKNOWN',
      occurredAt: 'invalid',
      providerOrderId: '',
    });

    const response = await handler()(eventFixture(rawBody));

    expect(response.statusCode).toBe(422);
    expect(problemBody(response)).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('verifies the decoded raw body when API Gateway uses base64', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1007',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });
    const event = eventFixture(rawBody);
    event.body = Buffer.from(rawBody, 'utf8').toString('base64');
    event.isBase64Encoded = true;

    const response = await handler()(event);

    expect(response.statusCode).toBe(204);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'DELIVERED',
      version: 3,
    });
  });

  it('returns a bad request for authenticated malformed JSON', async () => {
    const response = await handler()(eventFixture('{malformed'));

    expect(response.statusCode).toBe(400);
    expect(problemBody(response)).toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('returns not found for an unknown provider reference', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1008',
      eventType: 'DELIVERY_DELIVERED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'unknown-delivery',
    });

    const response = await handler()(eventFixture(rawBody));

    expect(response.statusCode).toBe(404);
    expect(problemBody(response)).toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('logs the safe exception class for an unexpected repository failure', async () => {
    const failure = new Error('This internal detail must not be logged.');
    failure.name = 'AccessDeniedException';
    const failingRepository: ProviderWebhookRepository = {
      getByProviderOrderId: () => Promise.reject(failure),
      recordProviderWebhook: () => Promise.reject(failure),
    };
    const logLines: string[] = [];
    const failingHandler = createVendorWebhookLambdaHandler({
      repository: failingRepository,
      signingSecret: SECRET,
      signatureToleranceSeconds: 300,
      now: () => NOW,
      logSink: (line) => {
        logLines.push(line);
      },
    });
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1010',
      eventType: 'DELIVERY_PICKED_UP',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
    });

    const response = await failingHandler(eventFixture(rawBody));
    const failedLog = logLines
      .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'webhook.request.failed');

    expect(response.statusCode).toBe(500);
    expect(failedLog).toMatchObject({
      errorCode: 'INTERNAL_ERROR',
      exceptionName: 'AccessDeniedException',
    });
    expect(logLines.join('')).not.toContain('This internal detail');
  });

  it('records validated delivery failure details', async () => {
    const rawBody = JSON.stringify({
      eventId: 'provider-event-1009',
      eventType: 'DELIVERY_FAILED',
      occurredAt: '2026-07-21T12:34:00.000Z',
      providerOrderId: 'delivery-789',
      failure: {
        stage: 'DELIVERY',
        reasonCode: 'CUSTOMER_UNAVAILABLE',
        summary: 'The customer could not receive the order.',
        occurredAt: '2026-07-21T12:33:59.000Z',
      },
    });

    const response = await handler()(eventFixture(rawBody));

    expect(response.statusCode).toBe(204);
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'DELIVERY_FAILED',
      version: 3,
      failure: {
        stage: 'DELIVERY',
        reasonCode: 'CUSTOMER_UNAVAILABLE',
      },
    });
  });
});
