import { describe, expect, it, vi } from 'vitest';

import { PREPARED_PAYMENT_STATUSES, type CreateOrderRequest } from '../src/api/contracts.js';
import {
  createOrdersApiClient,
  OrdersApiOutcomeUnknownError,
  PaymentPreparationOutcomeUnknownError,
} from '../src/api/orders-api-client.js';

const REQUEST: CreateOrderRequest = {
  merchantOrderId: 'pos-order-10042',
  items: [
    {
      itemReference: 'pizza-margherita',
      description: 'Synthetic margherita pizza',
      quantity: 1,
      unitPrice: { amountMinor: 1299, currency: 'RON' },
    },
  ],
  pickup: {
    addressLine: '10 Example Street',
    city: 'Bucharest',
    postalCode: '010101',
    countryCode: 'RO',
  },
  dropoff: {
    addressLine: '20 Example Avenue',
    city: 'Bucharest',
    postalCode: '020202',
    countryCode: 'RO',
  },
};

const CREATED_ORDER = {
  orderId: 'ord_12345678',
  merchantOrderId: 'pos-order-10042',
  status: 'AWAITING_PAYMENT',
  version: 1,
  total: { amountMinor: 1299, currency: 'RON' },
  payment: {
    status: 'NOT_STARTED',
    amount: { amountMinor: 1299, currency: 'RON' },
  },
};

const COMMAND = {
  request: REQUEST,
  idempotencyKey: 'create-order:operation-123',
  correlationId: 'ui-create-order:operation-123',
};

const PREPARED_PAYMENT = {
  orderId: 'ord_12345678',
  orderVersion: 2,
  stripePaymentIntentId: 'pi_12345678',
  status: 'REQUIRES_PAYMENT_METHOD',
  amount: { amountMinor: 1299, currency: 'RON' },
  clientSecret: 'pi_12345678_secret_example',
};

