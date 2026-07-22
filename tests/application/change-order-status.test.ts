import { describe, expect, it } from 'vitest';

import { changeOrderStatus } from '../../src/application/change-order-status.js';
import { OrderVersionConflictError } from '../../src/application/order-repository.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

describe('changeOrderStatus', () => {
  it('allows only one of two concurrent changes at the same expected version', async () => {
    const repository = new InMemoryOrderRepository();
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'concurrent-status-key',
      requestFingerprint: 'concurrent-status-fingerprint',
    });
    const dependencies = {
      repository,
      now: () => new Date('2026-07-22T10:00:00.000Z'),
    };

    const results = await Promise.allSettled([
      changeOrderStatus(dependencies, {
        merchantId: order.merchantId,
        orderId: order.orderId,
        expectedVersion: 1,
        body: {
          targetStatus: 'SUBMITTED',
          reason: 'Provider acceptance was reconciled.',
          providerOrderId: 'provider-concurrent',
        },
      }),
      changeOrderStatus(dependencies, {
        merchantId: order.merchantId,
        orderId: order.orderId,
        expectedVersion: 1,
        body: { targetStatus: 'CANCELLED', reason: 'Operator cancelled the order.' },
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status !== 'rejected') {
      throw new Error('Expected one rejected concurrent change.');
    }
    expect(rejected.reason).toBeInstanceOf(OrderVersionConflictError);
    const storedOrder = await repository.get(order.merchantId, order.orderId);
    expect(storedOrder).toMatchObject({ version: 2 });
    expect(['SUBMITTED', 'CANCELLED']).toContain(storedOrder?.status);
  });
});
