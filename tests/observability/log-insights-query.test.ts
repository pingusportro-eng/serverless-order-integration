import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const fixturesUrl = new URL('../fixtures/logs/', import.meta.url);
const applicationJsonPattern = /(?<applicationJson>\{.*\})\s*$/u;

type LogRecord = Readonly<Record<string, unknown>>;

async function lines(name: string): Promise<readonly string[]> {
  return (await readFile(new URL(name, fixturesUrl), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0);
}

function applicationRecord(line: string): LogRecord | undefined {
  const applicationJson = applicationJsonPattern.exec(line)?.groups?.['applicationJson'];
  return applicationJson === undefined ? undefined : (JSON.parse(applicationJson) as LogRecord);
}

describe('CloudWatch Logs Insights record assumptions', () => {
  it('extracts only safe application JSON from Lambda text-format records', async () => {
    const records = (await lines('lambda-text.txt'))
      .map(applicationRecord)
      .filter((record) => record !== undefined);

    expect(records).toHaveLength(5);
    expect(records.map((record) => record['event'])).toEqual([
      'http.request.completed',
      'stream.event.published',
      'delivery.message.processed',
      'webhook.request.completed',
      'delivery.message.failed',
    ]);
    expect(records.every((record) => record['authorization'] === undefined)).toBe(true);
    expect(records.every((record) => record['requestBody'] === undefined)).toBe(true);
  });

  it('reconstructs successful correlation and cross-branch order views', async () => {
    const records = (await lines('lambda-text.txt'))
      .map(applicationRecord)
      .filter((record) => record !== undefined);
    const correlationJourney = records.filter(
      (record) => record['correlationId'] === 'corr_trace_12345678',
    );
    const orderJourney = records.filter((record) => record['orderId'] === 'ord_trace_12345678');

    expect(correlationJourney.map((record) => record['event'])).toEqual([
      'http.request.completed',
      'stream.event.published',
      'delivery.message.processed',
    ]);
    expect(orderJourney.map((record) => record['correlationId'])).toEqual([
      'corr_trace_12345678',
      'corr_trace_12345678',
      'corr_webhook_12345678',
    ]);
  });

  it('selects retry failures by safe exception class and attempt', async () => {
    const failures = (await lines('lambda-text.txt'))
      .map(applicationRecord)
      .filter(
        (record) =>
          record !== undefined &&
          record['level'] === 'error' &&
          record['event'] === 'delivery.message.failed',
      );

    expect(failures).toEqual([
      expect.objectContaining({
        requestId: 'sqs-message-456',
        orderId: 'ord_failure_12345678',
        attempt: 3,
        exceptionName: 'VendorSubmissionError',
      }),
    ]);
  });

  it('reads API access JSON without the Lambda prefix parser', async () => {
    const records = (await lines('api-access.jsonl')).map(
      (line): LogRecord => JSON.parse(line) as LogRecord,
    );
    const failures = records.filter((record) => String(record['status']).startsWith('4'));

    expect(failures).toEqual([
      {
        requestId: 'api-request-failure-456',
        routeKey: 'POST /webhooks/vendor',
        status: '401',
        responseLatency: '7',
        responseLength: '245',
        integrationStatus: '401',
      },
    ]);
  });
});