describe('orders API browser client', () => {
  it('sends the exact idempotency and tracing headers in local mode', async () => {
    const browserFetch = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(JSON.stringify(CREATED_ORDER), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000/',
      authorization: { mode: 'local-bypass' },
      fetch: browserFetch,
    });

    await expect(client.createOrder(COMMAND)).resolves.toEqual(CREATED_ORDER);

    expect(browserFetch).toHaveBeenCalledTimes(1);
    const call = browserFetch.mock.calls[0];
    if (call === undefined) {
      throw new Error('The orders API request is missing.');
    }
    const [url, init] = call;
    expect(url).toBe('http://127.0.0.1:3000/orders');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': COMMAND.idempotencyKey,
        'X-Correlation-Id': COMMAND.correlationId,
      },
      body: JSON.stringify(REQUEST),
    });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('adds a bearer token in authenticated mode', async () => {
    const browserFetch = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify(CREATED_ORDER), { status: 200 }));
    const client = createOrdersApiClient({
      baseUrl: 'https://api.example.test',
      authorization: { mode: 'bearer', accessToken: () => 'access-token-123' },
      fetch: browserFetch,
    });

    await client.createOrder(COMMAND);

    const call = browserFetch.mock.calls[0];
    if (call === undefined) {
      throw new Error('The orders API request is missing.');
    }
    expect(call[1].headers).toMatchObject({
      Authorization: 'Bearer access-token-123',
    });
  });

  it('classifies a validation response as a known rejection', async () => {
    const browserFetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 422,
            code: 'VALIDATION_ERROR',
            title: 'Request validation failed',
            detail: 'One or more request values are invalid.',
          }),
          { status: 422 },
        ),
      ),
    );
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: browserFetch,
    });

    await expect(client.createOrder(COMMAND)).rejects.toMatchObject({
      name: 'OrdersApiRejectedError',
      status: 422,
      problem: { code: 'VALIDATION_ERROR' },
    });
  });

  it.each([
    ['network failure', () => Promise.reject(new TypeError('network unavailable'))],
    ['server failure', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['invalid success body', () => Promise.resolve(new Response('{}', { status: 201 }))],
  ])('classifies %s as an ambiguous outcome', async (_label, response) => {
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: vi.fn(response),
    });

    await expect(client.createOrder(COMMAND)).rejects.toBeInstanceOf(OrdersApiOutcomeUnknownError);
  });

  it('prepares a PaymentIntent without sending a browser idempotency key', async () => {
    const browserFetch = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify(PREPARED_PAYMENT), { status: 201 }));
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: browserFetch,
    });

    await expect(
      client.preparePaymentIntent({
        orderId: 'ord_12345678',
        correlationId: 'ui-prepare-payment:ord_12345678:operation-123',
      }),
    ).resolves.toEqual(PREPARED_PAYMENT);

    const call = browserFetch.mock.calls[0];
    if (call === undefined) {
      throw new Error('The payment-preparation request is missing.');
    }
    expect(call).toEqual([
      'http://127.0.0.1:3000/orders/ord_12345678/payment-intents',
      {
        method: 'POST',
        headers: {
          'X-Correlation-Id': 'ui-prepare-payment:ord_12345678:operation-123',
        },
      },
    ]);
    expect(call[1].headers).not.toHaveProperty('Idempotency-Key');
  });

  it.each(PREPARED_PAYMENT_STATUSES)(
    'accepts the application payment status %s',
    async (status) => {
      const client = createOrdersApiClient({
        baseUrl: 'http://127.0.0.1:3000',
        authorization: { mode: 'local-bypass' },
        fetch: vi.fn(async () =>
          Promise.resolve(
            new Response(JSON.stringify({ ...PREPARED_PAYMENT, status }), { status: 200 }),
          ),
        ),
      });

      await expect(
        client.preparePaymentIntent({ orderId: 'ord_12345678', correlationId: 'corr-payment-123' }),
      ).resolves.toMatchObject({ status });
    },
  );

  it.each([
    [409, 'PAYMENT_PREPARATION_NOT_ALLOWED'],
    [502, 'PAYMENT_PROVIDER_ERROR'],
  ])('classifies HTTP %i %s as a definite payment rejection', async (status, code) => {
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status,
              code,
              title: 'Payment preparation not allowed',
              detail: 'The order cannot prepare a payment.',
            }),
            { status },
          ),
        ),
      ),
    });

    await expect(
      client.preparePaymentIntent({ orderId: 'ord_12345678', correlationId: 'corr-payment-123' }),
    ).rejects.toMatchObject({
      name: 'PaymentPreparationRejectedError',
      status,
      problem: { code },
    });
  });

  it.each([
    ['network failure', () => Promise.reject(new TypeError('network unavailable'))],
    ['server failure', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['invalid success body', () => Promise.resolve(new Response('{}', { status: 200 }))],
    [
      'wrong order response',
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ ...PREPARED_PAYMENT, orderId: 'ord_different1' }), {
            status: 200,
          }),
        ),
    ],
  ])('classifies payment preparation %s as an ambiguous outcome', async (_label, response) => {
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: vi.fn(response),
    });

    await expect(
      client.preparePaymentIntent({ orderId: 'ord_12345678', correlationId: 'corr-payment-123' }),
    ).rejects.toBeInstanceOf(PaymentPreparationOutcomeUnknownError);
  });

  it('reads and projects the authoritative stored order for journey tracking', async () => {
    const storedOrder = {
      ...CREATED_ORDER,
      status: 'PICKED_UP',
      version: 5,
      payment: {
        status: 'SUCCEEDED',
        amount: { amountMinor: 1299, currency: 'RON' },
        stripePaymentIntentId: 'pi_12345678',
      },
    };
    const browserFetch = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(JSON.stringify(storedOrder), { status: 200 }));
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: browserFetch,
    });
    const signal = new AbortController().signal;

    await expect(
      client.getOrder({
        orderId: 'ord_12345678',
        correlationId: 'ui-track-order:ord_12345678:tracking-123',
        signal,
      }),
    ).resolves.toEqual({
      orderId: 'ord_12345678',
      status: 'PICKED_UP',
      version: 5,
      payment: { status: 'SUCCEEDED' },
    });
    expect(browserFetch).toHaveBeenCalledWith('http://127.0.0.1:3000/orders/ord_12345678', {
      method: 'GET',
      headers: { 'X-Correlation-Id': 'ui-track-order:ord_12345678:tracking-123' },
      signal,
    });
  });

  it('classifies a missing tracked order as a definite rejection', async () => {
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: 404,
              code: 'ORDER_NOT_FOUND',
              title: 'Order not found',
              detail: 'The requested order does not exist.',
            }),
            { status: 404 },
          ),
        ),
      ),
    });

    await expect(
      client.getOrder({ orderId: 'ord_12345678', correlationId: 'corr-track-123' }),
    ).rejects.toMatchObject({
      name: 'OrderTrackingRejectedError',
      status: 404,
      problem: { code: 'ORDER_NOT_FOUND' },
    });
  });

  it.each([
    ['network failure', () => Promise.reject(new TypeError('network unavailable'))],
    ['server failure', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['invalid success body', () => Promise.resolve(new Response('{}', { status: 200 }))],
  ])('keeps tracking %s retryable', async (_label, response) => {
    const client = createOrdersApiClient({
      baseUrl: 'http://127.0.0.1:3000',
      authorization: { mode: 'local-bypass' },
      fetch: vi.fn(response),
    });

    await expect(
      client.getOrder({ orderId: 'ord_12345678', correlationId: 'corr-track-123' }),
    ).rejects.toMatchObject({ name: 'OrderTrackingUnavailableError' });
  });
});
