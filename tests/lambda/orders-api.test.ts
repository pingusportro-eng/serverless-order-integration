import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import { asMerchantId } from '../../src/domain/order.js';
import { createOrderCursorCodec } from '../../src/http/order-cursor.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrdersApiHandler } from '../../src/lambda/orders-api.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';

interface EventOptions {
  readonly routeKey: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly pathParameters?: Record<string, string>;
  readonly queryStringParameters?: Record<string, string>;
}

function eventFixture(options: EventOptions): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: options.routeKey,
    rawPath: options.path,
    rawQueryString: '',
    headers: options.headers ?? {},
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: options.method,
        path: options.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'lambda-request-123',
      routeKey: options.routeKey,
      stage: '$default',
      time: '22/Jul/2026:12:00:00 +0000',
      timeEpoch: 1_774_184_400_000,
    },
    isBase64Encoded: false,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.pathParameters === undefined ? {} : { pathParameters: options.pathParameters }),
    ...(options.queryStringParameters === undefined
      ? {}
      : { queryStringParameters: options.queryStringParameters }),
  };
}

function responseBody(response: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  if (typeof response.body !== 'string') {
    throw new Error('Expected a JSON response body.');
  }
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('orders API Lambda adapter', () => {
  let repository: InMemoryOrderRepository;
  const merchantId = asMerchantId('mrc_demo');

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
  });

  function handler() {
    return createOrdersApiHandler({
      repository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      logSink: () => undefined,
    });
  }

  it('parses an API Gateway event and serializes the application response', async () => {
    const createResponse = await handler()(
      eventFixture({
        routeKey: 'POST /orders',
        method: 'POST',
        path: '/orders',
        headers: { 'idempotency-key': 'lambda-key-123' },
        body: JSON.stringify(createOrderRequestFixture()),
      }),
    );
    const createdOrder = responseBody(createResponse);

    expect(createResponse).toMatchObject({
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'lambda-request-123' },
    });
    expect(createdOrder).toMatchObject({ merchantId, status: 'PENDING_SUBMISSION', version: 1 });

    const orderId = createdOrder['orderId'];
    if (typeof orderId !== 'string') {
      throw new Error('Expected a created order ID.');
    }
    const getResponse = await handler()(
      eventFixture({
        routeKey: 'GET /orders/{orderId}',
        method: 'GET',
        path: `/orders/${orderId}`,
        pathParameters: { orderId },
      }),
    );

    expect(getResponse.statusCode).toBe(200);
    expect(responseBody(getResponse)).toMatchObject({ orderId, merchantId });
  });

  it('maps query string parameters into a paginated list request', async () => {
    const event = eventFixture({
      routeKey: 'GET /orders',
      method: 'GET',
      path: '/orders',
      queryStringParameters: { limit: '1', status: 'PENDING_SUBMISSION' },
    });
    Object.assign(event, { body: null });

    const response = await handler()(event);

    expect(response.statusCode).toBe(200);
    expect(responseBody(response)).toEqual({ items: [] });
  });

  it('returns a safe error for malformed JSON', async () => {
    const response = await handler()(
      eventFixture({
        routeKey: 'POST /orders',
        method: 'POST',
        path: '/orders',
        headers: { 'idempotency-key': 'lambda-key-456' },
        body: '{invalid',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(responseBody(response)).toMatchObject({
      code: 'MALFORMED_REQUEST',
      requestId: 'lambda-request-123',
    });
  });
});
