import {
  processStripeWebhook,
  type ProcessStripeWebhookDependencies,
  type ProcessStripeWebhookResult,
} from './process-stripe-webhook.js';
import {
  previewStripeReconciliation,
  type PreviewStripeReconciliationDependencies,
  type StripeReconciliationPreviewEntry,
} from './preview-stripe-reconciliation.js';
import type {
  CreateStripePaymentIntentInput,
  StripePaymentClient,
  StripePaymentIntentSnapshot,
} from './stripe-payment-client.js';

export interface ExecuteStripeReconciliationCampaign {
  readonly campaignId: string;
  readonly entries: readonly StripeReconciliationPreviewEntry[];
}

export interface ExecuteStripeReconciliationDependencies extends PreviewStripeReconciliationDependencies {
  readonly repository: ProcessStripeWebhookDependencies['repository'];
  readonly processEvent?: typeof processStripeWebhook;
}

export type StripeReconciliationExecutionOutcome =
  | {
      readonly eventId: string;
      readonly outcome: 'applied' | 'ignored';
      readonly orderId: string;
      readonly orderVersion: number;
    }
  | {
      readonly eventId: string;
      readonly outcome: 'reconciliation_required';
      readonly reasonCode: string;
      readonly recorded: boolean;
      readonly orderId?: string;
      readonly orderVersion?: number;
    }
  | {
      readonly eventId: string;
      readonly outcome: 'failed';
      readonly exceptionName: string;
    };

export interface StripeReconciliationExecution {
  readonly campaignId: string;
  readonly outcomes: readonly StripeReconciliationExecutionOutcome[];
  readonly successful: boolean;
}

export const STRIPE_RECONCILIATION_EXECUTION_ERROR_CODES = [
  'INVALID_CAMPAIGN',
  'REVIEW_MISMATCH',
] as const;

export type StripeReconciliationExecutionErrorCode =
  (typeof STRIPE_RECONCILIATION_EXECUTION_ERROR_CODES)[number];

export class StripeReconciliationExecutionError extends Error {
  override readonly name = 'StripeReconciliationExecutionError';

  constructor(
    readonly code: StripeReconciliationExecutionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: StripeReconciliationExecutionErrorCode, message: string): never {
  throw new StripeReconciliationExecutionError(code, message);
}

function sameEntry(
  reviewed: StripeReconciliationPreviewEntry,
  current: StripeReconciliationPreviewEntry,
): boolean {
  return (
    reviewed.eventId === current.eventId &&
    reviewed.eventType === current.eventType &&
    reviewed.eventCreatedAt === current.eventCreatedAt &&
    reviewed.eventFingerprint === current.eventFingerprint &&
    reviewed.stripePaymentIntentId === current.stripePaymentIntentId &&
    reviewed.merchantId === current.merchantId &&
    reviewed.orderId === current.orderId
  );
}

async function validateCampaign(
  dependencies: ExecuteStripeReconciliationDependencies,
  campaign: ExecuteStripeReconciliationCampaign,
): Promise<void> {
  if (campaign.campaignId.trim().length === 0 || campaign.entries.length === 0) {
    fail('INVALID_CAMPAIGN', 'A non-empty reviewed Stripe reconciliation campaign is required.');
  }

  const preview = await previewStripeReconciliation(
    {
      eventSource: dependencies.eventSource,
      stripeClient: dependencies.stripeClient,
      expectedStripeAccountId: dependencies.expectedStripeAccountId,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    },
    {
      kind: 'event_ids',
      eventIds: campaign.entries.map((entry) => entry.eventId),
      limit: campaign.entries.length,
    },
  );
  const currentEntries = new Map(preview.entries.map((entry) => [entry.eventId, entry]));
  for (const reviewed of campaign.entries) {
    const current = currentEntries.get(reviewed.eventId);
    if (
      preview.entries.length !== campaign.entries.length ||
      preview.excluded.length !== 0 ||
      current === undefined ||
      !sameEntry(reviewed, current)
    ) {
      fail(
        'REVIEW_MISMATCH',
        `Stripe event ${reviewed.eventId} no longer matches the reviewed campaign.`,
      );
    }
  }
}

async function validateEntryImmediatelyBeforeMutation(
  dependencies: ExecuteStripeReconciliationDependencies,
  campaignId: string,
  entry: StripeReconciliationPreviewEntry,
): Promise<void> {
  await validateCampaign(dependencies, { campaignId, entries: [entry] });
}

function reviewedPaymentClient(
  stripeClient: StripePaymentClient,
  reviewed: StripeReconciliationPreviewEntry,
): StripePaymentClient {
  return {
    createPaymentIntent(
      input: CreateStripePaymentIntentInput,
    ): Promise<StripePaymentIntentSnapshot> {
      return stripeClient.createPaymentIntent(input);
    },
    async retrievePaymentIntent(
      stripePaymentIntentId: string,
    ): Promise<StripePaymentIntentSnapshot> {
      const snapshot = await stripeClient.retrievePaymentIntent(stripePaymentIntentId);
      if (
        stripePaymentIntentId !== reviewed.stripePaymentIntentId ||
        snapshot.stripePaymentIntentId !== reviewed.stripePaymentIntentId ||
        snapshot.merchantId !== reviewed.merchantId ||
        snapshot.orderId !== reviewed.orderId
      ) {
        fail(
          'REVIEW_MISMATCH',
          `PaymentIntent ownership for ${reviewed.eventId} no longer matches the reviewed campaign.`,
        );
      }
      return snapshot;
    },
  };
}

function safeExceptionName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : 'UnknownError';
}

