import { beforeEach, describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  MerchantReferenceConflictError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  type OrderRepository,
} from '../../src/application/order-repository.js';
import type { Order } from '../../src/domain/order.js';
import { createOrderFixture } from '../fixtures/order.js';

type RepositoryFactory = () => OrderRepository | Promise<OrderRepository>;

function submittedOrder(order: Order): Order {
  return {
    ...order,
    status: 'SUBMITTED',
    provider: {
      ...order.provider,
      providerOrderId: `provider-${order.orderId}`,
      acceptedAt: '2026-07-21T12:31:00.000Z',
    },
    updatedAt: '2026-07-21T12:31:00.000Z',
    version: 2,
  };
}

export function orderRepositoryContract(name: string, createRepository: RepositoryFactory): void {
  describe(name, () => {
    let repository: OrderRepository;

    beforeEach(async () => {
      repository = await createRepository();
    });

    it('atomically creates and retrieves an order', async () => {
      const order = createOrderFixture();

      const result = await repository.create({
        order,
        idempotencyKey: 'idempotency-key-1',
        requestFingerprint: 'fingerprint-1',
      });

      expect(result).toEqual({ outcome: 'created', order });
      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
    });

    it('replays the original order for the same idempotency input', async () => {
      const order = createOrderFixture();
      const input = {
        order,
        idempotencyKey: 'idempotency-key-2',
        requestFingerprint: 'fingerprint-2',
      };

      await repository.create(input);
      const replay = await repository.create({
        ...input,
        order: createOrderFixture({ merchantId: order.merchantId }),
      });

      expect(replay).toEqual({ outcome: 'replayed', order });
    });

    it('rejects reuse of an idempotency key with a different fingerprint', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-3',
        requestFingerprint: 'fingerprint-3',
      });

      await expect(
        repository.create({
          order: createOrderFixture({ merchantId: order.merchantId }),
          idempotencyKey: 'idempotency-key-3',
          requestFingerprint: 'different-fingerprint',
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('rejects a different idempotency key for an existing merchant reference', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-4',
        requestFingerprint: 'fingerprint-4',
      });

      await expect(
        repository.create({
          order: createOrderFixture({
            merchantId: order.merchantId,
            merchantOrderReference: order.merchantOrderReference,
          }),
          idempotencyKey: 'different-idempotency-key',
          requestFingerprint: 'different-request',
        }),
      ).rejects.toBeInstanceOf(MerchantReferenceConflictError);
    });

    it('rejects an order ID collision without partial claims', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-5',
        requestFingerprint: 'fingerprint-5',
      });

      await expect(
        repository.create({
          order: createOrderFixture({
            orderId: order.orderId,
            merchantId: order.merchantId,
          }),
          idempotencyKey: 'different-idempotency-key',
          requestFingerprint: 'different-request',
        }),
      ).rejects.toBeInstanceOf(OrderAlreadyExistsError);
    });

    it('saves a status change when the expected version matches', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-6',
        requestFingerprint: 'fingerprint-6',
      });
      const changedOrder = submittedOrder(order);

      await repository.saveStatusChange(changedOrder, 1);

      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(changedOrder);
    });

    it('rejects a stale status write and preserves the winning version', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-7',
        requestFingerprint: 'fingerprint-7',
      });
      const winningOrder = submittedOrder(order);
      await repository.saveStatusChange(winningOrder, 1);

      const staleOrder: Order = {
        ...order,
        status: 'CANCELLED',
        updatedAt: '2026-07-21T12:32:00.000Z',
        version: 2,
      };
      const save = repository.saveStatusChange(staleOrder, 1);

      await expect(save).rejects.toMatchObject({ actualVersion: 2 });
      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(winningOrder);
    });

    it('distinguishes a missing order from a version conflict', async () => {
      const order = submittedOrder(createOrderFixture());

      await expect(repository.saveStatusChange(order, 1)).rejects.toBeInstanceOf(
        OrderNotFoundError,
      );
    });

    it('rejects a status change that does not increment exactly once', async () => {
      const order = createOrderFixture({ version: 3 });

      await expect(repository.saveStatusChange(order, 1)).rejects.toBeInstanceOf(RangeError);
    });
  });
}
