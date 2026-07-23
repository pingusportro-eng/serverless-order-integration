import { readFile } from 'node:fs/promises';

import { marshall } from '@aws-sdk/util-dynamodb';
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import type { DynamoDBRecord } from 'aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Order } from '../../src/domain/order.js';
import type { DomainEventType } from '../../src/events/domain-event.js';
import type { OrderMutation } from '../../src/events/order-mutation.js';
import { domainEventFromOrderStreamRecord } from '../../src/events/order-stream-event.js';
import { createOrderFixture } from '../fixtures/order.js';

const STREAM_ARN =
  'arn:aws:dynamodb:eu-central-1:123456789012:table/orders/stream/2026-07-23T07:00:00.000';
const CORRELATION_ID = 'corr_mapper_test_123';
const CAUSATION_ID = 'request_mapper_test_123';

function record(
  order: Order,
  mutation: OrderMutation,
  eventName: DynamoDBRecord['eventName'] = 'MODIFY',
  itemOverrides: Readonly<Record<string, unknown>> = {},
): DynamoDBRecord {
  const newImage = marshall(
    {
      entityType: 'ORDER',
      schemaVersion: 1,
      order,
      mutation,
      ...itemOverrides,
    },
    { removeUndefinedValues: true },
  );
  return {
    eventID: `record-${String(order.version)}-${order.status}`,
    eventName,
    eventSourceARN: STREAM_ARN,
    dynamodb: {
      SequenceNumber: String(1000 + order.version),
      NewImage: newImage as unknown as NonNullable<
        NonNullable<DynamoDBRecord['dynamodb']>['NewImage']
      >,
    },
  };
}

function statusMutation(previousStatus: Order['status'], reason?: string): OrderMutation {
  return {
    kind: 'ORDER_STATUS_CHANGED',
    previousStatus,
    correlationId: CORRELATION_ID,
    causationId: CAUSATION_ID,
    ...(reason === undefined ? {} : { reason }),
  };
}

function acceptedOrder(overrides: Partial<Order>): Order {
  return createOrderFixture({
    provider: {
      providerCode: 'mock-delivery',
      submissionKey: 'submission_mapper_test_123',
      providerOrderId: 'delivery-mapper-123',
      acceptedAt: '2026-07-23T08:00:00.000Z',
    },
    updatedAt: '2026-07-23T08:00:00.000Z',
    version: 2,
    ...overrides,
  });
}

