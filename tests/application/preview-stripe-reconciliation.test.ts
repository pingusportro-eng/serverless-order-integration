import { describe, expect, it } from 'vitest';

import {
  MAX_STRIPE_RECONCILIATION_LIMIT,
  previewStripeReconciliation,
  StripeReconciliationPreviewError,
} from '../../src/application/preview-stripe-reconciliation.js';
import type {
  StripeReconciliationEvent,
  StripeReconciliationEventPage,
  StripeReconciliationEventQuery,
  StripeReconciliationEventSource,
} from '../../src/application/stripe-reconciliation-event-source.js';
import type {
  CreateStripePaymentIntentInput,
  StripePaymentClient,
  StripePaymentIntentSnapshot,
} from '../../src/application/stripe-payment-client.js';
import { STRIPE_APPLICATION_METADATA_NAMESPACE } from '../../src/application/stripe-payment-client.js';
import { asMerchantId, asOrderId } from '../../src/domain/order.js';

const ACCOUNT_ID = 'acct_reconciliation_test';
const NAMESPACE = STRIPE_APPLICATION_METADATA_NAMESPACE;
const PREVIEWED_AT = '2026-08-20T10:00:00.000Z';

function event(
  eventId: string,
  overrides: Partial<StripeReconciliationEvent> = {},
): StripeReconciliationEvent {
  return {
    eventId,
    eventType: 'payment_intent.succeeded',
    stripeAccountId: ACCOUNT_ID,
    apiVersion: '2026-08-01',
    createdAt: '2026-08-20T09:00:00.000Z',
    livemode: false,
    eventFingerprint: 'a'.repeat(64),
    stripePaymentIntentId: `pi_${eventId}`,
    applicationMetadataNamespace: NAMESPACE,
    merchantId: 'mrc_preview',
    orderId: `ord_${eventId}`,
    ...overrides,
  };
}

function snapshot(candidate: StripeReconciliationEvent): StripePaymentIntentSnapshot {
  return {
    stripePaymentIntentId: candidate.stripePaymentIntentId as string,
    status: 'SUCCEEDED',
    amount: { amountMinor: 1299, currency: 'RON' },
    captureMethod: 'AUTOMATIC',
    merchantId: asMerchantId(candidate.merchantId as string),
    orderId: asOrderId(candidate.orderId as string),
  };
}

class EventSource implements StripeReconciliationEventSource {
  readonly queries: StripeReconciliationEventQuery[] = [];

  constructor(
    private readonly page: StripeReconciliationEventPage,
    private readonly accountId = ACCOUNT_ID,
  ) {}

  getStripeAccountId(): Promise<string> {
    return Promise.resolve(this.accountId);
  }

  findEvents(query: StripeReconciliationEventQuery): Promise<StripeReconciliationEventPage> {
    this.queries.push(query);
    return Promise.resolve(this.page);
  }
}

class PaymentClient implements StripePaymentClient {
  readonly retrieveCalls: string[] = [];

  constructor(private readonly snapshots: ReadonlyMap<string, StripePaymentIntentSnapshot>) {}

  createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntentSnapshot> {
    void input;
    return Promise.reject(new Error('Preview must never create a PaymentIntent.'));
  }

  retrievePaymentIntent(stripePaymentIntentId: string): Promise<StripePaymentIntentSnapshot> {
    this.retrieveCalls.push(stripePaymentIntentId);
    const result = this.snapshots.get(stripePaymentIntentId);
    if (result === undefined) {
      return Promise.reject(new Error(`Missing snapshot ${stripePaymentIntentId}.`));
    }
    return Promise.resolve(result);
  }
}

function dependencies(
  candidates: readonly StripeReconciliationEvent[],
  options: {
    readonly accountId?: string;
    readonly hasMore?: boolean;
    readonly snapshots?: ReadonlyMap<string, StripePaymentIntentSnapshot>;
  } = {},
) {
  const eventSource = new EventSource(
    { events: candidates, hasMore: options.hasMore ?? false },
    options.accountId,
  );
  const stripeClient = new PaymentClient(
    options.snapshots ??
      new Map(
        candidates
          .filter((candidate) => candidate.stripePaymentIntentId !== undefined)
          .map((candidate) => [candidate.stripePaymentIntentId as string, snapshot(candidate)]),
      ),
  );
  return {
    eventSource,
    stripeClient,
    expectedStripeAccountId: ACCOUNT_ID,
    now: () => new Date(PREVIEWED_AT),
  };
}

