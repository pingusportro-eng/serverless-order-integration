import { readFile } from 'node:fs/promises';

import type { SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { processDeliveryEvent } from '../../src/application/process-delivery-event.js';
import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';
import { parseDeliveryRequestedEvent } from '../../src/events/delivery-requested-event.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import {
  VendorSubmissionError,
  type DeliveryVendorClient,
} from '../../src/integrations/delivery-vendor-client.js';
import { createDeliveryWorkerHandler } from '../../src/lambda/delivery-worker.js';
import { createPaidOrderFixture } from '../fixtures/order.js';

const fixtureUrl = new URL('../fixtures/sqs/delivery-worker-batch.json', import.meta.url);
const merchantId = asMerchantId('mrc_demo');

async function readBatch(): Promise<SQSEvent> {
  return JSON.parse(await readFile(fixtureUrl, 'utf8')) as SQSEvent;
}

async function seed(repository: InMemoryOrderRepository, order: Order): Promise<void> {
  await repository.create({
    order,
    idempotencyKey: `idempotency-${order.orderId}`,
    requestFingerprint: `fingerprint-${order.orderId}`,
    mutation: {
      kind: 'ORDER_CREATED',
      correlationId: 'corr_seed_123',
      causationId: 'request_seed_123',
    },
  });
}

describe('SQS delivery worker', () => {
  it('processes successes and duplicates while returning transient and poison failures', async () => {
    const batch = await readBatch();
    const repository = new InMemoryOrderRepository();
    const successfulOrder = createPaidOrderFixture({
      orderId: asOrderId('ord_01JABCDEF0123456789'),
      merchantId,
      provider: {
        deliveryProviderCode: 'mock-delivery',
        deliveryProviderSubmissionKey: 'submission_01JABCDEF0123456789',
      },
    });
    const transientOrder = createPaidOrderFixture({
      orderId: asOrderId('ord_01JABCDEF0123456790'),
      merchantId,
      provider: {
        deliveryProviderCode: 'mock-delivery',
        deliveryProviderSubmissionKey: 'submission_01JABCDEF0123456790',
      },
    });
    await seed(repository, successfulOrder);
    await seed(repository, transientOrder);

    const submitDelivery = vi.fn<DeliveryVendorClient['submitDelivery']>((order) => {
      if (order.orderId === transientOrder.orderId) {
        return Promise.reject(
          new VendorSubmissionError({
            code: 'PROVIDER_UNAVAILABLE',
            retryable: true,
            message: 'Delivery provider is unavailable.',
            statusCode: 500,
          }),
        );
      }
      return Promise.resolve({
        deliveryProviderOrderId: 'delivery-success-123',
        status: 'ACCEPTED',
        acceptedAt: '2026-07-23T10:00:05.000Z',
      });
    });
    const logLines: string[] = [];
    const handler = createDeliveryWorkerHandler({
      processor: {
        async process(event) {
          const result = await processDeliveryEvent(
            {
              repository,
              vendorClient: { submitDelivery },
              now: () => new Date('2026-07-23T10:00:06.000Z'),
            },
            event,
          );
          return {
            outcome: result.outcome,
            orderVersion: result.order.version,
          };
        },
      },
      logSink: (line) => {
        logLines.push(line);
      },
    });

    await expect(handler(batch)).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'message-poison-002' },
        { itemIdentifier: 'message-transient-004' },
      ],
    });
    expect(submitDelivery).toHaveBeenCalledTimes(2);
    expect(logLines.map((line): unknown => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        event: 'delivery.message.processed',
        requestId: 'message-success-001',
        correlationId: 'corr_01JABCDEF0123456789',
        eventId: 'evt_01JABCDEF0123456789A',
        eventType: 'order.ready_for_submission',
        orderId: 'ord_01JABCDEF0123456789',
        aggregateVersion: 1,
        orderVersion: 2,
        outcome: 'submitted',
        attempt: 1,
      }),
      expect.objectContaining({
        event: 'delivery.message.failed',
        requestId: 'message-poison-002',
        exceptionName: 'Error',
        attempt: 1,
      }),
      expect.objectContaining({
        event: 'delivery.message.processed',
        requestId: 'message-duplicate-003',
        correlationId: 'corr_01JABCDEF0123456789',
        eventId: 'evt_01JABCDEF0123456789A',
        eventType: 'order.ready_for_submission',
        orderId: 'ord_01JABCDEF0123456789',
        aggregateVersion: 1,
        orderVersion: 2,
        outcome: 'duplicate_or_stale',
        attempt: 2,
      }),
      expect.objectContaining({
        event: 'delivery.message.failed',
        requestId: 'message-transient-004',
        correlationId: 'corr_01JABCDEF0123456790',
        eventId: 'evt_01JABCDEF0123456789B',
        eventType: 'order.ready_for_submission',
        orderId: 'ord_01JABCDEF0123456790',
        aggregateVersion: 1,
        attempt: 1,
        exceptionName: 'VendorSubmissionError',
      }),
    ]);
    await expect(repository.get(merchantId, successfulOrder.orderId)).resolves.toMatchObject({
      status: 'SUBMITTED',
      version: 2,
      provider: {
        deliveryProviderOrderId: 'delivery-success-123',
        acceptedAt: '2026-07-23T10:00:05.000Z',
      },
    });
    await expect(repository.get(merchantId, transientOrder.orderId)).resolves.toMatchObject({
      status: 'PENDING_SUBMISSION',
      version: 1,
    });
  });

  it('records a safe terminal submission failure and acknowledges the message', async () => {
    const batch = await readBatch();
    const event = parseDeliveryRequestedEvent(batch.Records[0]?.body ?? '');
    const repository = new InMemoryOrderRepository();
    const order = createPaidOrderFixture({
      orderId: asOrderId(event.aggregateId),
      merchantId,
      provider: {
        deliveryProviderCode: 'mock-delivery',
        deliveryProviderSubmissionKey: event.payload.deliveryProviderSubmissionKey,
      },
    });
    await seed(repository, order);
    const vendorClient: DeliveryVendorClient = {
      submitDelivery: () =>
        Promise.reject(
          new VendorSubmissionError({
            code: 'AUTHENTICATION_FAILED',
            retryable: false,
            message: 'Delivery provider authentication failed.',
            statusCode: 401,
          }),
        ),
    };

    await expect(
      processDeliveryEvent(
        {
          repository,
          vendorClient,
          now: () => new Date('2026-07-23T10:00:07.000Z'),
        },
        event,
      ),
    ).resolves.toMatchObject({ outcome: 'submission_failed' });
    await expect(repository.get(merchantId, order.orderId)).resolves.toMatchObject({
      status: 'SUBMISSION_FAILED',
      version: 2,
      failure: {
        stage: 'SUBMISSION',
        reasonCode: 'AUTHENTICATION_FAILED',
        summary: 'Delivery provider authentication failed.',
      },
    });
  });
});
