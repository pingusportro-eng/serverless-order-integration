import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, expect, it } from 'vitest';

import { applyOrderStatusChange } from '../../src/domain/order-status-transition.js';
import { DynamoDbOrderRepository } from '../../src/infrastructure/dynamodb/dynamodb-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';
import { orderRepositoryContract } from '../repositories/order-repository.contract.js';

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

orderRepositoryContract('DynamoDbOrderRepository', () => repository);

it('stores stream mutation metadata atomically with each order version', async () => {
  const order = createOrderFixture();
  const createdMutation = {
    kind: 'ORDER_CREATED',
    correlationId: 'corr_persistence_123',
    causationId: 'request_persistence_123',
  } as const;
  await repository.create({
    order,
    idempotencyKey: `idempotency-${order.orderId}`,
    requestFingerprint: `fingerprint-${order.orderId}`,
    mutation: createdMutation,
  });

  const key = { pk: `MERCHANT#${order.merchantId}`, sk: `ORDER#${order.orderId}` };
  const createdItem = await client.send(
    new GetCommand({
      TableName: 'serverless-order-integration-local',
      Key: key,
      ConsistentRead: true,
    }),
  );
  expect(createdItem.Item?.['mutation']).toEqual(createdMutation);

  const cancelled = applyOrderStatusChange(
    order,
    { targetStatus: 'CANCELLED' },
    '2026-07-23T09:00:00.000Z',
  );
  const changedMutation = {
    kind: 'ORDER_STATUS_CHANGED',
    previousStatus: 'PENDING_SUBMISSION',
    correlationId: 'corr_persistence_123',
    causationId: 'request_persistence_456',
    reason: 'Operator cancelled the synthetic order.',
  } as const;
  await repository.saveStatusChange(cancelled, 1, changedMutation);

  const changedItem = await client.send(
    new GetCommand({
      TableName: 'serverless-order-integration-local',
      Key: key,
      ConsistentRead: true,
    }),
  );
  expect(changedItem.Item).toMatchObject({
    status: 'CANCELLED',
    version: 2,
    mutation: changedMutation,
  });
});

afterAll(() => {
  client.destroy();
});