describe('previewStripeReconciliation', () => {
  it('builds a deterministic, safe preview from a bounded time range', async () => {
    const later = event('evt_later', {
      createdAt: '2026-08-20T09:30:00.000Z',
      eventFingerprint: 'b'.repeat(64),
    });
    const earlier = event('evt_earlier', { createdAt: '2026-08-20T08:30:00.000Z' });
    const deps = dependencies([later, earlier], { hasMore: true });

    const result = await previewStripeReconciliation(deps, {
      kind: 'time_range',
      since: '2026-08-20T08:00:00Z',
    });

    expect(deps.eventSource.queries).toEqual([
      {
        kind: 'time_range',
        since: '2026-08-20T08:00:00.000Z',
        until: PREVIEWED_AT,
        limit: 20,
      },
    ]);
    expect(result.selection).toEqual({
      kind: 'time_range',
      since: '2026-08-20T08:00:00.000Z',
      until: PREVIEWED_AT,
      limit: 20,
      hasMore: true,
    });
    expect(result.entries.map((entry) => entry.eventId)).toEqual(['evt_earlier', 'evt_later']);
    expect(result.entries[0]).toEqual({
      eventId: 'evt_earlier',
      eventType: 'payment_intent.succeeded',
      eventCreatedAt: '2026-08-20T08:30:00.000Z',
      eventFingerprint: 'a'.repeat(64),
      stripePaymentIntentId: 'pi_evt_earlier',
      merchantId: 'mrc_preview',
      orderId: 'ord_evt_earlier',
    });
    expect(result).not.toHaveProperty('clientSecret');
    expect(deps.stripeClient.retrieveCalls).toEqual(['pi_evt_earlier', 'pi_evt_later']);
  });

  it('supports exact event IDs and reports a missing requested event', async () => {
    const present = event('evt_present');
    const deps = dependencies([present]);

    const result = await previewStripeReconciliation(deps, {
      kind: 'event_ids',
      eventIds: ['evt_missing', 'evt_present'],
    });

    expect(deps.eventSource.queries).toEqual([
      { kind: 'event_ids', eventIds: ['evt_missing', 'evt_present'] },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.excluded).toEqual([{ eventId: 'evt_missing', reason: 'EVENT_NOT_FOUND' }]);
  });

  it('excludes unsupported, unowned, and mismatched PaymentIntent events explicitly', async () => {
    const unsupported = event('evt_unsupported', { eventType: 'charge.succeeded' });
    const foreignNamespace = event('evt_foreign_namespace', {
      applicationMetadataNamespace: 'another-application',
    });
    const missingOwnership = event('evt_missing_ownership', { merchantId: '' });
    const mismatched = event('evt_mismatched');
    const mismatchedSnapshot = {
      ...snapshot(mismatched),
      orderId: asOrderId('ord_someone_else'),
    };
    const snapshots = new Map([[mismatched.stripePaymentIntentId as string, mismatchedSnapshot]]);
    const deps = dependencies([unsupported, foreignNamespace, missingOwnership, mismatched], {
      snapshots,
    });

    const result = await previewStripeReconciliation(deps, {
      kind: 'event_ids',
      eventIds: [
        unsupported.eventId,
        foreignNamespace.eventId,
        missingOwnership.eventId,
        mismatched.eventId,
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.excluded).toEqual([
      { eventId: 'evt_foreign_namespace', reason: 'APPLICATION_NAMESPACE_MISMATCH' },
      { eventId: 'evt_mismatched', reason: 'PAYMENT_INTENT_OWNERSHIP_MISMATCH' },
      { eventId: 'evt_missing_ownership', reason: 'OWNERSHIP_METADATA_MISSING' },
      { eventId: 'evt_unsupported', reason: 'UNSUPPORTED_EVENT_TYPE' },
    ]);
    expect(deps.stripeClient.retrieveCalls).toEqual(['pi_evt_mismatched']);
  });

  it.each([
    {
      name: 'an unexpected authenticated Stripe account',
      deps: dependencies([], { accountId: 'acct_someone_else' }),
      command: { kind: 'event_ids', eventIds: ['evt_one'] } as const,
      code: 'STRIPE_ACCOUNT_MISMATCH',
    },
    {
      name: 'a live-mode event',
      deps: dependencies([event('evt_live', { livemode: true })]),
      command: { kind: 'event_ids', eventIds: ['evt_live'] } as const,
      code: 'LIVE_EVENT_NOT_ALLOWED',
    },
  ])('refuses $name', async ({ deps, command, code }) => {
    await expect(previewStripeReconciliation(deps, command)).rejects.toMatchObject({ code });
  });

  it.each([
    {
      command: { kind: 'time_range', since: 'not-a-date' } as const,
      code: 'INVALID_TIME_RANGE',
    },
    {
      command: {
        kind: 'time_range',
        since: PREVIEWED_AT,
        until: PREVIEWED_AT,
      } as const,
      code: 'INVALID_TIME_RANGE',
    },
    {
      command: {
        kind: 'event_ids',
        eventIds: ['evt_duplicate', 'evt_duplicate'],
      } as const,
      code: 'INVALID_EVENT_IDS',
    },
    {
      command: {
        kind: 'event_ids',
        eventIds: ['evt_one'],
        limit: MAX_STRIPE_RECONCILIATION_LIMIT + 1,
      } as const,
      code: 'INVALID_LIMIT',
    },
  ])('rejects invalid command input with $code', async ({ command, code }) => {
    await expect(previewStripeReconciliation(dependencies([]), command)).rejects.toBeInstanceOf(
      StripeReconciliationPreviewError,
    );
    await expect(previewStripeReconciliation(dependencies([]), command)).rejects.toMatchObject({
      code,
    });
  });

  it('rejects event-source output outside the reviewed selection', async () => {
    const deps = dependencies([event('evt_unrequested')]);

    await expect(
      previewStripeReconciliation(deps, {
        kind: 'event_ids',
        eventIds: ['evt_requested'],
      }),
    ).rejects.toMatchObject({ code: 'EVENT_SOURCE_CONTRACT_MISMATCH' });
  });
});
