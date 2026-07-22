import { beforeEach, describe, expect, it } from 'vitest';

import { asMerchantId, asOrderId, type MerchantId, type Order } from '../../src/domain/order.js';
import { handleListOrders } from '../../src/http/list-orders-handler.js';
import { createOrderCursorCodec } from '../../src/http/order-cursor.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

const SIGNING_SECRET = 'handler-test-secret-with-at-least-thirty-two-bytes';

describe('handleListOrders', () => {
  let repository: InMemoryOrderRepository;
  const merchantId = asMerchantId('mrc_list_handler');
  const cursorCodec = createOrderCursorCodec(SIGNING_SECRET);

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
  });

  async function storeOrders(targetMerchantId: MerchantId, count: number): Promise<Order[]> {
    const orders = Array.from({ length: count }, (_, index) =>
      createOrderFixture({
        orderId: asOrderId(`ord_handler${String(index).padStart(2, '0')}`),
        merchantId: targetMerchantId,
        merchantOrderReference: `handler-reference-${String(index)}`,
        createdAt: `2026-07-21T12:3${String(index)}:00.000Z`,
        updatedAt: `2026-07-21T12:3${String(index)}:00.000Z`,
      }),
    );

    for (const [index, order] of orders.entries()) {
      await repository.create({
        order,
        idempotencyKey: `handler-idempotency-${String(index)}`,
        requestFingerprint: `handler-fingerprint-${String(index)}`,
      });
    }

    return orders;
  }

  it('returns first, middle, and final pages with opaque cursors', async () => {
    const orders = await storeOrders(merchantId, 5);
    const dependencies = { repository, cursorCodec };

    const firstPage = await handleListOrders(dependencies, {
      merchantId,
      requestId: 'request-first',
      query: { limit: '2' },
    });
    expect(firstPage.statusCode).toBe(200);
    if (!('items' in firstPage.body)) {
      throw new Error('Expected an order page.');
    }
    expect(firstPage.body.items.map((order) => order.orderId)).toEqual([
      orders[4]?.orderId,
      orders[3]?.orderId,
    ]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const firstCursor = firstPage.body.nextCursor;
    if (firstCursor === undefined) {
      throw new Error('Expected a cursor for the middle page.');
    }

    const middlePage = await handleListOrders(dependencies, {
      merchantId,
      requestId: 'request-middle',
      query: { limit: '2', cursor: firstCursor },
    });
    if (!('items' in middlePage.body)) {
      throw new Error('Expected an order page.');
    }
    expect(middlePage.body.items.map((order) => order.orderId)).toEqual([
      orders[2]?.orderId,
      orders[1]?.orderId,
    ]);
    expect(middlePage.body.nextCursor).toEqual(expect.any(String));
    const middleCursor = middlePage.body.nextCursor;
    if (middleCursor === undefined) {
      throw new Error('Expected a cursor for the final page.');
    }

    const finalPage = await handleListOrders(dependencies, {
      merchantId,
      requestId: 'request-final',
      query: { limit: '2', cursor: middleCursor },
    });
    if (!('items' in finalPage.body)) {
      throw new Error('Expected an order page.');
    }
    expect(finalPage.body.items.map((order) => order.orderId)).toEqual([orders[0]?.orderId]);
    expect(finalPage.body.nextCursor).toBeUndefined();
  });

  it('applies the status filter', async () => {
    const orders = await storeOrders(merchantId, 2);
    const changedOrder = orders[1];
    if (changedOrder === undefined) {
      throw new Error('Expected an order to change.');
    }
    await repository.saveStatusChange(
      {
        ...changedOrder,
        status: 'SUBMITTED',
        provider: {
          ...changedOrder.provider,
          providerOrderId: 'provider-handler',
          acceptedAt: '2026-07-21T12:40:00.000Z',
        },
        updatedAt: '2026-07-21T12:40:00.000Z',
        version: 2,
      },
      1,
    );

    const response = await handleListOrders(
      { repository, cursorCodec },
      {
        merchantId,
        requestId: 'request-status',
        query: { status: 'SUBMITTED' },
      },
    );

    if (!('items' in response.body)) {
      throw new Error('Expected an order page.');
    }
    expect(response.body.items.map((order) => order.orderId)).toEqual([orders[1]?.orderId]);
  });

  it.each(['0', '101', '1.5', 'many'])('rejects invalid limit %s', async (limit) => {
    const response = await handleListOrders(
      { repository, cursorCodec },
      { merchantId, requestId: 'request-invalid-limit', query: { limit } },
    );

    expect(response).toMatchObject({
      statusCode: 422,
      body: {
        code: 'VALIDATION_ERROR',
        errors: [{ pointer: '#/query/limit' }],
      },
    });
  });

  it('rejects unsupported statuses', async () => {
    const response = await handleListOrders(
      { repository, cursorCodec },
      { merchantId, requestId: 'request-invalid-status', query: { status: 'UNKNOWN' } },
    );

    expect(response).toMatchObject({
      statusCode: 422,
      body: {
        code: 'VALIDATION_ERROR',
        errors: [{ pointer: '#/query/status' }],
      },
    });
  });

  it('rejects a cursor reused for another merchant', async () => {
    await storeOrders(merchantId, 2);
    const dependencies = { repository, cursorCodec };
    const firstPage = await handleListOrders(dependencies, {
      merchantId,
      requestId: 'request-cursor-source',
      query: { limit: '1' },
    });
    if (!('items' in firstPage.body)) {
      throw new Error('Expected an order page.');
    }
    const cursor = firstPage.body.nextCursor;
    if (cursor === undefined) {
      throw new Error('Expected a cursor owned by the source merchant.');
    }

    const response = await handleListOrders(dependencies, {
      merchantId: asMerchantId('mrc_wrong_cursor_owner'),
      requestId: 'request-wrong-owner',
      query: { cursor },
    });

    expect(response).toMatchObject({
      statusCode: 422,
      body: {
        code: 'VALIDATION_ERROR',
        errors: [{ pointer: '#/query/cursor' }],
      },
    });
  });
});
