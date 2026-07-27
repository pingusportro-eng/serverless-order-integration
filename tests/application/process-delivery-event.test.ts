import { describe, expect, it, vi } from 'vitest';

import {
  DeliveryReconciliationRequiredError,
  processDeliveryEvent,
  type ProcessDeliveryEventDependencies,
} from '../../src/application/process-delivery-event.js';
import {
  OrderVersionConflictError,
  type OrderRepository,
} from '../../src/application/order-repository.js';
import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';
import type { OrderCreatedEvent } from '../../src/events/domain-event.js';
import {
  VENDOR_SUBMISSION_FAILURE_CODES,
  VendorSubmissionError,
  type DeliveryVendorClient,
  type VendorSubmissionFailureCode,
} from '../../src/integrations/delivery-vendor-client.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

const VENDOR_FAILURE_CASES = [
  { code: 'TIMEOUT', retryable: true },
  { code: 'NETWORK_ERROR', retryable: true },
  { code: 'RATE_LIMITED', retryable: true },
  { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { code: 'INVALID_RESPONSE', retryable: true },
  { code: 'AUTHENTICATION_FAILED', retryable: false },
  { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
  { code: 'REQUEST_REJECTED', retryable: false },
] as const satisfies readonly {
  readonly code: VendorSubmissionFailureCode;
  readonly retryable: boolean;
}[];

const RETRYABLE_VENDOR_FAILURES = VENDOR_FAILURE_CASES.filter((failure) => failure.retryable);
const TERMINAL_VENDOR_FAILURES = VENDOR_FAILURE_CASES.filter((failure) => !failure.retryable);

function eventFor(order: Order): OrderCreatedEvent {
  return {
    eventId: 'evt_01JPROCESSDELIVERY12345',
    eventType: 'order.created',
    schemaVersion: 1,
    aggregateType: 'ORDER',
    aggregateId: order.orderId,
    aggregateVersion: order.version,
    occurredAt: order.updatedAt,
    correlationId: 'corr_process_delivery_123',
    causationId: 'request_process_delivery_123',
    payload: {
      merchantId: order.merchantId,
      status: 'PENDING_SUBMISSION',
      providerCode: 'mock-delivery',
      submissionKey: order.provider.submissionKey,
    },
  };
}

function acceptingClient(): DeliveryVendorClient {
  return {
    submitDelivery: () =>
      Promise.resolve({
        providerOrderId: 'delivery-process-123',
        status: 'ACCEPTED',
        acceptedAt: '2026-07-23T11:00:00.000Z',
      }),
  };
}

function repositoryWithGet(order: Order | undefined): OrderRepository {
  return {
    create: () => Promise.reject(new Error('not used')),
    get: () => Promise.resolve(order),
    list: () => Promise.reject(new Error('not used')),
    saveStatusChange: () => Promise.resolve(),
  };
}

describe('processDeliveryEvent', () => {
  it('classifies every declared vendor failure code', () => {
    expect(VENDOR_FAILURE_CASES.map(({ code }) => code).toSorted()).toEqual(
      [...VENDOR_SUBMISSION_FAILURE_CODES].toSorted(),
    );
  });

  it.each(RETRYABLE_VENDOR_FAILURES)(
    'leaves $code on the retry path without changing the order',
    async ({ code }) => {
      const order = createOrderFixture();
      const saveStatusChange = vi.fn<OrderRepository['saveStatusChange']>(() => Promise.resolve());
      const repository: OrderRepository = {
        create: () => Promise.reject(new Error('not used')),
        get: () => Promise.resolve(order),
        list: () => Promise.reject(new Error('not used')),
        saveStatusChange,
      };
      const vendorClient: DeliveryVendorClient = {
        submitDelivery: () =>
          Promise.reject(
            new VendorSubmissionError({
              code,
              retryable: true,
              message: `Retryable provider failure: ${code}.`,
            }),
          ),
      };

      await expect(
        processDeliveryEvent({ repository, vendorClient }, eventFor(order)),
      ).rejects.toMatchObject({
        code,
        retryable: true,
      });
      expect(saveStatusChange).not.toHaveBeenCalled();
      expect(order).toMatchObject({ status: 'PENDING_SUBMISSION', version: 1 });
    },
  );

  it.each(TERMINAL_VENDOR_FAILURES)(
    'persists $code before acknowledging the delivery event',
    async ({ code }) => {
      const repository = new InMemoryOrderRepository();
      const order = createOrderFixture();
      await repository.create({
        order,
        idempotencyKey: `idempotency-${code.toLowerCase()}`,
        requestFingerprint: `fingerprint-${code.toLowerCase()}`,
        mutation: {
          kind: 'ORDER_CREATED',
          correlationId: 'corr_terminal_failure',
          causationId: 'request_terminal_failure',
        },
      });
      const summary = `Terminal provider failure: ${code}.`;
      const vendorClient: DeliveryVendorClient = {
        submitDelivery: () =>
          Promise.reject(
            new VendorSubmissionError({
              code,
              retryable: false,
              message: summary,
            }),
          ),
      };

      await expect(
        processDeliveryEvent(
          {
            repository,
            vendorClient,
            now: () => new Date('2026-07-23T11:00:01.000Z'),
          },
          eventFor(order),
        ),
      ).resolves.toMatchObject({
        outcome: 'submission_failed',
        order: {
          status: 'SUBMISSION_FAILED',
          version: 2,
          failure: {
            stage: 'SUBMISSION',
            reasonCode: code,
            summary,
            occurredAt: '2026-07-23T11:00:01.000Z',
          },
        },
      });
      await expect(repository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
        status: 'SUBMISSION_FAILED',
        version: 2,
        failure: {
          stage: 'SUBMISSION',
          reasonCode: code,
          summary,
        },
      });
    },
  );

  it('rejects a missing order', async () => {
    const order = createOrderFixture();

    await expect(
      processDeliveryEvent(
        { repository: repositoryWithGet(undefined), vendorClient: acceptingClient() },
        eventFor(order),
      ),
    ).rejects.toThrow('does not exist');
  });

  it('rejects merchant, submission-key, and future-version mismatches', async () => {
    const order = createOrderFixture();
    const event = eventFor(order);
    const wrongMerchant = {
      ...event,
      payload: { ...event.payload, merchantId: asMerchantId('mrc_other') },
    };
    const wrongKey = {
      ...event,
      payload: { ...event.payload, submissionKey: 'submission_different' },
    };
    const futureVersion = { ...event, aggregateVersion: order.version + 1 };
    const dependencies = { repository: repositoryWithGet(order), vendorClient: acceptingClient() };

    await expect(processDeliveryEvent(dependencies, wrongMerchant)).rejects.toThrow(
      'merchant does not match',
    );
    await expect(processDeliveryEvent(dependencies, wrongKey)).rejects.toThrow(
      'submission key does not match',
    );
    await expect(processDeliveryEvent(dependencies, futureVersion)).rejects.toThrow(
      'version that is not available',
    );
  });

  it('rejects an actionable event inconsistent with the current state', async () => {
    const order = createOrderFixture({ status: 'CANCELLED' });

    await expect(
      processDeliveryEvent(
        { repository: repositoryWithGet(order), vendorClient: acceptingClient() },
        eventFor(order),
      ),
    ).rejects.toThrow('inconsistent with the current order state');
  });

  it('recovers a concurrent version conflict when another worker already progressed the order', async () => {
    const order = createOrderFixture();
    const progressedOrder = createOrderFixture({
      ...order,
      status: 'SUBMITTED',
      provider: {
        ...order.provider,
        providerOrderId: 'delivery-process-123',
        acceptedAt: '2026-07-23T11:00:00.000Z',
      },
      updatedAt: '2026-07-23T11:00:01.000Z',
      version: 2,
    });
    const get = vi
      .fn<OrderRepository['get']>()
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(progressedOrder);
    const repository: OrderRepository = {
      create: () => Promise.reject(new Error('not used')),
      get,
      list: () => Promise.reject(new Error('not used')),
      saveStatusChange: () => Promise.reject(new OrderVersionConflictError(2)),
    };
    const dependencies: ProcessDeliveryEventDependencies = {
      repository,
      vendorClient: acceptingClient(),
      now: () => new Date('2026-07-23T11:00:01.000Z'),
    };

    await expect(processDeliveryEvent(dependencies, eventFor(order))).resolves.toEqual({
      outcome: 'duplicate_or_stale',
      order: progressedOrder,
    });
  });

  it('does not acknowledge a version conflict with an incompatible newer state', async () => {
    const order = createOrderFixture();
    const cancelledOrder = createOrderFixture({
      ...order,
      status: 'CANCELLED',
      updatedAt: '2026-07-23T11:00:01.000Z',
      version: 2,
    });
    const get = vi
      .fn<OrderRepository['get']>()
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce(cancelledOrder);
    const repository: OrderRepository = {
      create: () => Promise.reject(new Error('not used')),
      get,
      list: () => Promise.reject(new Error('not used')),
      saveStatusChange: () => Promise.reject(new OrderVersionConflictError(2)),
    };

    await expect(
      processDeliveryEvent(
        {
          repository,
          vendorClient: acceptingClient(),
          now: () => new Date('2026-07-23T11:00:01.000Z'),
        },
        eventFor(order),
      ),
    ).rejects.toBeInstanceOf(DeliveryReconciliationRequiredError);
  });

  it('recovers when the vendor accepted but the first database write failed', async () => {
    const innerRepository = new InMemoryOrderRepository();
    const order = createOrderFixture();
    await innerRepository.create({
      order,
      idempotencyKey: 'idempotency-database-recovery',
      requestFingerprint: 'fingerprint-database-recovery',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_database_recovery',
        causationId: 'request_database_recovery',
      },
    });
    let failNextSave = true;
    const repository: OrderRepository = {
      create: (input) => innerRepository.create(input),
      get: (inputMerchantId, orderId) => innerRepository.get(inputMerchantId, orderId),
      list: (input) => innerRepository.list(input),
      saveStatusChange: (changedOrder, expectedVersion, mutation) => {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject(new Error('DynamoDB temporarily unavailable'));
        }
        return innerRepository.saveStatusChange(changedOrder, expectedVersion, mutation);
      },
    };
    const submissionKeys: string[] = [];
    const vendorClient: DeliveryVendorClient = {
      submitDelivery: (submittedOrder) => {
        submissionKeys.push(submittedOrder.provider.submissionKey);
        return Promise.resolve({
          providerOrderId: 'delivery-recovered-123',
          status: 'ACCEPTED',
          acceptedAt: '2026-07-23T11:00:00.000Z',
        });
      },
    };
    const dependencies: ProcessDeliveryEventDependencies = {
      repository,
      vendorClient,
      now: () => new Date('2026-07-23T11:00:01.000Z'),
    };
    const event = eventFor(order);

    await expect(processDeliveryEvent(dependencies, event)).rejects.toThrow(
      'DynamoDB temporarily unavailable',
    );
    await expect(innerRepository.get(order.merchantId, order.orderId)).resolves.toMatchObject({
      status: 'PENDING_SUBMISSION',
      version: 1,
    });

    await expect(processDeliveryEvent(dependencies, event)).resolves.toMatchObject({
      outcome: 'submitted',
      order: {
        status: 'SUBMITTED',
        version: 2,
        provider: { providerOrderId: 'delivery-recovered-123' },
      },
    });
    expect(submissionKeys).toEqual([order.provider.submissionKey, order.provider.submissionKey]);
  });

  it('requires reconciliation for an incompatible stale event', async () => {
    const original = createOrderFixture();
    const cancelled = createOrderFixture({
      ...original,
      status: 'CANCELLED',
      version: 2,
    });

    await expect(
      processDeliveryEvent(
        { repository: repositoryWithGet(cancelled), vendorClient: acceptingClient() },
        eventFor(original),
      ),
    ).rejects.toBeInstanceOf(DeliveryReconciliationRequiredError);
  });

  it('keeps a version conflict retryable when the competing state cannot be observed', async () => {
    const order = createOrderFixture({ orderId: asOrderId('ord_01JCONFLICT123456789') });
    const repository: OrderRepository = {
      create: () => Promise.reject(new Error('not used')),
      get: () => Promise.resolve(order),
      list: () => Promise.reject(new Error('not used')),
      saveStatusChange: () => Promise.reject(new OrderVersionConflictError(2)),
    };

    await expect(
      processDeliveryEvent(
        {
          repository,
          vendorClient: acceptingClient(),
          now: () => new Date('2026-07-23T11:00:01.000Z'),
        },
        eventFor(order),
      ),
    ).rejects.toBeInstanceOf(OrderVersionConflictError);
  });
});
