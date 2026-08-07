import { createHash } from 'node:crypto';

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';

import type { FailureDetails, Order } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';
import { PAYMENT_STATUSES, type PaymentStatus } from '../domain/payment.js';
import type { DomainEvent, DomainEventType } from './domain-event.js';
import type { OrderMutation } from './order-mutation.js';

interface StreamOrderItem {
  readonly entityType: 'ORDER';
  readonly schemaVersion: 2;
  readonly order: Order;
  readonly mutation: OrderMutation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Stream order ${field} must be a non-empty string.`);
  }
  return value;
}

function readOrder(value: unknown): Order {
  if (!isRecord(value)) {
    throw new Error('Stream order payload must be an object.');
  }

  const provider = value['provider'];
  if (!isRecord(provider) || provider['deliveryProviderCode'] !== 'mock-delivery') {
    throw new Error('Stream order provider is invalid.');
  }
  const version = value['version'];
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error('Stream order version must be a positive integer.');
  }

  requiredString(value['orderId'], 'orderId');
  requiredString(value['merchantId'], 'merchantId');
  requiredString(value['updatedAt'], 'updatedAt');
  requiredString(provider['deliveryProviderSubmissionKey'], 'deliveryProviderSubmissionKey');
  requiredString(value['status'], 'status');

  return value as unknown as Order;
}

function readMutation(value: unknown): OrderMutation {
  if (!isRecord(value)) {
    throw new Error('Stream order mutation must be an object.');
  }

  const correlationId = requiredString(value['correlationId'], 'mutation.correlationId');
  const causationId = requiredString(value['causationId'], 'mutation.causationId');
  if (value['kind'] === 'ORDER_CREATED') {
    return { kind: 'ORDER_CREATED', correlationId, causationId };
  }
  if (value['kind'] === 'ORDER_STATUS_CHANGED') {
    const previousStatus = requiredString(
      value['previousStatus'],
      'mutation.previousStatus',
    ) as OrderStatus;
    const reason = value['reason'];
    if (reason !== undefined && typeof reason !== 'string') {
      throw new Error('Stream order mutation.reason must be a string.');
    }
    return {
      kind: 'ORDER_STATUS_CHANGED',
      correlationId,
      causationId,
      previousStatus,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (value['kind'] === 'ORDER_PAYMENT_CHANGED') {
    const previousPaymentStatus = requiredString(
      value['previousPaymentStatus'],
      'mutation.previousPaymentStatus',
    );
    if (!PAYMENT_STATUSES.some((status) => status === previousPaymentStatus)) {
      throw new Error('Stream order mutation.previousPaymentStatus is unsupported.');
    }
    return {
      kind: 'ORDER_PAYMENT_CHANGED',
      correlationId,
      causationId,
      previousPaymentStatus: previousPaymentStatus as PaymentStatus,
    };
  }

  throw new Error('Stream order mutation kind is unsupported.');
}

function readStreamItem(record: DynamoDBRecord): StreamOrderItem | undefined {
  if (record.eventName === 'REMOVE') {
    return undefined;
  }
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
    throw new Error('DynamoDB stream event name is unsupported.');
  }

  const newImage = record.dynamodb?.NewImage;
  if (newImage === undefined) {
    throw new Error('DynamoDB stream record is missing NewImage.');
  }
  const item = unmarshall(newImage as Record<string, AttributeValue>);
  if (item['entityType'] !== 'ORDER') {
    return undefined;
  }
  if (item['schemaVersion'] !== 2) {
    throw new Error('Stream order item schema version is unsupported.');
  }

  return {
    entityType: 'ORDER',
    schemaVersion: 2,
    order: readOrder(item['order']),
    mutation: readMutation(item['mutation']),
  };
}

function eventId(record: DynamoDBRecord, eventType: DomainEventType): string {
  const streamArn = requiredString(record.eventSourceARN, 'eventSourceARN');
  const recordId = requiredString(record.eventID, 'eventID');
  const input = JSON.stringify([streamArn, recordId, eventType, 1]);
  return `evt_${createHash('sha256').update(input).digest('base64url')}`;
}

function baseEnvelope(record: DynamoDBRecord, item: StreamOrderItem, eventType: DomainEventType) {
  return {
    eventId: eventId(record, eventType),
    eventType,
    schemaVersion: 2 as const,
    aggregateType: 'ORDER' as const,
    aggregateId: item.order.orderId,
    aggregateVersion: item.order.version,
    occurredAt: item.order.updatedAt,
    correlationId: item.mutation.correlationId,
    causationId: item.mutation.causationId,
  };
}

function deliveryProviderOrderId(order: Order): string {
  return requiredString(order.provider.deliveryProviderOrderId, 'provider.deliveryProviderOrderId');
}

function acceptedAt(order: Order): string {
  return requiredString(order.provider.acceptedAt, 'provider.acceptedAt');
}

function failure(order: Order, expectedStage: FailureDetails['stage']): FailureDetails {
  if (order.failure === undefined || order.failure.stage !== expectedStage) {
    throw new Error(`Stream order requires ${expectedStage} failure details.`);
  }
  return order.failure;
}

function optionalReason(mutation: OrderMutation): { readonly reason?: string } {
  return mutation.kind === 'ORDER_STATUS_CHANGED' && mutation.reason !== undefined
    ? { reason: mutation.reason }
    : {};
}

function statusChangedEvent(record: DynamoDBRecord, item: StreamOrderItem): DomainEvent {
  if (item.mutation.kind !== 'ORDER_STATUS_CHANGED') {
    throw new Error('A changed order requires status-change mutation metadata.');
  }

  const order = item.order;
  const previousStatus = item.mutation.previousStatus;
  const reason = optionalReason(item.mutation);
  switch (order.status) {
    case 'AWAITING_PAYMENT':
      throw new Error('An order cannot transition back to awaiting payment.');
    case 'PENDING_SUBMISSION':
      if (previousStatus === 'AWAITING_PAYMENT') {
        if (order.payment?.status !== 'SUCCEEDED') {
          throw new Error('A ready-for-submission order requires successful payment.');
        }
        return {
          ...baseEnvelope(record, item, 'order.ready_for_submission'),
          eventType: 'order.ready_for_submission',
          payload: {
            merchantId: order.merchantId,
            previousStatus,
            status: 'PENDING_SUBMISSION',
            deliveryProviderCode: 'mock-delivery',
            deliveryProviderSubmissionKey: order.provider.deliveryProviderSubmissionKey,
          },
        };
      }
      if (previousStatus !== 'SUBMISSION_FAILED' || item.mutation.reason === undefined) {
        throw new Error('Submission retry metadata is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.submission_retry_requested'),
        eventType: 'order.submission_retry_requested',
        payload: {
          merchantId: order.merchantId,
          previousStatus,
          status: 'PENDING_SUBMISSION',
          deliveryProviderCode: 'mock-delivery',
          deliveryProviderSubmissionKey: order.provider.deliveryProviderSubmissionKey,
          reason: item.mutation.reason,
        },
      };
    case 'SUBMITTED':
      if (previousStatus !== 'PENDING_SUBMISSION') {
        throw new Error('Submitted order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.submitted'),
        eventType: 'order.submitted',
        payload: {
          merchantId: order.merchantId,
          status: 'SUBMITTED',
          deliveryProviderCode: 'mock-delivery',
          deliveryProviderOrderId: deliveryProviderOrderId(order),
          acceptedAt: acceptedAt(order),
          ...reason,
        },
      };
    case 'SUBMISSION_FAILED':
      if (previousStatus !== 'PENDING_SUBMISSION') {
        throw new Error('Submission-failed order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.submission_failed'),
        eventType: 'order.submission_failed',
        payload: {
          merchantId: order.merchantId,
          status: 'SUBMISSION_FAILED',
          failure: failure(order, 'SUBMISSION') as FailureDetails & {
            readonly stage: 'SUBMISSION';
          },
        },
      };
    case 'CANCELLED':
      if (
        previousStatus !== 'PENDING_SUBMISSION' &&
        previousStatus !== 'SUBMISSION_FAILED' &&
        previousStatus !== 'SUBMITTED'
      ) {
        throw new Error('Cancelled order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.cancelled'),
        eventType: 'order.cancelled',
        payload: {
          merchantId: order.merchantId,
          previousStatus,
          status: 'CANCELLED',
          ...reason,
        },
      };
    case 'PICKED_UP':
      if (previousStatus !== 'SUBMITTED') {
        throw new Error('Picked-up order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.picked_up'),
        eventType: 'order.picked_up',
        payload: {
          merchantId: order.merchantId,
          previousStatus,
          status: 'PICKED_UP',
          deliveryProviderCode: 'mock-delivery',
          deliveryProviderOrderId: deliveryProviderOrderId(order),
          ...reason,
        },
      };
    case 'DELIVERED':
      if (previousStatus !== 'SUBMITTED' && previousStatus !== 'PICKED_UP') {
        throw new Error('Delivered order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.delivered'),
        eventType: 'order.delivered',
        payload: {
          merchantId: order.merchantId,
          previousStatus,
          status: 'DELIVERED',
          deliveryProviderCode: 'mock-delivery',
          deliveryProviderOrderId: deliveryProviderOrderId(order),
          ...reason,
        },
      };
    case 'DELIVERY_FAILED':
      if (previousStatus !== 'SUBMITTED' && previousStatus !== 'PICKED_UP') {
        throw new Error('Delivery-failed order previous status is invalid.');
      }
      return {
        ...baseEnvelope(record, item, 'order.delivery_failed'),
        eventType: 'order.delivery_failed',
        payload: {
          merchantId: order.merchantId,
          previousStatus,
          status: 'DELIVERY_FAILED',
          deliveryProviderCode: 'mock-delivery',
          deliveryProviderOrderId: deliveryProviderOrderId(order),
          failure: failure(order, 'DELIVERY') as FailureDetails & { readonly stage: 'DELIVERY' },
          ...reason,
        },
      };
  }
}

export function domainEventFromOrderStreamRecord(record: DynamoDBRecord): DomainEvent | undefined {
  const item = readStreamItem(record);
  if (item === undefined) {
    return undefined;
  }

  if (item.mutation.kind === 'ORDER_CREATED') {
    if (
      record.eventName !== 'INSERT' ||
      (item.order.status !== 'AWAITING_PAYMENT' && item.order.status !== 'PENDING_SUBMISSION')
    ) {
      throw new Error('Created-order stream metadata is inconsistent.');
    }
    if (item.order.status === 'AWAITING_PAYMENT' && item.order.payment?.status !== 'NOT_STARTED') {
      throw new Error('An awaiting-payment order requires an initial payment value.');
    }
    return {
      ...baseEnvelope(record, item, 'order.created'),
      eventType: 'order.created',
      payload: {
        merchantId: item.order.merchantId,
        status: item.order.status,
        deliveryProviderCode: 'mock-delivery',
        deliveryProviderSubmissionKey: item.order.provider.deliveryProviderSubmissionKey,
      },
    };
  }

  if (item.mutation.kind === 'ORDER_PAYMENT_CHANGED') {
    if (record.eventName !== 'MODIFY' || item.order.payment === undefined) {
      throw new Error('Payment-change stream metadata is inconsistent.');
    }
    return undefined;
  }

  if (record.eventName !== 'MODIFY') {
    throw new Error('Status-change stream metadata is inconsistent.');
  }
  return statusChangedEvent(record, item);
}
