import { describe, expect, it, vi } from 'vitest';

import {
  executeStripeReconciliation,
  StripeReconciliationExecutionError,
  type ExecuteStripeReconciliationDependencies,
} from '../../src/application/execute-stripe-reconciliation.js';
import type {
  ProcessStripeWebhookCommand,
  ProcessStripeWebhookDependencies,
} from '../../src/application/process-stripe-webhook.js';
import type {
  StripeReconciliationEvent,
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
import { createOrderFixture } from '../fixtures/order.js';

const ACCOUNT_ID = 'acct_execute_test';
const NOW = new Date('2026-08-24T08:00:00.000Z');

function reviewed(eventId: string, createdAt: string, fingerprint = 'a'.repeat(64)) {
  return {
    eventId,
    eventType: 'payment_intent.succeeded' as const,
    eventCreatedAt: createdAt,
    eventFingerprint: fingerprint,
    stripePaymentIntentId: `pi_${eventId}`,
    merchantId: 'mrc_demo',
    orderId: `ord_${eventId}`,
  };
}

function stripeEvent(entry: ReturnType<typeof reviewed>): StripeReconciliationEvent {
  return {
    eventId: entry.eventId,
    eventType: entry.eventType,
    stripeAccountId: ACCOUNT_ID,
    apiVersion: '2026-08-01',
    createdAt: entry.eventCreatedAt,
    livemode: false,
    eventFingerprint: entry.eventFingerprint,
    stripePaymentIntentId: entry.stripePaymentIntentId,
    applicationMetadataNamespace: STRIPE_APPLICATION_METADATA_NAMESPACE,
    merchantId: entry.merchantId,
    orderId: entry.orderId,
  };
}

class EventSource implements StripeReconciliationEventSource {
  readonly calls: string[] = [];

  constructor(private readonly events: ReadonlyMap<string, StripeReconciliationEvent>) {}

  getStripeAccountId(): Promise<string> {
    this.calls.push('account');
    return Promise.resolve(ACCOUNT_ID);
  }

  findEvents(query: StripeReconciliationEventQuery) {
    if (query.kind !== 'event_ids') {
      return Promise.reject(new Error('Execution must preflight exact event IDs.'));
    }
    this.calls.push(`event:${query.eventIds.join(',')}`);
    return Promise.resolve({
      events: query.eventIds.flatMap((eventId) => {
        const event = this.events.get(eventId);
        return event === undefined ? [] : [event];
      }),
      hasMore: false,
    });
  }
}

class PaymentClient implements StripePaymentClient {
  readonly calls: string[] = [];

  constructor(private readonly snapshots: ReadonlyMap<string, StripePaymentIntentSnapshot>) {}

  createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntentSnapshot> {
    void input;
    return Promise.reject(new Error('Reconciliation must not create a PaymentIntent.'));
  }

  retrievePaymentIntent(id: string): Promise<StripePaymentIntentSnapshot> {
    this.calls.push(id);
    const snapshot = this.snapshots.get(id);
    return snapshot === undefined
      ? Promise.reject(new Error(`Missing snapshot ${id}`))
      : Promise.resolve(snapshot);
  }
}

function snapshot(entry: ReturnType<typeof reviewed>): StripePaymentIntentSnapshot {
  return {
    stripePaymentIntentId: entry.stripePaymentIntentId,
    status: 'SUCCEEDED',
    amount: { amountMinor: 1299, currency: 'RON' },
    captureMethod: 'AUTOMATIC',
    merchantId: asMerchantId(entry.merchantId),
    orderId: asOrderId(entry.orderId),
  };
}

function dependencies(
  entries: readonly ReturnType<typeof reviewed>[],
  processEvent: ExecuteStripeReconciliationDependencies['processEvent'],
  events = entries.map(stripeEvent),
): ExecuteStripeReconciliationDependencies {
  return {
    eventSource: new EventSource(new Map(events.map((event) => [event.eventId, event]))),
    stripeClient: new PaymentClient(
      new Map(entries.map((entry) => [entry.stripePaymentIntentId, snapshot(entry)])),
    ),
    repository: {} as ExecuteStripeReconciliationDependencies['repository'],
    expectedStripeAccountId: ACCOUNT_ID,
    now: () => NOW,
    ...(processEvent === undefined ? {} : { processEvent }),
  };
}

describe('executeStripeReconciliation', () => {
  it('preflights the complete campaign before processing entries sequentially', async () => {
    const first = reviewed('evt_first', '2026-08-24T07:00:00.000Z');
    const second = reviewed('evt_second', '2026-08-24T07:01:00.000Z', 'b'.repeat(64));
    const commands: ProcessStripeWebhookCommand[] = [];
    const processEvent = vi.fn((_dependencies, command: ProcessStripeWebhookCommand) => {
      commands.push(command);
      return Promise.resolve({
        outcome: 'applied' as const,
        order: createOrderFixture({ version: commands.length }),
      });
    });
    const deps = dependencies([first, second], processEvent);

    const result = await executeStripeReconciliation(deps, {
      campaignId: 'campaign-reviewed',
      entries: [first, second],
    });

    expect((deps.eventSource as EventSource).calls).toEqual([
      'account',
      'event:evt_first,evt_second',
      'account',
      'event:evt_first',
      'account',
      'event:evt_second',
    ]);
    expect((deps.stripeClient as PaymentClient).calls).toEqual([
      first.stripePaymentIntentId,
      second.stripePaymentIntentId,
      first.stripePaymentIntentId,
      second.stripePaymentIntentId,
    ]);
    expect(commands.map((command) => command.correlationId)).toEqual([
      'stripe-reconcile:campaign-reviewed:evt_first',
      'stripe-reconcile:campaign-reviewed:evt_second',
    ]);
    expect(result).toMatchObject({
      successful: true,
      outcomes: [{ outcome: 'applied' }, { outcome: 'applied' }],
    });
  });

  it('performs no mutation when any current event differs from the reviewed campaign', async () => {
    const first = reviewed('evt_first', '2026-08-24T07:00:00.000Z');
    const second = reviewed('evt_second', '2026-08-24T07:01:00.000Z');
    const changedSecond = stripeEvent({ ...second, eventFingerprint: 'c'.repeat(64) });
    const processEvent = vi.fn();

    await expect(
      executeStripeReconciliation(
        dependencies([first, second], processEvent, [stripeEvent(first), changedSecond]),
        { campaignId: 'campaign-reviewed', entries: [first, second] },
      ),
    ).rejects.toBeInstanceOf(StripeReconciliationExecutionError);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('stops if PaymentIntent ownership changes after preflight and before mutation', async () => {
    const entry = reviewed('evt_owned', '2026-08-24T07:00:00.000Z');
    let retrieval = 0;
    const stripeClient: StripePaymentClient = {
      createPaymentIntent: () => Promise.reject(new Error('Must not create a PaymentIntent.')),
      retrievePaymentIntent: () => {
        retrieval += 1;
        return Promise.resolve(
          retrieval <= 2
            ? snapshot(entry)
            : { ...snapshot(entry), orderId: asOrderId('ord_changed_after_review') },
        );
      },
    };
    const processEvent = vi.fn(async (processDependencies: ProcessStripeWebhookDependencies) => {
      await processDependencies.stripeClient.retrievePaymentIntent(entry.stripePaymentIntentId);
      return { outcome: 'applied' as const, order: createOrderFixture() };
    });

    await expect(
      executeStripeReconciliation(
        {
          eventSource: new EventSource(new Map([[entry.eventId, stripeEvent(entry)]])),
          stripeClient,
          repository: {} as ExecuteStripeReconciliationDependencies['repository'],
          expectedStripeAccountId: ACCOUNT_ID,
          processEvent,
        },
        { campaignId: 'campaign-reviewed', entries: [entry] },
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_MISMATCH' });
  });

  it('records safe failures, continues the campaign, and returns a non-success result', async () => {
    const first = reviewed('evt_first', '2026-08-24T07:00:00.000Z');
    const second = reviewed('evt_second', '2026-08-24T07:01:00.000Z');
    const processEvent = vi.fn((_dependencies, command: ProcessStripeWebhookCommand) => {
      if (command.eventId === first.eventId) {
        return Promise.reject(new Error('secret provider detail'));
      }
      return Promise.resolve({
        outcome: 'reconciliation_required' as const,
        reasonCode: 'ORDER_NOT_FOUND',
        recorded: true,
      });
    });

    await expect(
      executeStripeReconciliation(dependencies([first, second], processEvent), {
        campaignId: 'campaign-reviewed',
        entries: [first, second],
      }),
    ).resolves.toEqual({
      campaignId: 'campaign-reviewed',
      successful: false,
      outcomes: [
        { eventId: first.eventId, outcome: 'failed', exceptionName: 'Error' },
        {
          eventId: second.eventId,
          outcome: 'reconciliation_required',
          reasonCode: 'ORDER_NOT_FOUND',
          recorded: true,
        },
      ],
    });
  });
});
