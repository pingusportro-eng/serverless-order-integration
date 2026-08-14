import { describe, expect, it, vi } from 'vitest';

import type { CreateOrderRequest } from '../src/api/contracts.js';
import {
  createOrdersApiClient,
  OrdersApiOutcomeUnknownError,
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
});
