import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';

import { asMerchantId } from '../../src/domain/order.js';
import { handleCreateOrder } from '../../src/http/create-order-handler.js';
import { DynamoDbOrderRepository } from '../../src/infrastructure/dynamodb/dynamodb-order-repository.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';

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

function testContext() {
  const suffix = randomUUID().replaceAll('-', '');
  const generated = [`order${suffix}`, `submission${suffix}`];
  return {
    dependencies: {
      repository,
      now: () => new Date('2026-07-22T08:00:00.000Z'),
      generateId: () => generated.shift() ?? `extra${suffix}`,
    },
    request: {
      merchantId: asMerchantId(`mrc_${suffix}`),
      requestId: `request-${suffix}`,
      headers: { 'Idempotency-Key': `create-${suffix}` },
      body: createOrderRequestFixture({ merchantOrderId: `merchant-order-${suffix}` }),
    },
  };
}

describe('POST /orders with DynamoDB Local', () => {
  it('creates once and replays the persisted order', async () => {
    const context = testContext();

    const created = await handleCreateOrder(context.dependencies, context.request);
    const replayed = await handleCreateOrder(context.dependencies, context.request);

    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.body).toEqual(created.body);
  });

  it('persists idempotency and merchant order ID conflict protection', async () => {
    const context = testContext();
    await handleCreateOrder(context.dependencies, context.request);

    const idempotencyConflict = await handleCreateOrder(context.dependencies, {
      ...context.request,
      body: { ...context.request.body, merchantOrderId: 'changed-merchant-order' },
    });
    const merchantOrderIdConflict = await handleCreateOrder(context.dependencies, {
      ...context.request,
      headers: { 'Idempotency-Key': `different-${randomUUID().replaceAll('-', '')}` },
    });

    expect(idempotencyConflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(merchantOrderIdConflict.body).toMatchObject({ code: 'MERCHANT_ORDER_ID_CONFLICT' });
  });
});

afterAll(() => {
  client.destroy();
});
