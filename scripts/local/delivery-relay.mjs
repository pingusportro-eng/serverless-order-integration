import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';
const DELIVERY_EVENT_TYPES = new Set([
  'order.ready_for_submission',
  'order.submission_retry_requested',
]);
const MAXIMUM_RECEIVES = 3;
const RETRY_DELAY_MS = 1_000;
const POLL_DELAY_MS = 250;

function fail(message) {
  throw new Error(`Local delivery relay: ${message}`);
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function positiveIntegerEnvironment(name) {
  const value = Number(requireEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function object(value, description) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${description} must be an object`);
  }
  return value;
}

function string(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${description} must be a non-empty string`);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('order version must be a positive integer');
  }
  return value;
}

function orderIdentity(item) {
  if (item['entityType'] !== 'ORDER') {
    fail('only ORDER items can become local stream records');
  }
  const order = object(item['order'], 'stored order');
  return {
    orderId: string(order['orderId'], 'order ID'),
    version: positiveVersion(order['version']),
  };
}

export function deliveryEventIsSubscribed(eventType) {
  return DELIVERY_EVENT_TYPES.has(eventType);
}

export function localStreamRecord(item) {
  const identity = orderIdentity(item);
  const mutation = object(item['mutation'], 'stored mutation');
  const mutationKind = string(mutation['kind'], 'mutation kind');
  const recordId = createHash('sha256')
    .update(`${identity.orderId}:${String(identity.version)}:${mutationKind}`)
    .digest('base64url');

  return {
    eventID: `local-${recordId}`,
    eventName: mutationKind === 'ORDER_CREATED' ? 'INSERT' : 'MODIFY',
    eventSource: 'aws:dynamodb',
    eventSourceARN: 'arn:aws:dynamodb:local:000000000000:table/local/stream/local',
    awsRegion: 'local',
    dynamodb: {
      ApproximateCreationDateTime: Date.now() / 1_000,
      Keys: marshall({ pk: item['pk'], sk: item['sk'] }),
      NewImage: marshall(item, { removeUndefinedValues: true }),
      SequenceNumber: `${identity.orderId}:${String(identity.version)}`,
      SizeBytes: Buffer.byteLength(JSON.stringify(item)),
      StreamViewType: 'NEW_IMAGE',
    },
  };
}

async function scanOrderItems(client, tableName) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#entityType = :order',
        ExpressionAttributeNames: { '#entityType': 'entityType' },
        ExpressionAttributeValues: { ':order': 'ORDER' },
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

function sqsRecord(message) {
  return {
    messageId: message.messageId,
    receiptHandle: `local-receipt-${message.messageId}-${String(message.receiveCount)}`,
    body: JSON.stringify(message.event),
    attributes: {
      ApproximateReceiveCount: String(message.receiveCount),
      SentTimestamp: String(message.sentAt),
      SenderId: 'local-sns-subscription',
      ApproximateFirstReceiveTimestamp: String(message.sentAt),
    },
    messageAttributes: {},
    md5OfBody: createHash('md5').update(JSON.stringify(message.event)).digest('hex'),
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:local:000000000000:local-delivery-queue',
    awsRegion: 'local',
  };
}

