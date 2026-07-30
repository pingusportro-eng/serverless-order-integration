import { beforeEach, describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  MerchantOrderIdConflictError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  type OrderRepository,
} from '../../src/application/order-repository.js';
import {
  ProviderEventIdConflictError,
  DeliveryProviderOrderIdConflictError,
  type ProviderWebhookRepository,
} from '../../src/application/provider-webhook-repository.js';
import { applyOrderStatusChange } from '../../src/domain/order-status-transition.js';
import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';
import { createOrderFixture } from '../fixtures/order.js';

type TestedRepository = OrderRepository & ProviderWebhookRepository;
type RepositoryFactory = () => TestedRepository | Promise<TestedRepository>;

function submittedOrder(order: Order): Order {
  return {
    ...order,
    status: 'SUBMITTED',
    provider: {
      ...order.provider,
      deliveryProviderOrderId: `provider-${order.merchantId}-${order.orderId}`,
      acceptedAt: '2026-07-21T12:31:00.000Z',
    },
    updatedAt: '2026-07-21T12:31:00.000Z',
    version: 2,
  };
}

const STATUS_MUTATION = {
  kind: 'ORDER_STATUS_CHANGED',
  previousStatus: 'PENDING_SUBMISSION',
  correlationId: 'corr_repository_123',
  causationId: 'request_repository_123',
} as const;

