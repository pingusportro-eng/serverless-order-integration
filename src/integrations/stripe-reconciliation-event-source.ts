import Stripe from 'stripe';

import {
  SUPPORTED_STRIPE_WEBHOOK_EVENTS,
  type SupportedStripeWebhookEventType,
} from '../application/process-stripe-webhook.js';
import type {
  StripeReconciliationEvent,
  StripeReconciliationEventPage,
  StripeReconciliationEventQuery,
  StripeReconciliationEventSource,
} from '../application/stripe-reconciliation-event-source.js';
import { StripeClientError } from '../application/stripe-payment-client.js';
import { stripeEventFingerprint } from './stripe-event-fingerprint.js';
import { mapStripeClientError } from './stripe-payment-client.js';

interface StripeAccountsApi {
  retrieveCurrent(): Promise<{ readonly id: string }>;
}

interface StripeEventsApi {
  list(params: {
    readonly created: { readonly gte: number; readonly lte: number };
    readonly limit: number;
    readonly types: SupportedStripeWebhookEventType[];
  }): Promise<{ readonly data: readonly Stripe.Event[]; readonly has_more: boolean }>;
  retrieve(eventId: string): Promise<Stripe.Event>;
}

export interface StripeReconciliationSdkClient {
  readonly accounts: StripeAccountsApi;
  readonly events: StripeEventsApi;
}

export interface CreateStripeReconciliationEventSourceOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly sdkClient?: StripeReconciliationSdkClient;
}

function invalidResponse(message: string): StripeClientError {
  return new StripeClientError({
    code: 'INVALID_RESPONSE',
    retryable: true,
    message,
  });
}

function contractMismatch(message: string): StripeClientError {
  return new StripeClientError({
    code: 'CONTRACT_MISMATCH',
    retryable: false,
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function paymentIntentIdentity(event: Stripe.Event): {
  readonly stripePaymentIntentId?: string;
  readonly applicationMetadataNamespace?: string;
  readonly merchantId?: string;
  readonly orderId?: string;
} {
  const object: unknown = event.data.object;
  if (!isRecord(object) || typeof object['id'] !== 'string' || !object['id'].startsWith('pi_')) {
    return {};
  }
  const metadata = isRecord(object['metadata']) ? object['metadata'] : {};
  const applicationMetadataNamespace = metadataValue(metadata, 'application');
  const merchantId = metadataValue(metadata, 'merchantId');
  const orderId = metadataValue(metadata, 'orderId');
  return {
    stripePaymentIntentId: object['id'],
    ...(applicationMetadataNamespace === undefined ? {} : { applicationMetadataNamespace }),
    ...(merchantId === undefined ? {} : { merchantId }),
    ...(orderId === undefined ? {} : { orderId }),
  };
}

function reconciliationEvent(event: Stripe.Event, authenticatedAccountId: string) {
  if (!event.id.startsWith('evt_') || event.type.length === 0) {
    throw invalidResponse('Stripe returned an event with an invalid identity.');
  }
  if (!Number.isSafeInteger(event.created) || event.created < 0) {
    throw invalidResponse('Stripe returned an event with an invalid creation time.');
  }
  const createdAt = new Date(event.created * 1000).toISOString();
  return {
    eventId: event.id,
    eventType: event.type,
    stripeAccountId: event.account ?? authenticatedAccountId,
    apiVersion: event.api_version,
    createdAt,
    livemode: event.livemode,
    eventFingerprint: stripeEventFingerprint(event),
    ...paymentIntentIdentity(event),
  } satisfies StripeReconciliationEvent;
}

function lowerBoundUnixSeconds(value: string): number {
  return Math.ceil(Date.parse(value) / 1000);
}

function upperBoundUnixSeconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

export function createStripeReconciliationEventSource(
  options: CreateStripeReconciliationEventSourceOptions,
): StripeReconciliationEventSource {
  if (!options.apiKey.startsWith('sk_test_')) {
    throw new Error('Stripe reconciliation requires a Sandbox secret key beginning with sk_test_.');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Stripe reconciliation timeout must be a positive integer.');
  }
  const stripe =
    options.sdkClient ??
    new Stripe(options.apiKey, {
      timeout: options.timeoutMs,
      maxNetworkRetries: 0,
    });
  let accountIdPromise: Promise<string> | undefined;

  async function getStripeAccountId(): Promise<string> {
    accountIdPromise ??= (async () => {
      try {
        const account = await stripe.accounts.retrieveCurrent();
        if (!account.id.startsWith('acct_')) {
          throw invalidResponse('Stripe returned an invalid account identity.');
        }
        return account.id;
      } catch (error: unknown) {
        throw mapStripeClientError(error);
      }
    })();
    return accountIdPromise;
  }

  async function findTimeRangeEvents(
    query: Extract<StripeReconciliationEventQuery, { kind: 'time_range' }>,
    accountId: string,
  ): Promise<StripeReconciliationEventPage> {
    const response = await stripe.events.list({
      created: {
        gte: lowerBoundUnixSeconds(query.since),
        lte: upperBoundUnixSeconds(query.until),
      },
      limit: query.limit,
      types: [...SUPPORTED_STRIPE_WEBHOOK_EVENTS],
    });
    if (response.data.length > query.limit) {
      throw invalidResponse('Stripe returned more events than the requested limit.');
    }
    return {
      events: response.data.map((event) => reconciliationEvent(event, accountId)),
      hasMore: response.has_more,
    };
  }

  async function findExactEvents(
    query: Extract<StripeReconciliationEventQuery, { kind: 'event_ids' }>,
    accountId: string,
  ): Promise<StripeReconciliationEventPage> {
    const events: StripeReconciliationEvent[] = [];
    for (const eventId of query.eventIds) {
      try {
        const event = await stripe.events.retrieve(eventId);
        if (event.id !== eventId) {
          throw contractMismatch('Stripe returned a different event than requested.');
        }
        events.push(reconciliationEvent(event, accountId));
      } catch (error: unknown) {
        const mapped = mapStripeClientError(error);
        if (mapped.code !== 'NOT_FOUND') {
          throw mapped;
        }
      }
    }
    return { events, hasMore: false };
  }

  return {
    getStripeAccountId,
    async findEvents(
      query: StripeReconciliationEventQuery,
    ): Promise<StripeReconciliationEventPage> {
      const accountId = await getStripeAccountId();
      try {
        return query.kind === 'time_range'
          ? await findTimeRangeEvents(query, accountId)
          : await findExactEvents(query, accountId);
      } catch (error: unknown) {
        throw mapStripeClientError(error);
      }
    },
  };
}