async function runLocalDeliveryRelay() {
  const tableName = requireEnvironment('TABLE_NAME');
  const endpoint = requireEnvironment('DYNAMODB_ENDPOINT');
  const vendorBaseUrl = requireEnvironment('VENDOR_BASE_URL');
  const vendorAuthToken = requireEnvironment('VENDOR_AUTH_TOKEN');
  const vendorTimeoutMs = positiveIntegerEnvironment('VENDOR_TIMEOUT_MS');

  const [
    { processDeliveryEvent },
    { createDeliveryWorkerHandler },
    { createStreamPublisherHandler },
    { DynamoDbOrderRepository },
    { createDeliveryVendorClient },
  ] = await Promise.all([
    import('../../dist/application/process-delivery-event.js'),
    import('../../dist/lambda/delivery-worker.js'),
    import('../../dist/lambda/stream-publisher.js'),
    import('../../dist/infrastructure/dynamodb/dynamodb-order-repository.js'),
    import('../../dist/integrations/delivery-vendor-client.js'),
  ]);

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: 'eu-central-1',
      endpoint,
      credentials: {
        accessKeyId: LOCAL_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_SECRET_ACCESS_KEY,
      },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const repository = new DynamoDbOrderRepository(client, tableName);
  const vendorClient = createDeliveryVendorClient({
    baseUrl: vendorBaseUrl,
    authToken: vendorAuthToken,
    timeoutMs: vendorTimeoutMs,
  });
  const messages = [];
  const seenVersions = new Map();
  let stopping = false;

  const logSink = (entry) => {
    process.stdout.write(`${entry}\n`);
  };
  const worker = createDeliveryWorkerHandler({
    logSink,
    processor: {
      async process(event) {
        const result = await processDeliveryEvent({ repository, vendorClient }, event);
        return { outcome: result.outcome, orderVersion: result.order.version };
      },
    },
  });
  const publisher = createStreamPublisherHandler({
    logSink,
    publisher: {
      async publish(event) {
        if (!deliveryEventIsSubscribed(event.eventType)) {
          process.stdout.write(
            `[SNS filter] ignored eventType=${event.eventType} orderId=${event.aggregateId}\n`,
          );
          return;
        }
        messages.push({
          event,
          messageId: `local-${event.eventId}`,
          receiveCount: 1,
          sentAt: Date.now(),
          visibleAt: Date.now(),
        });
        process.stdout.write(
          `[SNS -> SQS] eventType=${event.eventType} orderId=${event.aggregateId}\n`,
        );
      },
    },
  });

  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    for (const item of await scanOrderItems(client, tableName)) {
      const identity = orderIdentity(item);
      seenVersions.set(identity.orderId, identity.version);
    }
    process.stdout.write(
      `Local delivery relay ready; baseline contains ${String(seenVersions.size)} existing orders.\n`,
    );

    while (!stopping) {
      const items = await scanOrderItems(client, tableName);
      items.sort((left, right) => {
        const leftOrder = object(left['order'], 'stored order');
        const rightOrder = object(right['order'], 'stored order');
        return String(leftOrder['updatedAt']).localeCompare(String(rightOrder['updatedAt']));
      });
      for (const item of items) {
        const identity = orderIdentity(item);
        const seenVersion = seenVersions.get(identity.orderId);
        if (seenVersion !== undefined && identity.version <= seenVersion) {
          continue;
        }
        const record = localStreamRecord(item);
        const response = await publisher({ Records: [record] });
        if (response.batchItemFailures.length === 0) {
          seenVersions.set(identity.orderId, identity.version);
        }
      }

      const now = Date.now();
      for (let index = 0; index < messages.length;) {
        const message = messages[index];
        if (message.visibleAt > now) {
          index += 1;
          continue;
        }
        const response = await worker({ Records: [sqsRecord(message)] });
        if (response.batchItemFailures.length === 0) {
          messages.splice(index, 1);
          continue;
        }
        if (message.receiveCount >= MAXIMUM_RECEIVES) {
          process.stdout.write(
            `[SQS -> local DLQ] eventType=${message.event.eventType} orderId=${message.event.aggregateId} receives=${String(message.receiveCount)}\n`,
          );
          messages.splice(index, 1);
          continue;
        }
        message.receiveCount += 1;
        message.visibleAt = Date.now() + RETRY_DELAY_MS;
        process.stdout.write(
          `[SQS retry] eventType=${message.event.eventType} orderId=${message.event.aggregateId} nextReceive=${String(message.receiveCount)}\n`,
        );
        index += 1;
      }
      await setTimeout(POLL_DELAY_MS);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    client.destroy();
    process.stdout.write('Local delivery relay stopped.\n');
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runLocalDeliveryRelay().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Local relay failed.'}\n`);
    process.exitCode = 1;
  });
}
