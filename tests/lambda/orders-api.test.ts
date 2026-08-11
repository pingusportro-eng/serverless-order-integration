import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

import type { OrderRepository } from '../../src/application/order-repository.js';
import { asMerchantId, type Order } from '../../src/domain/order.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { createOrderCursorCodec } from '../../src/http/order-cursor.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { FakeStripePaymentClient } from '../../src/integrations/fake-stripe-payment-client.js';
import { createOrdersApiHandler } from '../../src/lambda/orders-api.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';
import { createOrderFixture } from '../fixtures/order.js';

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

function awaitingPaymentOrder(): Order {
  const order = createOrderFixture({
    merchantId: asMerchantId('mrc_demo'),
    status: 'AWAITING_PAYMENT',
  });
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
      correlationId: 'corr_lambda_payment_fixture',
      causationId: 'request_lambda_payment_fixture',
    },
  });
}

describe('orders API Lambda adapter', () => {
  let repository: InMemoryOrderRepository;
  let stripeClient: FakeStripePaymentClient;
  const merchantId = asMerchantId('mrc_demo');

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    stripeClient = new FakeStripePaymentClient();
  });

  function handler(requireAccessToken = false, requireOperatorGroup = false) {
    return createOrdersApiHandler({
      repository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      requireAccessToken,
      requireOperatorGroup,
      paymentPreparation: {
        repository,
        stripeClient,
        now: () => new Date('2026-08-11T10:00:00.000Z'),
      },
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

  it('routes PaymentIntent creation and its natural replay', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const event = eventFixture({
      routeKey: 'POST /orders/{orderId}/payment-intents',
      method: 'POST',
      path: `/orders/${order.orderId}/payment-intents`,
      pathParameters: { orderId: order.orderId },
      headers: { 'x-correlation-id': 'corr_lambda_payment_route' },
    });

    const first = await handler()(event);
    const replay = await handler()(event);
    const firstBody = responseBody(first);
    const replayBody = responseBody(replay);

    expect(first).toMatchObject({
      statusCode: 201,
      headers: { 'Cache-Control': 'no-store', ETag: '"2"' },
    });
    expect(replay).toMatchObject({
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store', ETag: '"2"' },
    });
    expect(replayBody).toMatchObject({
      orderId: order.orderId,
      orderVersion: 2,
      stripePaymentIntentId: firstBody['stripePaymentIntentId'],
      clientSecret: firstBody['clientSecret'],
    });
    expect(stripeClient.createCalls).toHaveLength(1);
  });

  it('requires a verified access token before reaching the PaymentIntent route', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const event = eventFixture({
      routeKey: 'POST /orders/{orderId}/payment-intents',
      method: 'POST',
      path: `/orders/${order.orderId}/payment-intents`,
      pathParameters: { orderId: order.orderId },
    });

    const unauthorized = await handler(true)(event);
    expect(unauthorized.statusCode).toBe(401);
    expect(stripeClient.createCalls).toHaveLength(0);

    Object.assign(event.requestContext, {
      authorizer: {
        principalId: 'synthetic-user',
        integrationLatency: 1,
        jwt: {
          claims: { token_use: 'access' },
          scopes: [],
        },
      },
    });
    const authorized = await handler(true)(event);

    expect(authorized.statusCode).toBe(201);
    expect(stripeClient.createCalls).toHaveLength(1);
  });

  it('never writes the PaymentIntent client secret to request logs', async () => {
    const order = awaitingPaymentOrder();
    await storeOrder(repository, order);
    const logLines: string[] = [];
    const observableHandler = createOrdersApiHandler({
      repository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      requireAccessToken: false,
      requireOperatorGroup: false,
      paymentPreparation: { repository, stripeClient },
      logSink: (line) => {
        logLines.push(line);
      },
    });

    const response = await observableHandler(
      eventFixture({
        routeKey: 'POST /orders/{orderId}/payment-intents',
        method: 'POST',
        path: `/orders/${order.orderId}/payment-intents`,
        pathParameters: { orderId: order.orderId },
      }),
    );
    const body = responseBody(response);
    const clientSecret = body['clientSecret'];

    expect(response.statusCode).toBe(201);
    expect(typeof clientSecret).toBe('string');
    expect(logLines.join('\n')).not.toContain(clientSecret);
  });

  it('keeps the payment route unavailable until its runtime capability is installed', async () => {
    const routeWithoutPayment = createOrdersApiHandler({
      repository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      requireAccessToken: false,
      requireOperatorGroup: false,
    });

    const response = await routeWithoutPayment(
      eventFixture({
        routeKey: 'POST /orders/{orderId}/payment-intents',
        method: 'POST',
        path: '/orders/ord_12345678/payment-intents',
        pathParameters: { orderId: 'ord_12345678' },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(responseBody(response)).toMatchObject({ code: 'MALFORMED_REQUEST' });
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

  it.each([
    {
      name: 'create malformed JSON',
      event: {
        routeKey: 'POST /orders',
        method: 'POST',
        path: '/orders',
        headers: { 'idempotency-key': 'lambda-matrix-key-1' },
        body: '{invalid',
      },
      statusCode: 400,
      code: 'MALFORMED_REQUEST',
    },
    {
      name: 'status malformed JSON',
      event: {
        routeKey: 'PATCH /orders/{orderId}/status',
        method: 'PATCH',
        path: '/orders/ord_12345678/status',
        pathParameters: { orderId: 'ord_12345678' },
        headers: { 'if-match': '"1"' },
        body: '{invalid',
      },
      statusCode: 400,
      code: 'MALFORMED_REQUEST',
    },
    {
      name: 'status malformed If-Match',
      event: {
        routeKey: 'PATCH /orders/{orderId}/status',
        method: 'PATCH',
        path: '/orders/ord_12345678/status',
        pathParameters: { orderId: 'ord_12345678' },
        headers: { 'if-match': '1' },
        body: JSON.stringify({
          targetStatus: 'CANCELLED',
          reason: 'Route matrix cancellation.',
        }),
      },
      statusCode: 400,
      code: 'MALFORMED_REQUEST',
    },
    {
      name: 'unknown route',
      event: {
        routeKey: '$default',
        method: 'GET',
        path: '/unknown',
      },
      statusCode: 404,
      code: 'MALFORMED_REQUEST',
    },
    {
      name: 'create validation',
      event: {
        routeKey: 'POST /orders',
        method: 'POST',
        path: '/orders',
        headers: { 'idempotency-key': 'lambda-matrix-key-2' },
        body: JSON.stringify({}),
      },
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    },
    {
      name: 'list validation',
      event: {
        routeKey: 'GET /orders',
        method: 'GET',
        path: '/orders',
        queryStringParameters: { limit: '0' },
      },
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    },
    {
      name: 'status validation',
      event: {
        routeKey: 'PATCH /orders/{orderId}/status',
        method: 'PATCH',
        path: '/orders/ord_12345678/status',
        pathParameters: { orderId: 'ord_12345678' },
        headers: { 'if-match': '"1"' },
        body: JSON.stringify({ targetStatus: 'CANCELLED', reason: 'x' }),
      },
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    },
  ] satisfies readonly {
    name: string;
    event: EventOptions;
    statusCode: number;
    code: string;
  }[])('maps $name through the Lambda route boundary', async ({ event, statusCode, code }) => {
    const response = await handler()(eventFixture(event));

    expect(response.statusCode).toBe(statusCode);
    expect(responseBody(response)).toMatchObject({
      code,
      requestId: 'lambda-request-123',
    });
  });

  it('requires a verified operators group claim for the cloud operator route', async () => {
    const request = eventFixture({
      routeKey: 'PATCH /orders/{orderId}/status',
      method: 'PATCH',
      path: '/orders/ord_12345678/status',
      pathParameters: { orderId: 'ord_12345678' },
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({
        targetStatus: 'CANCELLED',
        reason: 'Synthetic operator cancellation.',
      }),
    });

    const response = await handler(false, true)(request);

    expect(response.statusCode).toBe(403);
    expect(responseBody(response)).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows the verified operators group claim to reach the operator route', async () => {
    const request = eventFixture({
      routeKey: 'PATCH /orders/{orderId}/status',
      method: 'PATCH',
      path: '/orders/ord_12345678/status',
      pathParameters: { orderId: 'ord_12345678' },
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({
        targetStatus: 'CANCELLED',
        reason: 'Synthetic operator cancellation.',
      }),
    });
    Object.assign(request.requestContext, {
      authorizer: {
        principalId: 'synthetic-operator',
        integrationLatency: 1,
        jwt: {
          claims: { 'cognito:groups': '[operators]' },
          scopes: [],
        },
      },
    });

    const response = await handler(false, true)(request);

    expect(response.statusCode).toBe(404);
    expect(responseBody(response)).toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('rejects an ID token when cloud routes require an access token', async () => {
    const request = eventFixture({
      routeKey: 'GET /orders',
      method: 'GET',
      path: '/orders',
    });
    Object.assign(request.requestContext, {
      authorizer: {
        principalId: 'synthetic-user',
        integrationLatency: 1,
        jwt: {
          claims: { token_use: 'id' },
          scopes: [],
        },
      },
    });

    const response = await handler(true)(request);

    expect(response.statusCode).toBe(401);
    expect(responseBody(response)).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a verified access token on a merchant route', async () => {
    const request = eventFixture({
      routeKey: 'GET /orders',
      method: 'GET',
      path: '/orders',
    });
    Object.assign(request.requestContext, {
      authorizer: {
        principalId: 'synthetic-user',
        integrationLatency: 1,
        jwt: {
          claims: { token_use: 'access' },
          scopes: [],
        },
      },
    });

    const response = await handler(true)(request);

    expect(response.statusCode).toBe(200);
  });

  it.each([
    {
      name: 'uses the platform request ID when the caller omits a correlation ID',
      headers: {},
      expectedCorrelationId: 'lambda-request-123',
    },
    {
      name: 'preserves a caller correlation ID',
      headers: { 'x-correlation-id': 'correlation-orders-api-123' },
      expectedCorrelationId: 'correlation-orders-api-123',
    },
  ])('$name in every request log', async ({ headers, expectedCorrelationId }) => {
    const logLines: string[] = [];
    const observableHandler = createOrdersApiHandler({
      repository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      requireAccessToken: false,
      requireOperatorGroup: false,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      logSink: (line) => {
        logLines.push(line);
      },
    });

    await observableHandler(
      eventFixture({
        routeKey: 'GET /orders',
        method: 'GET',
        path: '/orders',
        headers,
      }),
    );

    expect(
      logLines.map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>),
    ).toEqual([
      expect.objectContaining({
        event: 'http.request.started',
        requestId: 'lambda-request-123',
        correlationId: expectedCorrelationId,
      }),
      expect.objectContaining({
        event: 'http.request.completed',
        requestId: 'lambda-request-123',
        correlationId: expectedCorrelationId,
        statusCode: 200,
      }),
    ]);
  });

  it('returns a safe internal error and logs only the unexpected exception class', async () => {
    const failure = new Error('Repository connection details must stay private.');
    failure.name = 'ProvisionedThroughputExceededException';
    const failingRepository: OrderRepository = {
      create: () => Promise.reject(failure),
      get: () => Promise.reject(failure),
      list: () => Promise.reject(failure),
      saveStatusChange: () => Promise.reject(failure),
    };
    const logLines: string[] = [];
    const failingHandler = createOrdersApiHandler({
      repository: failingRepository,
      merchantId,
      cursorCodec: createOrderCursorCodec('lambda-test-cursor-signing-secret-0123456789'),
      requireAccessToken: false,
      requireOperatorGroup: false,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
      logSink: (line) => {
        logLines.push(line);
      },
    });

    const response = await failingHandler(
      eventFixture({
        routeKey: 'GET /orders',
        method: 'GET',
        path: '/orders',
      }),
    );
    const failedLog = logLines
      .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'http.request.failed');

    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(failedLog).toMatchObject({
      errorCode: 'INTERNAL_ERROR',
      exceptionName: 'ProvisionedThroughputExceededException',
    });
    expect(logLines.join('')).not.toContain('Repository connection details');
  });
});
