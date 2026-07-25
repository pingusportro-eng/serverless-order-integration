import { readFile } from 'node:fs/promises';

import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DomainEvent } from '../../src/events/domain-event.js';
import {
  createStreamPublisherHandler,
  type DomainEventPublisher,
} from '../../src/lambda/stream-publisher.js';

const fixturesUrl = new URL('../fixtures/dynamodb-stream/', import.meta.url);
const schemaUrl = new URL('../../docs/specifications/domain-event.schema.json', import.meta.url);

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

describe('DynamoDB stream publisher', () => {
  let validateEvent: ValidateFunction;

  beforeAll(async () => {
    const schema = await readJson<AnySchema>(schemaUrl);
    validateEvent = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  });

  function capturingPublisher(events: DomainEvent[]): DomainEventPublisher {
    return {
      publish(event): Promise<void> {
        events.push(structuredClone(event));
        return Promise.resolve();
      },
    };
  }

  it('publishes a contract-valid created event and ignores transaction support items', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('order-created.json', fixturesUrl),
    );
    const published: DomainEvent[] = [];
    const handler = createStreamPublisherHandler({ publisher: capturingPublisher(published) });

    await expect(handler(streamEvent)).resolves.toEqual({ batchItemFailures: [] });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      eventType: 'order.created',
      aggregateId: 'ord_01JABCDEF0123456789',
      aggregateVersion: 1,
      correlationId: 'corr_01JABCDEF0123456789',
      causationId: 'request_01JABCDEF0123456789',
      payload: {
        merchantId: 'mrc_demo',
        status: 'PENDING_SUBMISSION',
        providerCode: 'mock-delivery',
        submissionKey: 'submission_01JABCDEF0123456789',
      },
    });
    expect(published[0]?.eventId).toMatch(/^evt_[A-Za-z0-9_-]{43}$/);
    expect(validateEvent(published[0]), JSON.stringify(validateEvent.errors)).toBe(true);
  });

  it('derives the same event ID when Lambda retries a stream record', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('order-created.json', fixturesUrl),
    );
    const published: DomainEvent[] = [];
    const handler = createStreamPublisherHandler({ publisher: capturingPublisher(published) });

    await handler(streamEvent);
    await handler(streamEvent);

    expect(published[0]?.eventId).toBe(published[1]?.eventId);
  });

  it('publishes a submitted event with preserved transition context', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('order-submitted.json', fixturesUrl),
    );
    const published: DomainEvent[] = [];
    const handler = createStreamPublisherHandler({ publisher: capturingPublisher(published) });

    await expect(handler(streamEvent)).resolves.toEqual({ batchItemFailures: [] });
    expect(published[0]).toMatchObject({
      eventType: 'order.submitted',
      aggregateVersion: 2,
      occurredAt: '2026-07-23T07:00:30.000Z',
      payload: {
        status: 'SUBMITTED',
        providerOrderId: 'delivery-789',
        acceptedAt: '2026-07-23T07:00:30.000Z',
        reason: 'Provider acceptance was reconciled by an operator.',
      },
    });
    expect(validateEvent(published[0]), JSON.stringify(validateEvent.errors)).toBe(true);
  });

  it('reports a malformed order by DynamoDB sequence number', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('malformed-order.json', fixturesUrl),
    );
    const publish = vi.fn<DomainEventPublisher['publish']>();
    const logLines: string[] = [];
    const handler = createStreamPublisherHandler({
      publisher: { publish },
      logSink: (line) => {
        logLines.push(line);
      },
    });

    await expect(handler(streamEvent)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: '100000000000000000004' }],
    });
    expect(publish).not.toHaveBeenCalled();
    expect(logLines.map((line): unknown => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        event: 'stream.record.failed',
        requestId: '100000000000000000004',
        operation: 'parseOrderStreamRecord',
        exceptionName: 'Error',
      }),
    ]);
  });

  it('reports an SNS publication failure and stops at the failed record', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('order-created.json', fixturesUrl),
    );
    const publish = vi
      .fn<DomainEventPublisher['publish']>()
      .mockRejectedValue(new Error('SNS down'));
    const logLines: string[] = [];
    const handler = createStreamPublisherHandler({
      publisher: { publish },
      logSink: (line) => {
        logLines.push(line);
      },
    });

    await expect(handler(streamEvent)).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: '100000000000000000001' }],
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const publishedEvent = publish.mock.calls[0]?.[0];
    expect(publishedEvent).toBeDefined();
    expect(logLines.map((line): unknown => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        event: 'stream.record.failed',
        requestId: '100000000000000000001',
        operation: 'publishDomainEvent',
        eventId: publishedEvent?.eventId,
        orderId: 'ord_01JABCDEF0123456789',
        exceptionName: 'Error',
      }),
    ]);
    expect(logLines.join('\n')).not.toContain('SNS down');
  });

  it('fails the whole invocation when a malformed record has no retry identifier', async () => {
    const streamEvent = await readJson<DynamoDBStreamEvent>(
      new URL('malformed-order.json', fixturesUrl),
    );
    delete streamEvent.Records[0]?.dynamodb?.SequenceNumber;
    const handler = createStreamPublisherHandler({ publisher: capturingPublisher([]) });

    await expect(handler(streamEvent)).rejects.toThrow('missing its sequence number');
  });
});
