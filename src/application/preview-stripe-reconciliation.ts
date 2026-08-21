import {
  SUPPORTED_STRIPE_WEBHOOK_EVENTS,
  type SupportedStripeWebhookEventType,
} from './process-stripe-webhook.js';
import type {
  StripeReconciliationEvent,
  StripeReconciliationEventQuery,
  StripeReconciliationEventSource,
} from './stripe-reconciliation-event-source.js';
import {
  STRIPE_APPLICATION_METADATA_NAMESPACE,
  type StripePaymentClient,
} from './stripe-payment-client.js';

export const DEFAULT_STRIPE_RECONCILIATION_LIMIT = 20;
export const MAX_STRIPE_RECONCILIATION_LIMIT = 100;

export type PreviewStripeReconciliationCommand =
  | {
      readonly kind: 'time_range';
      readonly since: string;
      readonly until?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'event_ids';
      readonly eventIds: readonly string[];
      readonly limit?: number;
    };

export interface PreviewStripeReconciliationDependencies {
  readonly eventSource: StripeReconciliationEventSource;
  readonly stripeClient: StripePaymentClient;
  readonly expectedStripeAccountId: string;
  readonly now?: () => Date;
}

export const STRIPE_RECONCILIATION_EXCLUSION_REASONS = [
  'EVENT_NOT_FOUND',
  'UNSUPPORTED_EVENT_TYPE',
  'PAYMENT_INTENT_ID_MISSING',
  'APPLICATION_NAMESPACE_MISMATCH',
  'OWNERSHIP_METADATA_MISSING',
  'PAYMENT_INTENT_OWNERSHIP_MISMATCH',
] as const;

export type StripeReconciliationExclusionReason =
  (typeof STRIPE_RECONCILIATION_EXCLUSION_REASONS)[number];

export interface StripeReconciliationPreviewEntry {
  readonly eventId: string;
  readonly eventType: SupportedStripeWebhookEventType;
  readonly eventCreatedAt: string;
  readonly eventFingerprint: string;
  readonly stripePaymentIntentId: string;
  readonly merchantId: string;
  readonly orderId: string;
}

export interface StripeReconciliationExcludedEvent {
  readonly eventId: string;
  readonly reason: StripeReconciliationExclusionReason;
}

export interface StripeReconciliationPreview {
  readonly stripeAccountId: string;
  readonly previewedAt: string;
  readonly selection:
    | {
        readonly kind: 'time_range';
        readonly since: string;
        readonly until: string;
        readonly limit: number;
        readonly hasMore: boolean;
      }
    | {
        readonly kind: 'event_ids';
        readonly eventIds: readonly string[];
      };
  readonly entries: readonly StripeReconciliationPreviewEntry[];
  readonly excluded: readonly StripeReconciliationExcludedEvent[];
}

export const STRIPE_RECONCILIATION_PREVIEW_ERROR_CODES = [
  'INVALID_CONFIGURATION',
  'INVALID_LIMIT',
  'INVALID_TIME_RANGE',
  'INVALID_EVENT_IDS',
  'STRIPE_ACCOUNT_MISMATCH',
  'LIVE_EVENT_NOT_ALLOWED',
  'EVENT_SOURCE_CONTRACT_MISMATCH',
] as const;

export type StripeReconciliationPreviewErrorCode =
  (typeof STRIPE_RECONCILIATION_PREVIEW_ERROR_CODES)[number];

export class StripeReconciliationPreviewError extends Error {
  override readonly name = 'StripeReconciliationPreviewError';

