import { afterEach, describe, expect, it, vi } from 'vitest';

import { asOrderId } from '../../src/domain/order.js';
import {
  createDeliveryVendorClient,
  VendorSubmissionError,
} from '../../src/integrations/delivery-vendor-client.js';
import {
  startMockDeliveryVendor,
  type MockVendorScenario,
  type RunningMockDeliveryVendor,
} from '../../src/mock-vendor/mock-delivery-vendor.js';
import { createOrderFixture } from '../fixtures/order.js';

const AUTH_TOKEN = 'vendor-client-test-token';

describe('delivery vendor client', () => {
  let vendor: RunningMockDeliveryVendor | undefined;

  afterEach(async () => {
    await vendor?.close();
    vendor = undefined;
    vi.unstubAllGlobals();
  });

  async function startClient(
    scenario: MockVendorScenario,
    options: { readonly authToken?: string; readonly timeoutMs?: number } = {},
  ) {
    vendor = await startMockDeliveryVendor({
      authToken: AUTH_TOKEN,
      defaultScenario: scenario,
      timeoutDelayMs: 100,
      now: () => '2026-07-22T12:00:00.000Z',
    });
    return createDeliveryVendorClient({
      baseUrl: vendor.baseUrl,
      authToken: options.authToken ?? AUTH_TOKEN,
      timeoutMs: options.timeoutMs ?? 500,
    });
  }

  function clientForStubbedFetch() {
    return createDeliveryVendorClient({
      baseUrl: 'https://vendor.example.test',
      authToken: AUTH_TOKEN,
      timeoutMs: 500,
    });
  }

  function stubFetchResponse(response: Response): void {
    vi.stubGlobal('fetch', (): Promise<Response> => Promise.resolve(response));
  }

  async function captureVendorError(promise: Promise<unknown>): Promise<VendorSubmissionError> {
    try {
      await promise;
      throw new Error('Expected the vendor call to fail.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(VendorSubmissionError);
      return error as VendorSubmissionError;
    }
  }

  it('submits an order through the provider HTTP contract', async () => {
    const client = await startClient('success');
    const order = createOrderFixture();
    const acceptance = await client.submitDelivery(order, 'correlation-123');

    expect(acceptance).toMatchObject({
      status: 'ACCEPTED',
      acceptedAt: '2026-07-22T12:00:00.000Z',
    });
    expect(acceptance.deliveryProviderOrderId).toMatch(/^delivery_/);
  });

  it('maps a timeout to a retryable safe error', async () => {
    const client = await startClient('timeout', { timeoutMs: 20 });

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-timeout'),
    ).rejects.toEqual(
      new VendorSubmissionError({
        code: 'TIMEOUT',
        retryable: true,
        message: 'Delivery provider request timed out.',
      }),
    );
  });

  it('maps an unreachable provider to a retryable network error', async () => {
    const client = await startClient('success');
    await vendor?.close();
    vendor = undefined;

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-network'),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: 'Delivery provider could not be reached.',
    });
  });

  it('maps rate limiting and its bounded retry hint', async () => {
    const client = await startClient('rate-limit');

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-rate-limit'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 1000,
      message: 'Delivery provider rate limit exceeded.',
    });
  });

  it.each([
    { retryAfter: 'invalid', expectedRetryAfterMs: undefined },
    { retryAfter: '120', expectedRetryAfterMs: 60_000 },
  ])(
    'validates and caps Retry-After value $retryAfter',
    async ({ retryAfter, expectedRetryAfterMs }) => {
      stubFetchResponse(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': retryAfter },
        }),
      );
      const error = await captureVendorError(
        clientForStubbedFetch().submitDelivery(createOrderFixture(), 'correlation-rate-limit-edge'),
      );

      expect(error).toMatchObject({
        code: 'RATE_LIMITED',
        retryable: true,
        statusCode: 429,
      });
      expect(error.retryAfterMs).toBe(expectedRetryAfterMs);
    },
  );

  it('maps a provider server error without exposing its response', async () => {
    const client = await startClient('server-error');

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-server-error'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      statusCode: 500,
      message: 'Delivery provider is unavailable.',
    });
  });

  it('treats an unusable success response as an uncertain retryable outcome', async () => {
    const client = await startClient('malformed-response');

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-malformed'),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: true,
      statusCode: 201,
      message: 'Delivery provider returned an unusable response.',
    });
  });

  it('rejects a valid JSON success body with an invalid contract shape', async () => {
    stubFetchResponse(
      Response.json(
        {
          deliveryProviderOrderId: '',
          status: 'ACCEPTED',
          acceptedAt: 'not-a-date',
        },
        { status: 201 },
      ),
    );

    await expect(
      clientForStubbedFetch().submitDelivery(createOrderFixture(), 'correlation-invalid-shape'),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: true,
      statusCode: 201,
      message: 'Delivery provider returned an unusable response.',
    });
  });

  it('rejects an unexpected provider success status', async () => {
    stubFetchResponse(new Response(null, { status: 204 }));

    await expect(
      clientForStubbedFetch().submitDelivery(createOrderFixture(), 'correlation-unexpected-status'),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: true,
      statusCode: 204,
      message: 'Delivery provider returned an unexpected response.',
    });
  });

  it('treats authentication failure as non-retryable configuration work', async () => {
    const client = await startClient('success', { authToken: 'incorrect-token' });

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-auth'),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      statusCode: 401,
      message: 'Delivery provider authentication failed.',
    });
  });

  it('maps a provider 403 to the same terminal authentication failure', async () => {
    stubFetchResponse(new Response('forbidden', { status: 403 }));

    await expect(
      clientForStubbedFetch().submitDelivery(createOrderFixture(), 'correlation-forbidden'),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      statusCode: 403,
      message: 'Delivery provider authentication failed.',
    });
  });

  it('treats conflicting idempotency data as non-retryable', async () => {
    const client = await startClient('success');
    const firstOrder = createOrderFixture();
    const conflictingOrder = createOrderFixture({
      orderId: asOrderId('ord_conflicting'),
      provider: firstOrder.provider,
    });

    await client.submitDelivery(firstOrder, 'correlation-first');

    await expect(
      client.submitDelivery(conflictingOrder, 'correlation-conflict'),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
      statusCode: 409,
    });
  });

  it('maps another provider 4xx response to a terminal request rejection', async () => {
    const client = await startClient('request-rejected');

    await expect(
      client.submitDelivery(createOrderFixture(), 'correlation-request-rejected'),
    ).rejects.toMatchObject({
      code: 'REQUEST_REJECTED',
      retryable: false,
      statusCode: 422,
      message: 'Delivery provider rejected the submission.',
    });
  });
});
