import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import { asMerchantId } from '../../src/domain/order.js';
import { handleGetOrder } from '../../src/http/get-order-handler.js';
import { DynamoDbOrderRepository } from '../../src/infrastructure/dynamodb/dynamodb-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: 'http://127.0.0.1:8000',
    region: 'eu-central-1',
    credentials: {
      accessKeyId: 'DUMMYIDEXAMPLE',
      secretAccessKey: 'DUMMYEXAMPLEKEY',
    },
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const repository = new DynamoDbOrderRepository(client, 'serverless-order-integration-local');

describe('GET /orders/{orderId} with DynamoDB Local', () => {
  it('returns a persisted order only within its merchant partition', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: `get-${order.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: `fingerprint-${order.orderId}`,
    });

    const found = await handleGetOrder(
      { repository },
      { merchantId: order.merchantId, requestId: 'request-found', orderId: order.orderId },
    );
    const hidden = await handleGetOrder(
      { repository },
      {
        merchantId: asMerchantId('mrc_anothermerchant'),
        requestId: 'request-hidden',
        orderId: order.orderId,
      },
    );

    expect(found.statusCode).toBe(200);
    expect(found.body).toMatchObject({ orderId: order.orderId, merchantId: order.merchantId });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });
});

afterAll(() => {
  client.destroy();
});
