import { readFile } from 'node:fs/promises';

import type { APIGatewayProxyEventV2, DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { asMerchantId } from '../../src/domain/order.js';
import { createOrderCursorCodec } from '../../src/http/order-cursor.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createDeliveryWorkerHandler } from '../../src/lambda/delivery-worker.js';
import { createOrdersApiHandler } from '../../src/lambda/orders-api.js';
import { createStreamPublisherHandler } from '../../src/lambda/stream-publisher.js';

const CORRELATION_ID = 'corr_01JABCDEF0123456789';

function apiEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /orders',
    rawPath: '/orders',
    rawQueryString: '',
    headers: { 'x-correlation-id': CORRELATION_ID },
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: 'GET',
        path: '/orders',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'api-request-trace-123',
      routeKey: 'GET /orders',
      stage: '$default',
      time: '28/Jul/2026:12:00:00 +0000',
      timeEpoch: 1_775_000_000_000,
    },
    isBase64Encoded: false,
  };
}

async function fixture<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), 'utf8'),
  ) as T;
}

describe('successful trace continuity', () => {
  it('keeps one correlation ID queryable across API, publisher, and worker logs', async () => {
    const logLines: string[] = [];
    const logSink = (line: string): void => {
      logLines.push(line);
    };
    const ordersHandler = createOrdersApiHandler({
      repository: new InMemoryOrderRepository(),
      merchantId: asMerchantId('mrc_demo'),
      cursorCodec: createOrderCursorCodec('trace-test-cursor-signing-secret-0123456789'),
      requireAccessToken: false,
      requireOperatorGroup: false,
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      logSink,
    });
    const streamEvent = await fixture<DynamoDBStreamEvent>('dynamodb-stream/order-created.json');
    const sqsEvent = await fixture<SQSEvent>('sqs/delivery-worker-batch.json');
    const firstDeliveryRecord = sqsEvent.Records[0];
    if (firstDeliveryRecord === undefined) {
      throw new Error('The delivery fixture must contain one successful record.');
    }

    await ordersHandler(apiEvent());
    await createStreamPublisherHandler({
      publisher: { publish: () => Promise.resolve() },
      logSink,
    })(streamEvent);
    await createDeliveryWorkerHandler({
      processor: {
        process: () => Promise.resolve({ outcome: 'submitted', orderVersion: 2 }),
      },
      logSink,
    })({ Records: [firstDeliveryRecord] });

    const entries = logLines.map(
      (line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>,
    );
    expect(entries.map((entry) => entry['event'])).toEqual([
      'http.request.started',
      'http.request.completed',
      'stream.event.published',
      'delivery.message.processed',
    ]);
    expect(entries.every((entry) => entry['correlationId'] === CORRELATION_ID)).toBe(true);
    expect(entries[2]).toMatchObject({
      orderId: 'ord_01JABCDEF0123456789',
      aggregateVersion: 1,
      outcome: 'published',
    });
    expect(entries[2]?.['eventId']).toMatch(/^evt_[A-Za-z0-9_-]{43}$/);
    expect(entries[3]).toMatchObject({
      eventId: 'evt_01JABCDEF0123456789A',
      orderId: 'ord_01JABCDEF0123456789',
      aggregateVersion: 1,
      orderVersion: 2,
      outcome: 'submitted',
      attempt: 1,
    });
    expect(logLines.join('')).not.toContain('trace-test-cursor-signing-secret');
    expect(logLines.join('')).not.toContain('addressLine');
  });
});
