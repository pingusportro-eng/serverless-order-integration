import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll } from 'vitest';

import { DynamoDbOrderRepository } from '../../src/infrastructure/dynamodb/dynamodb-order-repository.js';
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

afterAll(() => {
  client.destroy();
});
