import { unmarshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it } from 'vitest';

import {
  deliveryEventIsSubscribed,
  localStreamRecord,
} from '../../scripts/local/delivery-relay.mjs';

function storedOrder(mutationKind: 'ORDER_CREATED' | 'ORDER_PAYMENT_CHANGED') {
  return {
    pk: 'MERCHANT#mrc_demo',
    sk: 'ORDER#ord_local_123',
    entityType: 'ORDER',
    schemaVersion: 2,
    order: {
      orderId: 'ord_local_123',
      version: mutationKind === 'ORDER_CREATED' ? 1 : 2,
      updatedAt: '2026-08-18T10:00:00.000Z',
    },
    mutation: {
      kind: mutationKind,
      correlationId: 'corr_local_123',
      causationId: 'request_local_123',
    },
  };
}

describe('local delivery relay', () => {
  it('uses the reviewed SNS delivery subscription filter', () => {
    expect(deliveryEventIsSubscribed('order.ready_for_submission')).toBe(true);
    expect(deliveryEventIsSubscribed('order.submission_retry_requested')).toBe(true);
    expect(deliveryEventIsSubscribed('order.created')).toBe(false);
    expect(deliveryEventIsSubscribed('order.submitted')).toBe(false);
  });

  it('constructs a deterministic INSERT stream record for a created order', () => {
    const item = storedOrder('ORDER_CREATED');
    const first = localStreamRecord(item);
    const second = localStreamRecord(item);

    expect(first['eventName']).toBe('INSERT');
    expect(first['eventID']).toBe(second['eventID']);
    const dynamodb = first['dynamodb'] as {
      readonly NewImage: Parameters<typeof unmarshall>[0];
      readonly SequenceNumber: string;
    };
    expect(dynamodb.SequenceNumber).toBe('ord_local_123:1');
    expect(unmarshall(dynamodb.NewImage)).toEqual(item);
  });

  it('constructs a MODIFY stream record for a payment mutation', () => {
    const record = localStreamRecord(storedOrder('ORDER_PAYMENT_CHANGED'));

    expect(record['eventName']).toBe('MODIFY');
    expect((record['dynamodb'] as { readonly SequenceNumber: string }).SequenceNumber).toBe(
      'ord_local_123:2',
    );
  });
});
