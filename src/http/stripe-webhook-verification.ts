import Stripe from 'stripe';

import {
  SUPPORTED_STRIPE_WEBHOOK_EVENTS,
  type SupportedStripeWebhookEventType,
} from '../application/process-stripe-webhook.js';
import { stripeEventFingerprint } from '../integrations/stripe-event-fingerprint.js';

export interface VerifiedStripeWebhookEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly stripePaymentIntentId?: string;
  readonly eventFingerprint: string;
  readonly supported: boolean;
}

export interface VerifyStripeWebhookInput {
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly signingSecret: string;
  readonly toleranceSeconds: number;
  readonly receivedAtSeconds?: number;
}

export class InvalidStripeWebhookError extends Error {
  override readonly name = 'InvalidStripeWebhookError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function supportedEventType(value: string): value is SupportedStripeWebhookEventType {
  return SUPPORTED_STRIPE_WEBHOOK_EVENTS.some((candidate) => candidate === value);
}

export function verifyStripeWebhook(input: VerifyStripeWebhookInput): VerifiedStripeWebhookEvent {
  if (input.signature === undefined || input.signature.length === 0) {
    throw new InvalidStripeWebhookError('The Stripe-Signature header is required.');
  }
  if (!input.signingSecret.startsWith('whsec_')) {
    throw new Error('Stripe webhook verification requires a whsec_ signing secret.');
  }
  if (!Number.isSafeInteger(input.toleranceSeconds) || input.toleranceSeconds <= 0) {
    throw new Error('Stripe webhook tolerance must be a positive integer.');
  }

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(
      input.rawBody,
      input.signature,
      input.signingSecret,
      input.toleranceSeconds,
      undefined,
      input.receivedAtSeconds,
    );
  } catch {
    throw new InvalidStripeWebhookError('The Stripe signature or payload is invalid.');
  }

  if (event.id.length === 0 || event.type.length === 0) {
    throw new InvalidStripeWebhookError('The Stripe event envelope is invalid.');
  }
  const fingerprint = stripeEventFingerprint(event);
  if (!supportedEventType(event.type)) {
    return {
      eventId: event.id,
      eventType: event.type,
      eventFingerprint: fingerprint,
      supported: false,
    };
  }

  const dataObject: unknown = event.data.object;
  if (
    !isRecord(dataObject) ||
    typeof dataObject['id'] !== 'string' ||
    !dataObject['id'].startsWith('pi_')
  ) {
    throw new InvalidStripeWebhookError('The Stripe event does not identify a PaymentIntent.');
  }
  return {
    eventId: event.id,
    eventType: event.type,
    stripePaymentIntentId: dataObject['id'],
    eventFingerprint: fingerprint,
    supported: true,
  };
}
