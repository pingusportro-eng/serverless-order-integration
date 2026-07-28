import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/http/webhook-signature.js';
import {
  formatMockVendorActivity,
  parseMockVendorScenario,
  startMockDeliveryVendor,
  type MockDeliverySubmission,
  type MockVendorActivity,
  type MockVendorAttempt,
  type RunningMockDeliveryVendor,
} from '../../src/mock-vendor/mock-delivery-vendor.js';

const AUTH_TOKEN = 'contract-test-token';
const SUBMISSION: MockDeliverySubmission = {
  platformOrderId: 'ord_contract_123',
  merchantOrderReference: 'merchant-order-123',
  items: [{ itemReference: 'item-1', quantity: 2 }],
  pickup: {
    addressLine: '10 Example Street',
    city: 'Bucharest',
    postalCode: '010101',
    countryCode: 'RO',
  },
  dropoff: {
    addressLine: '20 Example Avenue',
    city: 'Bucharest',
    postalCode: '020202',
    countryCode: 'RO',
  },
};

describe('mock delivery vendor contract', () => {
  let vendor: RunningMockDeliveryVendor;
  let attempts: MockVendorAttempt[];
  let activities: MockVendorActivity[];

  beforeEach(async () => {
    attempts = [];
    activities = [];
    vendor = await startMockDeliveryVendor({
      authToken: AUTH_TOKEN,
      timeoutDelayMs: 100,
      now: () => '2026-07-22T10:30:00.000Z',
      onAttempt: (attempt) => attempts.push(attempt),
      onActivity: (activity) => activities.push(activity),
    });
  });

  afterEach(async () => {
    await vendor.close();
  });

  it('validates the executable server default scenario', () => {
    expect(parseMockVendorScenario('timeout')).toBe('timeout');
    expect(() => parseMockVendorScenario('not-a-scenario')).toThrow(
      'Mock vendor scenario must be one of',
    );
  });

  function submit(
    scenario = 'success',
    options: {
      readonly body?: MockDeliverySubmission;
      readonly contentType?: string;
      readonly idempotencyKey?: string;
      readonly omitIdempotencyKey?: boolean;
      readonly path?: string;
      readonly rawBody?: string;
      readonly signal?: AbortSignal;
      readonly token?: string;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token ?? AUTH_TOKEN}`,
      'Content-Type': options.contentType ?? 'application/json',
      'X-Correlation-Id': 'correlation-contract-123',
      'X-Mock-Vendor-Scenario': scenario,
    };
    if (!options.omitIdempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey ?? 'submission-contract-123';
    }

    return fetch(`${vendor.baseUrl}${options.path ?? '/deliveries'}`, {
      method: 'POST',
      headers,
      body: options.rawBody ?? JSON.stringify(options.body ?? SUBMISSION),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  it('accepts a delivery and propagates its correlation ID', async () => {
    const response = await submit();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('correlation-contract-123');
    expect(body).toMatchObject({
      status: 'ACCEPTED',
      acceptedAt: '2026-07-22T10:30:00.000Z',
    });
    expect((body as Record<string, unknown>)['providerOrderId']).toMatch(
      /^delivery_[A-Za-z0-9_-]{24}$/,
    );
    expect(activities).toEqual([
      {
        kind: 'delivery.request.received',
        timestamp: '2026-07-22T10:30:00.000Z',
        method: 'POST',
        path: '/deliveries',
        correlationId: 'correlation-contract-123',
      },
      {
        kind: 'delivery.response.sent',
        timestamp: '2026-07-22T10:30:00.000Z',
        statusCode: 201,
        correlationId: 'correlation-contract-123',
        platformOrderId: 'ord_contract_123',
        providerOrderId: (body as Record<string, string>)['providerOrderId'],
        scenario: 'success',
      },
    ]);
    const formatted = activities.map(formatMockVendorActivity).join('\n');
    expect(formatted).toContain('[VENDOR <- WORKER]');
    expect(formatted).toContain('[VENDOR -> WORKER]');
    expect(formatted).not.toContain(AUTH_TOKEN);
    expect(formatted).not.toContain(SUBMISSION.pickup.addressLine);
  });

  it('sends signed, correlated, ordered webhooks with bounded transient retry', async () => {
    await vendor.close();
    const received: Array<{
      readonly body: string;
      readonly correlationId?: string;
      readonly signature?: string;
      readonly timestamp?: string;
    }> = [];
    let pickupAttempts = 0;
    const webhookServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const timestamp = request.headers['x-webhook-timestamp'];
        const signature = request.headers['x-webhook-signature'];
        const correlationId = request.headers['x-correlation-id'];
        received.push({
          body,
          ...(typeof timestamp === 'string' ? { timestamp } : {}),
          ...(typeof signature === 'string' ? { signature } : {}),
          ...(typeof correlationId === 'string' ? { correlationId } : {}),
        });
        const event = JSON.parse(body) as { eventType: string };
        if (event.eventType === 'DELIVERY_PICKED_UP') {
          pickupAttempts += 1;
        }
        response.writeHead(
          event.eventType === 'DELIVERY_PICKED_UP' && pickupAttempts === 1 ? 404 : 204,
        );
        response.end();
      })();
    });
    await new Promise<void>((resolve, reject) => {
      webhookServer.once('error', reject);
      webhookServer.listen(0, '127.0.0.1', () => {
        webhookServer.off('error', reject);
        resolve();
      });
    });
    const address = webhookServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Webhook test server did not bind to TCP.');
    }
    const signingSecret = 'mock-webhook-contract-secret-0123456789';
    activities = [];
    vendor = await startMockDeliveryVendor({
      authToken: AUTH_TOKEN,
      onActivity: (activity) => activities.push(activity),
      webhook: {
        url: `http://127.0.0.1:${String(address.port)}/webhooks/vendor`,
        signingSecret,
        pickupDelayMs: 1,
        deliveredDelayMs: 1,
        retryDelayMs: 1,
        timeoutMs: 1_000,
        maximumAttempts: 3,
      },
    });

    try {
      const response = await submit();
      expect(response.status).toBe(201);
      await expect.poll(() => received.length, { timeout: 2_000 }).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        webhookServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        webhookServer.closeAllConnections();
      });
    }

    const parsed = received.map((entry) => JSON.parse(entry.body) as Record<string, string>);
    expect(parsed.map((event) => event['eventType'])).toEqual([
      'DELIVERY_PICKED_UP',
      'DELIVERY_PICKED_UP',
      'DELIVERY_DELIVERED',
    ]);
    expect(parsed[0]?.['eventId']).toBe(parsed[1]?.['eventId']);
    expect(parsed[0]?.['eventId']).not.toBe(parsed[2]?.['eventId']);
    for (const entry of received) {
      expect(entry.correlationId).toBe('correlation-contract-123');
      expect(entry.timestamp).toMatch(/^\d{10}$/);
      expect(entry.signature).toBe(signWebhook(signingSecret, entry.timestamp ?? '', entry.body));
    }
    expect(
      activities
        .filter((activity) => activity.kind === 'webhook.request.sent')
        .map((activity) => activity.eventType),
    ).toEqual(['DELIVERY_PICKED_UP', 'DELIVERY_PICKED_UP', 'DELIVERY_DELIVERED']);
    const formatted = activities.map(formatMockVendorActivity).join('\n');
    expect(formatted).toContain('[VENDOR -> API]');
    expect(formatted).toContain('[VENDOR <- API]');
    expect(formatted).not.toContain(signingSecret);
  });

  it('returns the original acceptance for an idempotent retry', async () => {
    const first = await submit();
    const second = await submit();

    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it('rejects conflicting reuse of an idempotency key', async () => {
    await submit();
    const response = await submit('success', {
      body: { ...SUBMISSION, platformOrderId: 'ord_different' },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('requires the configured bearer token', async () => {
    const response = await submit('success', { token: 'wrong-token' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a timeout scenario before the caller loses the response', async () => {
    await expect(submit('timeout', { signal: AbortSignal.timeout(20) })).rejects.toThrow();

    const retry = await submit();
    expect(retry.status).toBe(201);
    await expect(retry.json()).resolves.toMatchObject({
      status: 'ACCEPTED',
      acceptedAt: '2026-07-22T10:30:00.000Z',
    });
  });

  it('returns a retry hint when rate limited', async () => {
    const response = await submit('rate-limit');

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(attempts).toEqual([
      {
        timestamp: '2026-07-22T10:30:00.000Z',
        scenario: 'rate-limit',
        correlationId: 'correlation-contract-123',
        idempotencyKeyDigest: 'eccd9613057d50304233deb383c2ac5a57b3c99cec0d18ccf25abb4d69dd2f29',
        statusCode: 429,
      },
    ]);
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain(AUTH_TOKEN);
    expect(serialized).not.toContain('submission-contract-123');
    expect(serialized).not.toContain(SUBMISSION.pickup.addressLine);
    expect(serialized).not.toContain(SUBMISSION.dropoff.addressLine);
  });

  it('does not journal unauthenticated requests', async () => {
    const response = await submit('rate-limit', { token: 'wrong-token' });

    expect(response.status).toBe(401);
    expect(attempts).toEqual([]);
  });

  it('returns a provider error for the server-error scenario', async () => {
    const response = await submit('server-error');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('returns a terminal error for the request-rejected scenario', async () => {
    const response = await submit('request-rejected');

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_REJECTED' });
  });

  it('returns invalid JSON for the malformed-response scenario', async () => {
    const response = await submit('malformed-response');

    expect(response.status).toBe(201);
    await expect(response.json()).rejects.toThrow();
  });

  it('rejects an unknown scenario', async () => {
    const response = await submit('not-a-scenario');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_SCENARIO' });
  });

  it('rejects a request sent to the wrong route', async () => {
    const response = await submit('success', { path: '/unknown' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an unsupported content type', async () => {
    const response = await submit('success', { contentType: 'text/plain' });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('rejects a body larger than 64 KiB', async () => {
    const response = await submit('success', {
      rawBody: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
  });

  it('requires an idempotency key', async () => {
    const response = await submit('success', { omitIdempotencyKey: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('rejects malformed JSON', async () => {
    const response = await submit('success', { rawBody: '{"platformOrderId":' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  it('rejects a structurally invalid delivery', async () => {
    const response = await submit('success', { rawBody: '{}' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_DELIVERY' });
  });
});
