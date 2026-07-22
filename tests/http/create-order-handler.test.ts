import { describe, expect, it, vi } from 'vitest';

import {
  OrderAlreadyExistsError,
  type OrderRepository,
} from '../../src/application/order-repository.js';
import { asMerchantId } from '../../src/domain/order.js';
import { handleCreateOrder } from '../../src/http/create-order-handler.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';

const merchantId = asMerchantId('mrc_demo');
const fixedDate = new Date('2026-07-22T08:00:00.000Z');

function request(
  body: unknown = createOrderRequestFixture(),
  headers: Readonly<Record<string, string | undefined>> = {
    'Idempotency-Key': 'order-create-10042',
  },
) {
  return {
    merchantId,
    requestId: 'request-123',
    headers,
    body,
  };
}

function deterministicDependencies(repository: OrderRepository) {
  const generated = ['orderidentifier0001', 'submissionidentifier0001'];
  return {
    repository,
    now: () => fixedDate,
    generateId: () => generated.shift() ?? 'unusedidentifier',
  };
}

describe('POST /orders handler', () => {
  it('creates an order, calculates its total, and hides the submission key', async () => {
    const repository = new InMemoryOrderRepository();

    const response = await handleCreateOrder(deterministicDependencies(repository), request());

    expect(response.statusCode).toBe(201);
    expect(response.headers).toMatchObject({
      Location: '/orders/ord_orderidentifier0001',
      ETag: '"1"',
      'Idempotency-Replayed': 'false',
      'X-Request-Id': 'request-123',
    });
    expect(response.body).toMatchObject({
      orderId: 'ord_orderidentifier0001',
      merchantId: 'mrc_demo',
      status: 'PENDING_SUBMISSION',
      total: { amountMinor: 2598, currency: 'RON' },
      createdAt: '2026-07-22T08:00:00.000Z',
      version: 1,
      provider: { providerCode: 'mock-delivery' },
    });
    expect(response.body).not.toHaveProperty('provider.submissionKey');
  });

  it('returns the original order for a case-insensitive idempotent replay', async () => {
    const repository = new InMemoryOrderRepository();
    const dependencies = deterministicDependencies(repository);
    const first = await handleCreateOrder(dependencies, request());

    const replay = await handleCreateOrder(
      dependencies,
      request(createOrderRequestFixture(), { 'idempotency-key': 'order-create-10042' }),
    );

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers).toMatchObject({ ETag: '"1"', 'Idempotency-Replayed': 'true' });
    expect(replay.headers).not.toHaveProperty('Location');
    expect(replay.body).toEqual(first.body);
  });

  it.each([
    ['missing', {}],
    ['malformed', { 'Idempotency-Key': 'bad key' }],
  ] as const)('rejects a %s idempotency key', async (_description, headers) => {
    const response = await handleCreateOrder(
      deterministicDependencies(new InMemoryOrderRepository()),
      request(createOrderRequestFixture(), headers),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('returns validation issues without calling the repository', async () => {
    const create = vi.fn<OrderRepository['create']>();
    const repository: OrderRepository = {
      create,
      get: vi.fn<OrderRepository['get']>(),
      list: vi.fn<OrderRepository['list']>(),
      saveStatusChange: vi.fn<OrderRepository['saveStatusChange']>(),
    };

    const response = await handleCreateOrder(
      deterministicDependencies(repository),
      request({ items: [] }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(create).not.toHaveBeenCalled();
  });

  it('maps idempotency and merchant-reference conflicts', async () => {
    const repository = new InMemoryOrderRepository();
    const dependencies = deterministicDependencies(repository);
    const body = createOrderRequestFixture();
    await handleCreateOrder(dependencies, request(body));

    const idempotencyConflict = await handleCreateOrder(
      dependencies,
      request({ ...body, merchantOrderReference: 'different-reference' }),
    );
    const referenceConflict = await handleCreateOrder(
      dependencies,
      request(body, { 'Idempotency-Key': 'different-key-10042' }),
    );

    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(referenceConflict.statusCode).toBe(409);
    expect(referenceConflict.body).toMatchObject({ code: 'MERCHANT_REFERENCE_CONFLICT' });
  });

  it('does not expose a generated ID collision', async () => {
    const repository: OrderRepository = {
      create: vi.fn<OrderRepository['create']>().mockRejectedValue(new OrderAlreadyExistsError()),
      get: vi.fn<OrderRepository['get']>(),
      list: vi.fn<OrderRepository['list']>(),
      saveStatusChange: vi.fn<OrderRepository['saveStatusChange']>(),
    };

    const response = await handleCreateOrder(deterministicDependencies(repository), request());

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The order could not be created safely.',
    });
    expect(JSON.stringify(response.body)).not.toContain('generated order ID');
  });
});