describe('order stream event mapper', () => {
  let validateEvent: ValidateFunction;

  beforeAll(async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../../docs/specifications/domain-event.schema.json', import.meta.url),
        'utf8',
      ),
    ) as AnySchema;
    validateEvent = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  });

  const cases: readonly {
    readonly name: string;
    readonly eventType: DomainEventType;
    readonly order: Order;
    readonly mutation: OrderMutation;
    readonly eventName?: DynamoDBRecord['eventName'];
  }[] = [
    {
      name: 'created',
      eventType: 'order.created',
      order: createOrderFixture({
        provider: {
          providerCode: 'mock-delivery',
          submissionKey: 'submission_mapper_test_123',
        },
      }),
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: CORRELATION_ID,
        causationId: CAUSATION_ID,
      },
      eventName: 'INSERT',
    },
    {
      name: 'submitted',
      eventType: 'order.submitted',
      order: acceptedOrder({ status: 'SUBMITTED' }),
      mutation: statusMutation('PENDING_SUBMISSION'),
    },
    {
      name: 'submission failed',
      eventType: 'order.submission_failed',
      order: createOrderFixture({
        status: 'SUBMISSION_FAILED',
        version: 2,
        updatedAt: '2026-07-23T08:00:00.000Z',
        failure: {
          stage: 'SUBMISSION',
          reasonCode: 'PROVIDER_REJECTED',
          summary: 'Mock provider rejected the submission.',
          occurredAt: '2026-07-23T08:00:00.000Z',
        },
      }),
      mutation: statusMutation('PENDING_SUBMISSION'),
    },
    {
      name: 'submission retry requested',
      eventType: 'order.submission_retry_requested',
      order: createOrderFixture({ status: 'PENDING_SUBMISSION', version: 3 }),
      mutation: statusMutation('SUBMISSION_FAILED', 'Operator approved retry.'),
    },
    {
      name: 'cancelled',
      eventType: 'order.cancelled',
      order: createOrderFixture({ status: 'CANCELLED', version: 2 }),
      mutation: statusMutation('PENDING_SUBMISSION', 'Operator cancelled the order.'),
    },
    {
      name: 'picked up',
      eventType: 'order.picked_up',
      order: acceptedOrder({ status: 'PICKED_UP', version: 3 }),
      mutation: statusMutation('SUBMITTED'),
    },
    {
      name: 'delivered',
      eventType: 'order.delivered',
      order: acceptedOrder({ status: 'DELIVERED', version: 4 }),
      mutation: statusMutation('PICKED_UP'),
    },
    {
      name: 'delivery failed',
      eventType: 'order.delivery_failed',
      order: acceptedOrder({
        status: 'DELIVERY_FAILED',
        version: 4,
        failure: {
          stage: 'DELIVERY',
          reasonCode: 'RECIPIENT_UNAVAILABLE',
          summary: 'Mock recipient could not be reached.',
          occurredAt: '2026-07-23T08:00:00.000Z',
        },
      }),
      mutation: statusMutation('PICKED_UP', 'Provider event reconciled.'),
    },
  ];

  for (const testCase of cases) {
    it(`maps a contract-valid ${testCase.name} event`, () => {
      const event = domainEventFromOrderStreamRecord(
        record(testCase.order, testCase.mutation, testCase.eventName),
      );

      expect(event?.eventType).toBe(testCase.eventType);
      expect(event).toMatchObject({
        schemaVersion: 1,
        aggregateVersion: testCase.order.version,
        correlationId: CORRELATION_ID,
        causationId: CAUSATION_ID,
      });
      expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
    });
  }

  it('ignores removed and non-order items', () => {
    const order = createOrderFixture();
    const mutation = statusMutation('PENDING_SUBMISSION');
    const removed = record(order, mutation, 'REMOVE');
    const supportItem = record(order, mutation, 'INSERT', { entityType: 'IDEMPOTENCY' });

    expect(domainEventFromOrderStreamRecord(removed)).toBeUndefined();
    expect(domainEventFromOrderStreamRecord(supportItem)).toBeUndefined();
  });

  it('rejects unsupported item and mutation versions', () => {
    const order = createOrderFixture();
    const unsupportedItem = record(order, statusMutation('PENDING_SUBMISSION'), 'MODIFY', {
      schemaVersion: 2,
    });
    const invalidMutation = record(order, {
      kind: 'ORDER_STATUS_CHANGED',
      previousStatus: 'PENDING_SUBMISSION',
      correlationId: CORRELATION_ID,
      causationId: CAUSATION_ID,
    });
    const image = invalidMutation.dynamodb?.NewImage;
    if (image?.['mutation']?.M) {
      image['mutation'].M['kind'] = { S: 'UNKNOWN' };
    }

    expect(() => domainEventFromOrderStreamRecord(unsupportedItem)).toThrow('schema version');
    expect(() => domainEventFromOrderStreamRecord(invalidMutation)).toThrow('kind is unsupported');
  });

  it('rejects inconsistent transitions and missing provider details', () => {
    const submittedFromWrongState = record(
      acceptedOrder({ status: 'SUBMITTED' }),
      statusMutation('SUBMITTED'),
    );
    const pickedUpWithoutProviderId = record(
      createOrderFixture({ status: 'PICKED_UP', version: 3 }),
      statusMutation('SUBMITTED'),
    );

    expect(() => domainEventFromOrderStreamRecord(submittedFromWrongState)).toThrow(
      'previous status is invalid',
    );
    expect(() => domainEventFromOrderStreamRecord(pickedUpWithoutProviderId)).toThrow(
      'provider.providerOrderId',
    );
  });

  it('rejects a stream order without NewImage', () => {
    const missingImage = record(createOrderFixture(), statusMutation('PENDING_SUBMISSION'));
    delete missingImage.dynamodb?.NewImage;

    expect(() => domainEventFromOrderStreamRecord(missingImage)).toThrow('missing NewImage');
  });
});