function safeOutcome(
  eventId: string,
  result: ProcessStripeWebhookResult,
): StripeReconciliationExecutionOutcome {
  if (result.outcome === 'reconciliation_required') {
    return {
      eventId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      recorded: result.recorded,
      ...(result.order === undefined
        ? {}
        : { orderId: result.order.orderId, orderVersion: result.order.version }),
    };
  }
  return {
    eventId,
    outcome: result.outcome,
    orderId: result.order.orderId,
    orderVersion: result.order.version,
  };
}

export async function executeStripeReconciliation(
  dependencies: ExecuteStripeReconciliationDependencies,
  campaign: ExecuteStripeReconciliationCampaign,
): Promise<StripeReconciliationExecution> {
  // Preflight the complete campaign before allowing the first business mutation.
  await validateCampaign(dependencies, campaign);

  const processEvent = dependencies.processEvent ?? processStripeWebhook;
  const outcomes: StripeReconciliationExecutionOutcome[] = [];
  for (const reviewed of campaign.entries) {
    try {
      await validateEntryImmediatelyBeforeMutation(dependencies, campaign.campaignId, reviewed);
      const result = await processEvent(
        {
          repository: dependencies.repository,
          stripeClient: reviewedPaymentClient(dependencies.stripeClient, reviewed),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        },
        {
          eventId: reviewed.eventId,
          eventType: reviewed.eventType,
          stripePaymentIntentId: reviewed.stripePaymentIntentId,
          eventFingerprint: reviewed.eventFingerprint,
          correlationId: `stripe-reconcile:${campaign.campaignId}:${reviewed.eventId}`,
        },
      );
      outcomes.push(safeOutcome(reviewed.eventId, result));
    } catch (error: unknown) {
      if (error instanceof StripeReconciliationExecutionError) {
        throw error;
      }
      outcomes.push({
        eventId: reviewed.eventId,
        outcome: 'failed',
        exceptionName: safeExceptionName(error),
      });
    }
  }

  return {
    campaignId: campaign.campaignId,
    outcomes,
    successful: outcomes.every(
      (outcome) => outcome.outcome === 'applied' || outcome.outcome === 'ignored',
    ),
  };
}
