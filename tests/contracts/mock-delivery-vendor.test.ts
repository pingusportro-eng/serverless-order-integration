import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseMockVendorScenario,
  startMockDeliveryVendor,
  type MockDeliverySubmission,
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

  beforeEach(async () => {
    vendor = await startMockDeliveryVendor({
      authToken: AUTH_TOKEN,
      timeoutDelayMs: 100,
      now: () => '2026-07-22T10:30:00.000Z',
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
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
      readonly token?: string;
    } = {},
  ): Promise<Response> {
    return fetch(`${vendor.baseUrl}/deliveries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token ?? AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey ?? 'submission-contract-123',
        'X-Correlation-Id': 'correlation-contract-123',
        'X-Mock-Vendor-Scenario': scenario,
      },
      body: JSON.stringify(options.body ?? SUBMISSION),
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
});
