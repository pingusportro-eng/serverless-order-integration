import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { processDeliveryEvent } from '../application/process-delivery-event.js';
import type { DeliveryRequestedEvent } from '../events/delivery-requested-event.js';
import { parseDeliveryRequestedEvent } from '../events/delivery-requested-event.js';
import { DynamoDbOrderRepository } from '../infrastructure/dynamodb/dynamodb-order-repository.js';
import { createDeliveryVendorClient } from '../integrations/delivery-vendor-client.js';
import { createLogger, type LogSink } from '../observability/logger.js';

const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';

export interface DeliveryMessageProcessor {
  process(event: DeliveryRequestedEvent): Promise<void>;
}

export interface DeliveryWorkerDependencies {
  readonly processor: DeliveryMessageProcessor;
  readonly logSink?: LogSink;
}

export type DeliveryWorkerHandler = (event: SQSEvent) => Promise<SQSBatchResponse>;

function exceptionName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

function messageId(value: string): string {
  if (value.length === 0) {
    throw new Error('SQS record is missing its message ID.');
  }
  return value;
}

export function createDeliveryWorkerHandler(
  dependencies: DeliveryWorkerDependencies,
): DeliveryWorkerHandler {
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
      const itemIdentifier = messageId(record.messageId);
      let deliveryEvent: DeliveryRequestedEvent | undefined;
      try {
        deliveryEvent = parseDeliveryRequestedEvent(record.body);
        await dependencies.processor.process(deliveryEvent);
      } catch (error) {
        const logger = createLogger(
          { requestId: itemIdentifier },
          dependencies.logSink === undefined ? {} : { sink: dependencies.logSink },
        );
        logger.write('error', 'delivery.message.failed', {
          operation: 'processDeliveryEvent',
          ...(deliveryEvent === undefined
            ? {}
            : {
                eventId: deliveryEvent.eventId,
                orderId: deliveryEvent.aggregateId,
              }),
          exceptionName: exceptionName(error),
        });
        batchItemFailures.push({ itemIdentifier });
      }
    }

    return { batchItemFailures };
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The ${name} environment variable is required.`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requireEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${name} environment variable must be a positive integer.`);
  }
  return value;
}

function createDefaultHandler(): DeliveryWorkerHandler {
  const endpoint = process.env['DYNAMODB_ENDPOINT']?.trim();
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: process.env['AWS_REGION'] ?? 'eu-central-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: LOCAL_ACCESS_KEY_ID,
              secretAccessKey: LOCAL_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const processDependencies = {
    repository: new DynamoDbOrderRepository(client, requireEnvironment('TABLE_NAME')),
    vendorClient: createDeliveryVendorClient({
      baseUrl: requireEnvironment('VENDOR_BASE_URL'),
      authToken: requireEnvironment('VENDOR_AUTH_TOKEN'),
      timeoutMs: positiveIntegerEnvironment('VENDOR_TIMEOUT_MS'),
    }),
  };

  return createDeliveryWorkerHandler({
    processor: {
      async process(event): Promise<void> {
        await processDeliveryEvent(processDependencies, event);
      },
    },
  });
}

let defaultHandler: DeliveryWorkerHandler | undefined;

export const handler: DeliveryWorkerHandler = async (event) => {
  defaultHandler ??= createDefaultHandler();
  return defaultHandler(event);
};