  constructor(
    readonly code: StripeReconciliationPreviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(code: StripeReconciliationPreviewErrorCode, message: string): never {
  throw new StripeReconciliationPreviewError(code, message);
}

function requiredConfiguration(value: string, name: string): string {
  if (value.trim().length === 0) {
    fail('INVALID_CONFIGURATION', `${name} must not be empty.`);
  }
  return value;
}

function limitOf(command: PreviewStripeReconciliationCommand): number {
  const limit = command.limit ?? DEFAULT_STRIPE_RECONCILIATION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STRIPE_RECONCILIATION_LIMIT) {
    fail(
      'INVALID_LIMIT',
      `Stripe reconciliation limit must be between 1 and ${String(MAX_STRIPE_RECONCILIATION_LIMIT)}.`,
    );
  }
  return limit;
}

function rfc3339(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !RFC3339_TIMESTAMP.test(value)) {
    fail('INVALID_TIME_RANGE', `${name} must be an RFC3339 timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function eventIdsOf(command: Extract<PreviewStripeReconciliationCommand, { kind: 'event_ids' }>) {
  if (command.eventIds.length === 0) {
    fail('INVALID_EVENT_IDS', 'At least one Stripe event ID is required.');
  }
  const eventIds = command.eventIds.map((eventId) => eventId.trim());
  if (eventIds.some((eventId) => !eventId.startsWith('evt_'))) {
    fail('INVALID_EVENT_IDS', 'Every Stripe event ID must begin with evt_.');
  }
  if (new Set(eventIds).size !== eventIds.length) {
    fail('INVALID_EVENT_IDS', 'Stripe event IDs must not contain duplicates.');
  }
  return eventIds;
}

function queryAndSelection(
  command: PreviewStripeReconciliationCommand,
  previewedAt: string,
): {
  readonly query: StripeReconciliationEventQuery;
  readonly selection:
    | Omit<Extract<StripeReconciliationPreview['selection'], { kind: 'time_range' }>, 'hasMore'>
    | Extract<StripeReconciliationPreview['selection'], { kind: 'event_ids' }>;
} {
  const limit = limitOf(command);
  if (command.kind === 'event_ids') {
    const eventIds = eventIdsOf(command);
    if (eventIds.length > limit) {
      fail('INVALID_LIMIT', 'The number of exact event IDs exceeds the reconciliation limit.');
    }
    return {
      query: { kind: 'event_ids', eventIds },
      selection: { kind: 'event_ids', eventIds },
    };
  }

  const since = rfc3339(command.since, 'since');
  const until = rfc3339(command.until ?? previewedAt, 'until');
  if (since >= until) {
    fail('INVALID_TIME_RANGE', 'since must occur before until.');
  }
  return {
    query: { kind: 'time_range', since, until, limit },
    selection: { kind: 'time_range', since, until, limit },
  };
}

function supportedEventType(value: string): value is SupportedStripeWebhookEventType {
  return SUPPORTED_STRIPE_WEBHOOK_EVENTS.some((candidate) => candidate === value);
}

function assertSafeEnvelope(event: StripeReconciliationEvent, expectedAccountId: string): void {
  if (event.stripeAccountId !== expectedAccountId) {
    fail('STRIPE_ACCOUNT_MISMATCH', `Stripe event ${event.eventId} belongs to another account.`);
  }
  if (event.livemode) {
    fail('LIVE_EVENT_NOT_ALLOWED', `Stripe event ${event.eventId} is a live-mode event.`);
  }
  if (
    !event.eventId.startsWith('evt_') ||
    !Number.isFinite(Date.parse(event.createdAt)) ||
    !RFC3339_TIMESTAMP.test(event.createdAt) ||
    !/^[a-f0-9]{64}$/.test(event.eventFingerprint)
  ) {
    fail(
      'EVENT_SOURCE_CONTRACT_MISMATCH',
      `Stripe event ${event.eventId || '<missing>'} has an invalid safe envelope.`,
    );
  }
}

function initialExclusion(
  event: StripeReconciliationEvent,
  expectedNamespace: string,
): StripeReconciliationExclusionReason | undefined {
  if (!supportedEventType(event.eventType)) {
    return 'UNSUPPORTED_EVENT_TYPE';
  }
  if (event.stripePaymentIntentId === undefined || !event.stripePaymentIntentId.startsWith('pi_')) {
    return 'PAYMENT_INTENT_ID_MISSING';
  }
  if (event.applicationMetadataNamespace !== expectedNamespace) {
    return 'APPLICATION_NAMESPACE_MISMATCH';
  }
  if (
    event.merchantId === undefined ||
    event.merchantId.length === 0 ||
    event.orderId === undefined ||
    event.orderId.length === 0
  ) {
    return 'OWNERSHIP_METADATA_MISSING';
  }
  return undefined;
}

function sortEvents(events: readonly StripeReconciliationEvent[]): StripeReconciliationEvent[] {
  return [...events].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.eventId.localeCompare(right.eventId),
  );
}

function assertSourceSelection(
  query: StripeReconciliationEventQuery,
  events: readonly StripeReconciliationEvent[],
): void {
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      fail(
        'EVENT_SOURCE_CONTRACT_MISMATCH',
        `Stripe event source returned duplicate event ${event.eventId}.`,
      );
    }
    eventIds.add(event.eventId);
    if (query.kind === 'event_ids' && !query.eventIds.includes(event.eventId)) {
      fail(
        'EVENT_SOURCE_CONTRACT_MISMATCH',
        `Stripe event source returned unrequested event ${event.eventId}.`,
      );
    }
    if (
      query.kind === 'time_range' &&
      (Date.parse(event.createdAt) < Date.parse(query.since) ||
        Date.parse(event.createdAt) > Date.parse(query.until))
    ) {
      fail(
        'EVENT_SOURCE_CONTRACT_MISMATCH',
        `Stripe event source returned event ${event.eventId} outside the reviewed time range.`,
      );
    }
  }
  if (query.kind === 'time_range' && events.length > query.limit) {
    fail('EVENT_SOURCE_CONTRACT_MISMATCH', 'Stripe event source exceeded the reviewed limit.');
  }
}

export async function previewStripeReconciliation(
  dependencies: PreviewStripeReconciliationDependencies,
  command: PreviewStripeReconciliationCommand,
): Promise<StripeReconciliationPreview> {
  const expectedStripeAccountId = requiredConfiguration(
    dependencies.expectedStripeAccountId,
    'expectedStripeAccountId',
  );
  const previewedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const { query, selection } = queryAndSelection(command, previewedAt);
  const stripeAccountId = await dependencies.eventSource.getStripeAccountId();
  if (stripeAccountId !== expectedStripeAccountId) {
    fail(
      'STRIPE_ACCOUNT_MISMATCH',
      'Authenticated Stripe account does not match the reviewed target.',
    );
  }

  const page = await dependencies.eventSource.findEvents(query);
  if (query.kind === 'event_ids' && page.hasMore) {
    fail(
      'EVENT_SOURCE_CONTRACT_MISMATCH',
      'Stripe event source did not finish resolving the exact event IDs.',
    );
  }
  assertSourceSelection(query, page.events);
  const entries: StripeReconciliationPreviewEntry[] = [];
  const excluded: StripeReconciliationExcludedEvent[] = [];
  const foundEventIds = new Set(page.events.map((event) => event.eventId));

  if (query.kind === 'event_ids') {
    for (const eventId of query.eventIds) {
      if (!foundEventIds.has(eventId)) {
        excluded.push({ eventId, reason: 'EVENT_NOT_FOUND' });
      }
    }
  }

  for (const event of sortEvents(page.events)) {
    assertSafeEnvelope(event, expectedStripeAccountId);
    const reason = initialExclusion(event, STRIPE_APPLICATION_METADATA_NAMESPACE);
    if (reason !== undefined) {
      excluded.push({ eventId: event.eventId, reason });
      continue;
    }

    const stripePaymentIntentId = event.stripePaymentIntentId as string;
    const merchantId = event.merchantId as string;
    const orderId = event.orderId as string;
    const snapshot = await dependencies.stripeClient.retrievePaymentIntent(stripePaymentIntentId);
    if (
      snapshot.stripePaymentIntentId !== stripePaymentIntentId ||
      snapshot.merchantId !== merchantId ||
      snapshot.orderId !== orderId
    ) {
      excluded.push({ eventId: event.eventId, reason: 'PAYMENT_INTENT_OWNERSHIP_MISMATCH' });
      continue;
    }

    entries.push({
      eventId: event.eventId,
      eventType: event.eventType as SupportedStripeWebhookEventType,
      eventCreatedAt: new Date(event.createdAt).toISOString(),
      eventFingerprint: event.eventFingerprint,
      stripePaymentIntentId,
      merchantId,
      orderId,
    });
  }

  return {
    stripeAccountId,
    previewedAt,
    selection:
      selection.kind === 'time_range' ? { ...selection, hasMore: page.hasMore } : selection,
    entries,
    excluded,
  };
}
