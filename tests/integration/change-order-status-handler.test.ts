import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import { handleChangeOrderStatus } from '../../src/http/change-order-status-handler.js';
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
const now = () => new Date('2026-07-22T10:00:00.000Z');

describe('PATCH /orders/{orderId}/status with DynamoDB Local', () => {
  it('allows exactly one concurrent change for an expected version', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: `concurrent-${order.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: `concurrent-fingerprint-${order.orderId}`,
    });
    const request = {
      merchantId: order.merchantId,
      orderId: order.orderId,
      headers: { 'If-Match': '"1"' },
    };

    const responses = await Promise.all([
      handleChangeOrderStatus(
        { repository, now },
        {
          ...request,
          requestId: 'request-concurrent-submitted',
          body: {
            targetStatus: 'SUBMITTED',
            reason: 'Provider acceptance was reconciled.',
            deliveryProviderOrderId: `provider-${order.orderId}`,
          },
        },
      ),
      handleChangeOrderStatus(
        { repository, now },
        {
          ...request,
          requestId: 'request-concurrent-cancelled',
          body: { targetStatus: 'CANCELLED', reason: 'Operator cancellation.' },
        },
      ),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 412]);
    const storedOrder = await repository.get(order.merchantId, order.orderId);
    expect(storedOrder).toMatchObject({ version: 2 });
    expect(['SUBMITTED', 'CANCELLED']).toContain(storedOrder?.status);
  });

  it('leaves a terminal order unchanged after an invalid transition', async () => {
    const order = createOrderFixture({
      status: 'DELIVERED',
      provider: {
        ...createOrderFixture().provider,
        deliveryProviderOrderId: 'provider-terminal-integration',
        acceptedAt: '2026-07-22T09:00:00.000Z',
      },
      version: 4,
    });
    await repository.create({
      order,
      idempotencyKey: `terminal-${order.orderId}`,
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: `terminal-fingerprint-${order.orderId}`,
    });

    const response = await handleChangeOrderStatus(
      { repository, now },
      {
        merchantId: order.merchantId,
        orderId: order.orderId,
        requestId: 'request-terminal-integration',
        headers: { 'If-Match': '"4"' },
        body: { targetStatus: 'CANCELLED', reason: 'Late cancellation.' },
      },
    );

    expect(response).toMatchObject({
      statusCode: 409,
      body: { code: 'INVALID_STATUS_TRANSITION' },
    });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
  });
});

afterAll(() => {
  client.destroy();
});
