import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { stripeEventFingerprint } from '../../src/integrations/stripe-event-fingerprint.js';
import {
  createStripeReconciliationEventSource,
  type StripeReconciliationSdkClient,
} from '../../src/integrations/stripe-reconciliation-event-source.js';

const ACCOUNT_ID = 'acct_reconciliation_adapter';

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_reconciliation_adapter',
    object: 'payment_intent',
    client_secret: 'pi_reconciliation_adapter_secret_must_not_escape',
    metadata: {
      application: 'serverless-order-integration',
      merchantId: 'mrc_reconciliation_adapter',
      orderId: 'ord_reconciliation_adapter',
    },
    ...overrides,
  };
}

function event(eventId: string, overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: eventId,
    object: 'event',
    api_version: '2026-08-01',
    created: 1_787_217_600,
    data: { object: paymentIntent() },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: 'payment_intent.succeeded',
    ...overrides,
  } as Stripe.Event;
}

function sdk(options: {
  readonly accountId?: string;
  readonly listedEvents?: readonly Stripe.Event[];
  readonly hasMore?: boolean;
  readonly exactEvents?: ReadonlyMap<string, Stripe.Event | Error>;
}) {
  const retrieveCurrent = vi.fn(() => Promise.resolve({ id: options.accountId ?? ACCOUNT_ID }));
  const list = vi.fn(() =>
    Promise.resolve({ data: options.listedEvents ?? [], has_more: options.hasMore ?? false }),
  );
  const retrieve = vi.fn((eventId: string) => {
    const result = options.exactEvents?.get(eventId);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    if (result === undefined) {
      return Promise.reject(
        new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: 'not found',
          statusCode: 404,
        }),
      );
    }
    return Promise.resolve(result);
  });
  return {
    retrieveCurrent,
    list,
    retrieve,
    client: {
      accounts: { retrieveCurrent },
      events: { list, retrieve },
    } satisfies StripeReconciliationSdkClient,
  };
}

function source(client: StripeReconciliationSdkClient) {
  return createStripeReconciliationEventSource({
    apiKey: 'sk_test_synthetic_reconciliation_key',
    timeoutMs: 500,
    sdkClient: client,
  });
}

describe('Stripe reconciliation event source adapter', () => {
  it('retrieves and caches the authenticated Stripe account identity', async () => {
    const fake = sdk({});
    const adapter = source(fake.client);

    await expect(adapter.getStripeAccountId()).resolves.toBe(ACCOUNT_ID);
    await expect(adapter.getStripeAccountId()).resolves.toBe(ACCOUNT_ID);

    expect(fake.retrieveCurrent).toHaveBeenCalledTimes(1);
  });

  it('lists one bounded page and maps only safe PaymentIntent identity fields', async () => {
    const stripeEvent = event('evt_range_adapter');
    const fake = sdk({ listedEvents: [stripeEvent], hasMore: true });
    const adapter = source(fake.client);

    const result = await adapter.findEvents({
      kind: 'time_range',
      since: '2026-08-20T08:00:00.000Z',
      until: '2026-08-20T10:00:00.000Z',
      limit: 20,
    });

    expect(fake.list).toHaveBeenCalledWith({
      created: { gte: 1_787_212_800, lte: 1_787_220_000 },
      limit: 20,
      types: [
        'payment_intent.created',
        'payment_intent.requires_action',
        'payment_intent.processing',
        'payment_intent.payment_failed',
        'payment_intent.succeeded',
        'payment_intent.canceled',
      ],
    });
    expect(result).toEqual({
      events: [
        {
          eventId: 'evt_range_adapter',
          eventType: 'payment_intent.succeeded',
          stripeAccountId: ACCOUNT_ID,
          apiVersion: '2026-08-01',
          createdAt: '2026-08-20T09:20:00.000Z',
          livemode: false,
          eventFingerprint: stripeEventFingerprint(stripeEvent),
          stripePaymentIntentId: 'pi_reconciliation_adapter',
          applicationMetadataNamespace: 'serverless-order-integration',
          merchantId: 'mrc_reconciliation_adapter',
          orderId: 'ord_reconciliation_adapter',
        },
      ],
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain('client_secret');
    expect(JSON.stringify(result)).not.toContain('must_not_escape');
  });

  it('retrieves exact IDs sequentially, preserves their order, and reports missing IDs indirectly', async () => {
    const first = event('evt_exact_first');
    const second = event('evt_exact_second', { account: 'acct_connected_not_expected' });
    const fake = sdk({
      exactEvents: new Map([
        ['evt_exact_first', first],
        ['evt_exact_second', second],
      ]),
    });
    const adapter = source(fake.client);

    const result = await adapter.findEvents({
      kind: 'event_ids',
      eventIds: ['evt_exact_first', 'evt_missing', 'evt_exact_second'],
    });

    expect(fake.retrieve.mock.calls.map(([eventId]) => eventId)).toEqual([
      'evt_exact_first',
      'evt_missing',
      'evt_exact_second',
    ]);
    expect(result.events.map((candidate) => candidate.eventId)).toEqual([
      'evt_exact_first',
      'evt_exact_second',
    ]);
    expect(result.events[1]?.stripeAccountId).toBe('acct_connected_not_expected');
    expect(result.hasMore).toBe(false);
  });

  it('keeps unsupported exact events visible without pretending they identify a PaymentIntent', async () => {
    const chargeEvent = event('evt_charge', {
      type: 'charge.succeeded',
      data: { object: { id: 'ch_123', object: 'charge' } },
    } as unknown as Partial<Stripe.Event>);
    const fake = sdk({ exactEvents: new Map([['evt_charge', chargeEvent]]) });

    const result = await source(fake.client).findEvents({
      kind: 'event_ids',
      eventIds: ['evt_charge'],
    });

    expect(result.events[0]).toEqual(
      expect.objectContaining({ eventId: 'evt_charge', eventType: 'charge.succeeded' }),
    );
    expect(result.events[0]).not.toHaveProperty('stripePaymentIntentId');
  });

  it('rejects an exact retrieval that returns a different event identity', async () => {
    const fake = sdk({
      exactEvents: new Map([['evt_requested', event('evt_different')]]),
    });

    await expect(
      source(fake.client).findEvents({ kind: 'event_ids', eventIds: ['evt_requested'] }),
    ).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH', retryable: false });
  });

  it('maps Stripe authentication failures without exposing the SDK message', async () => {
    const authenticationError = new Stripe.errors.StripeAuthenticationError({
      type: 'invalid_request_error',
      message: 'raw secret-related SDK detail',
      statusCode: 401,
    });
    const retrieveCurrent = vi.fn(() => Promise.reject(authenticationError));
    const fake = sdk({});
    const adapter = source({
      accounts: { retrieveCurrent },
      events: fake.client.events,
    });

    await expect(adapter.getStripeAccountId()).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      message: 'Stripe authentication failed.',
    });
  });

  it.each([
    { apiKey: 'sk_live_not_allowed', timeoutMs: 500 },
    { apiKey: 'sk_test_valid', timeoutMs: 0 },
  ])('rejects unsafe adapter configuration', ({ apiKey, timeoutMs }) => {
    expect(() =>
      createStripeReconciliationEventSource({ apiKey, timeoutMs, sdkClient: sdk({}).client }),
    ).toThrow();
  });
});
