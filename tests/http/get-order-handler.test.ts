import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrderRepository } from '../../src/application/order-repository.js';
import { asMerchantId } from '../../src/domain/order.js';
import { handleGetOrder } from '../../src/http/get-order-handler.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

describe('GET /orders/{orderId} handler', () => {
  let repository: InMemoryOrderRepository;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
  });

  it('returns the merchant order with its version ETag', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'get-order-key-1',
      requestFingerprint: 'get-order-fingerprint-1',
    });

    const response = await handleGetOrder(
      { repository },
      { merchantId: order.merchantId, requestId: 'request-123', orderId: order.orderId },
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ ETag: '"1"', 'X-Request-Id': 'request-123' });
    expect(response.body).toMatchObject({
      orderId: order.orderId,
      merchantId: order.merchantId,
      provider: { providerCode: 'mock-delivery' },
    });
    expect(response.body).not.toHaveProperty('provider.submissionKey');
  });

  it('returns the same safe 404 for unknown and other-merchant orders', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'get-order-key-2',
      requestFingerprint: 'get-order-fingerprint-2',
    });
    const requestId = 'request-456';

    const unknown = await handleGetOrder(
      { repository },
      {
        merchantId: order.merchantId,
        requestId,
        orderId: 'ord_00000000000000000000',
      },
    );
    const otherMerchant = await handleGetOrder(
      { repository },
      {
        merchantId: asMerchantId('mrc_other'),
        requestId,
        orderId: order.orderId,
      },
    );

    expect(unknown.statusCode).toBe(404);
    expect(otherMerchant.statusCode).toBe(404);
    expect(otherMerchant.body).toEqual(unknown.body);
    expect(unknown.body).toMatchObject({ code: 'ORDER_NOT_FOUND', requestId });
  });

  it('rejects a malformed ID without querying the repository', async () => {
    const get = vi.fn<OrderRepository['get']>();
    const dependency: OrderRepository = {
      create: vi.fn<OrderRepository['create']>(),
      get,
      list: vi.fn<OrderRepository['list']>(),
      saveStatusChange: vi.fn<OrderRepository['saveStatusChange']>(),
    };

    const response = await handleGetOrder(
      { repository: dependency },
      {
        merchantId: asMerchantId('mrc_demo'),
        requestId: 'request-789',
        orderId: 'not-an-order-id',
      },
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
    expect(get).not.toHaveBeenCalled();
  });
});