export function orderRepositoryContract(name: string, createRepository: RepositoryFactory): void {
  describe(name, () => {
    let repository: TestedRepository;

    beforeEach(async () => {
      repository = await createRepository();
    });

    it('atomically creates and retrieves an order', async () => {
      const order = createOrderFixture();

      const result = await repository.create({
        order,
        idempotencyKey: 'idempotency-key-1',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
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
        mutation: {
          kind: 'ORDER_CREATED' as const,
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
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
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'fingerprint-3',
      });

      await expect(
        repository.create({
          order: createOrderFixture({ merchantId: order.merchantId }),
          idempotencyKey: 'idempotency-key-3',
          mutation: {
            kind: 'ORDER_CREATED',
            correlationId: 'corr_test_123',
            causationId: 'request_test_123',
          },
          requestFingerprint: 'different-fingerprint',
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('rejects a different idempotency key for an existing merchant order ID', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-4',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'fingerprint-4',
      });

      await expect(
        repository.create({
          order: createOrderFixture({
            merchantId: order.merchantId,
            merchantOrderId: order.merchantOrderId,
          }),
          idempotencyKey: 'different-idempotency-key',
          mutation: {
            kind: 'ORDER_CREATED',
            correlationId: 'corr_test_123',
            causationId: 'request_test_123',
          },
          requestFingerprint: 'different-request',
        }),
      ).rejects.toBeInstanceOf(MerchantOrderIdConflictError);
    });

    it('rejects an order ID collision without partial claims', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-5',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'fingerprint-5',
      });

      await expect(
        repository.create({
          order: createOrderFixture({
            orderId: order.orderId,
            merchantId: order.merchantId,
          }),
          idempotencyKey: 'different-idempotency-key',
          mutation: {
            kind: 'ORDER_CREATED',
            correlationId: 'corr_test_123',
            causationId: 'request_test_123',
          },
          requestFingerprint: 'different-request',
        }),
      ).rejects.toBeInstanceOf(OrderAlreadyExistsError);
    });

    it('saves a status change when the expected version matches', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-6',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'fingerprint-6',
      });
      const changedOrder = submittedOrder(order);

      await repository.saveStatusChange(changedOrder, 1, STATUS_MUTATION);

      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(changedOrder);
    });

    it('resolves a submitted order by its delivery-provider order ID', async () => {
      const order = createOrderFixture();
      const changedOrder = submittedOrder(order);
      await repository.create({
        order,
        idempotencyKey: 'delivery-provider-order-id-idempotency',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'delivery-provider-order-id-fingerprint',
      });
      await repository.saveStatusChange(changedOrder, order.version, STATUS_MUTATION);

      await expect(
        repository.getByDeliveryProviderOrderId(
          changedOrder.provider.deliveryProviderCode,
          changedOrder.provider.deliveryProviderOrderId ?? '',
        ),
      ).resolves.toEqual(changedOrder);
    });

    it('rejects a delivery-provider order ID already assigned to another order atomically', async () => {
      const firstOrder = createOrderFixture();
      const secondOrder = createOrderFixture();
      const firstAccepted = submittedOrder(firstOrder);
      const sharedDeliveryProviderOrderId = firstAccepted.provider.deliveryProviderOrderId;
      if (sharedDeliveryProviderOrderId === undefined) {
        throw new Error('Expected a submitted delivery-provider order ID.');
      }
      const secondAccepted: Order = {
        ...submittedOrder(secondOrder),
        provider: {
          ...secondOrder.provider,
          deliveryProviderOrderId: sharedDeliveryProviderOrderId,
          acceptedAt: '2026-07-21T12:31:00.000Z',
        },
      };
      for (const [index, order] of [firstOrder, secondOrder].entries()) {
        await repository.create({
          order,
          idempotencyKey: `provider-conflict-idempotency-${String(index)}`,
          mutation: {
            kind: 'ORDER_CREATED',
            correlationId: 'corr_test_123',
            causationId: 'request_test_123',
          },
          requestFingerprint: `provider-conflict-fingerprint-${String(index)}`,
        });
      }

      await repository.saveStatusChange(firstAccepted, firstOrder.version, STATUS_MUTATION);
      await expect(
        repository.saveStatusChange(secondAccepted, secondOrder.version, STATUS_MUTATION),
      ).rejects.toBeInstanceOf(DeliveryProviderOrderIdConflictError);
      await expect(repository.get(secondOrder.merchantId, secondOrder.orderId)).resolves.toEqual(
        secondOrder,
      );
    });

    it('atomically records provider event deduplication with a status change', async () => {
      const order = createOrderFixture();
      const accepted = submittedOrder(order);
      const pickedUp = applyOrderStatusChange(
        accepted,
        { targetStatus: 'PICKED_UP' },
        '2026-07-21T12:32:00.000Z',
      );
      await repository.create({
        order,
        idempotencyKey: 'provider-event-idempotency',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'provider-event-fingerprint',
      });
      await repository.saveStatusChange(accepted, order.version, STATUS_MUTATION);
      const providerEventId = `provider-event-contract-${order.orderId}`;
      const input = {
        eventId: providerEventId,
        eventFingerprint: 'event-fingerprint-1',
        deliveryProviderOrderId: accepted.provider.deliveryProviderOrderId ?? '',
        processedAt: '2026-07-21T12:35:00.000Z',
        currentOrder: accepted,
        changedOrder: pickedUp,
        mutation: {
          kind: 'ORDER_STATUS_CHANGED' as const,
          previousStatus: accepted.status,
          correlationId: 'corr_provider_123',
          causationId: providerEventId,
        },
      };

      await expect(repository.recordProviderWebhook(input)).resolves.toBe('recorded');
      await expect(repository.recordProviderWebhook(input)).resolves.toBe('duplicate');
      await expect(
        repository.recordProviderWebhook({
          ...input,
          eventFingerprint: 'different-event-fingerprint',
        }),
      ).rejects.toBeInstanceOf(ProviderEventIdConflictError);
      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(pickedUp);
    });

    it('rejects a stale status write and preserves the winning version', async () => {
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: 'idempotency-key-7',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'fingerprint-7',
      });
      const winningOrder = submittedOrder(order);
      await repository.saveStatusChange(winningOrder, 1, STATUS_MUTATION);

      const staleOrder: Order = {
        ...order,
        status: 'CANCELLED',
        updatedAt: '2026-07-21T12:32:00.000Z',
        version: 2,
      };
      const save = repository.saveStatusChange(staleOrder, 1, STATUS_MUTATION);

      await expect(save).rejects.toMatchObject({ actualVersion: 2 });
      await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(winningOrder);
    });

    it('distinguishes a missing order from a version conflict', async () => {
      const order = submittedOrder(createOrderFixture());

      await expect(repository.saveStatusChange(order, 1, STATUS_MUTATION)).rejects.toBeInstanceOf(
        OrderNotFoundError,
      );
    });

    it('rejects a status change that does not increment exactly once', async () => {
      const order = createOrderFixture({ version: 3 });

      await expect(repository.saveStatusChange(order, 1, STATUS_MUTATION)).rejects.toBeInstanceOf(
        RangeError,
      );
    });

    it('paginates first, middle, and final pages newest-first within one merchant', async () => {
      const merchantId = asMerchantId(`mrc_list_${crypto.randomUUID().replaceAll('-', '')}`);
      const orderIds = [
        asOrderId('ord_00000001'),
        asOrderId('ord_00000002'),
        asOrderId('ord_00000003'),
        asOrderId('ord_00000004'),
      ];
      const orders = orderIds.map((orderId, index) =>
        createOrderFixture({
          orderId,
          merchantId,
          merchantOrderId: `list-merchant-order-${String(index)}`,
          createdAt: `2026-07-21T12:3${String(index)}:00.000Z`,
          updatedAt: `2026-07-21T12:3${String(index)}:00.000Z`,
        }),
      );

      for (const [index, order] of orders.entries()) {
        await repository.create({
          order,
          idempotencyKey: `list-idempotency-${String(index)}`,
          mutation: {
            kind: 'ORDER_CREATED',
            correlationId: 'corr_test_123',
            causationId: 'request_test_123',
          },
          requestFingerprint: `list-fingerprint-${String(index)}`,
        });
      }

      const otherMerchantOrder = createOrderFixture({
        createdAt: '2026-07-21T13:00:00.000Z',
        updatedAt: '2026-07-21T13:00:00.000Z',
      });
      await repository.create({
        order: otherMerchantOrder,
        idempotencyKey: 'other-merchant-idempotency',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'other-merchant-fingerprint',
      });

      const firstPage = await repository.list({ merchantId, limit: 2 });
      expect(firstPage.orders.map((order) => order.orderId)).toEqual([orderIds[3], orderIds[2]]);
      expect(firstPage.nextPosition).toEqual({
        createdAt: orders[2]?.createdAt,
        orderId: orderIds[2],
      });
      if (firstPage.nextPosition === undefined) {
        throw new Error('Expected a middle-page position.');
      }

      const middlePage = await repository.list({
        merchantId,
        limit: 1,
        position: firstPage.nextPosition,
      });
      expect(middlePage.orders.map((order) => order.orderId)).toEqual([orderIds[1]]);
      expect(middlePage.nextPosition).toEqual({
        createdAt: orders[1]?.createdAt,
        orderId: orderIds[1],
      });
      if (middlePage.nextPosition === undefined) {
        throw new Error('Expected a final-page position.');
      }

      const finalPage = await repository.list({
        merchantId,
        limit: 2,
        position: middlePage.nextPosition,
      });
      expect(finalPage.orders.map((order) => order.orderId)).toEqual([orderIds[0]]);
      expect(finalPage.nextPosition).toBeUndefined();
    });

    it('uses the status index and reflects status changes', async () => {
      const merchantId = asMerchantId(`mrc_status_${crypto.randomUUID().replaceAll('-', '')}`);
      const pendingOrder = createOrderFixture({
        orderId: asOrderId('ord_status001'),
        merchantId,
        merchantOrderId: 'status-merchant-order-1',
      });
      const changedOrder = submittedOrder(pendingOrder);
      const remainingPendingOrder = createOrderFixture({
        orderId: asOrderId('ord_status002'),
        merchantId,
        merchantOrderId: 'status-merchant-order-2',
      });

      await repository.create({
        order: pendingOrder,
        idempotencyKey: 'status-idempotency-1',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'status-fingerprint-1',
      });
      await repository.create({
        order: remainingPendingOrder,
        idempotencyKey: 'status-idempotency-2',
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_test_123',
          causationId: 'request_test_123',
        },
        requestFingerprint: 'status-fingerprint-2',
      });
      await repository.saveStatusChange(changedOrder, 1, STATUS_MUTATION);

      const pendingPage = await repository.list({
        merchantId,
        status: 'PENDING_SUBMISSION',
        limit: 100,
      });
      const submittedPage = await repository.list({ merchantId, status: 'SUBMITTED', limit: 100 });

      expect(pendingPage.orders.map((order) => order.orderId)).toEqual([
        remainingPendingOrder.orderId,
      ]);
      expect(submittedPage.orders.map((order) => order.orderId)).toEqual([changedOrder.orderId]);
    });

    it('rejects an unbounded page size', async () => {
      const merchantId = createOrderFixture().merchantId;

      await expect(repository.list({ merchantId, limit: 101 })).rejects.toBeInstanceOf(RangeError);
    });
  });
}
