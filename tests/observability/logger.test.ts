import { describe, expect, it, vi } from 'vitest';

import { createLogger, type SafeLogFields } from '../../src/index.js';

describe('structured logger', () => {
  it('writes one JSON record containing only allow-listed context', () => {
    const lines: string[] = [];
    const fields = {
      operation: 'createOrder',
      orderId: 'ord_123',
      statusCode: 201,
      exceptionName: 'ValidationException',
      authorization: 'Bearer secret-token',
      requestBody: { customer: 'must-not-be-logged' },
    } as SafeLogFields & Record<string, unknown>;
    const logger = createLogger(
      { requestId: 'request-123', correlationId: 'correlation-123' },
      {
        now: () => new Date('2026-07-21T12:00:00.000Z'),
        sink: (line) => {
          lines.push(line);
        },
      },
    );

    logger.write('info', 'order.created', fields);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      timestamp: '2026-07-21T12:00:00.000Z',
      level: 'info',
      event: 'order.created',
      requestId: 'request-123',
      correlationId: 'correlation-123',
      operation: 'createOrder',
      orderId: 'ord_123',
      statusCode: 201,
      exceptionName: 'ValidationException',
    });
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('must-not-be-logged');
  });

  it('rejects free-form event messages that could contain request data', () => {
    const logger = createLogger(
      { requestId: 'request-456' },
      {
        now: () => new Date('2026-07-21T12:00:00.000Z'),
        sink: () => {
          // This test only exercises validation before a log is written.
        },
      },
    );

    expect(() => {
      logger.write('error', 'Order failed: secret value');
    }).toThrow(TypeError);
  });

  it('writes JSON to the default console sink', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {
      // Prevent test output while exercising the production sink.
    });
    const logger = createLogger({ requestId: 'request-789' });

    logger.write('debug', 'health.checked');

    expect(consoleLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toMatchObject({
      level: 'debug',
      event: 'health.checked',
      requestId: 'request-789',
    });
  });
});
