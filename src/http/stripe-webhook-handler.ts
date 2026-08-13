import {
  processStripeWebhook,
  type ProcessStripeWebhookDependencies,
  type ProcessStripeWebhookResult,
  type SupportedStripeWebhookEventType,
} from '../application/process-stripe-webhook.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import type { HttpResponse } from './response.js';
import { InvalidStripeWebhookError, verifyStripeWebhook } from './stripe-webhook-verification.js';

export interface StripeWebhookHandlerDependencies extends ProcessStripeWebhookDependencies {
  readonly signingSecret: string;
  readonly signatureToleranceSeconds: number;
}

export interface StripeWebhookHttpRequest {
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

export interface StripeWebhookProcessingObservation {
  readonly eventId: string;
  readonly eventType: SupportedStripeWebhookEventType;
  readonly stripePaymentIntentId: string;
  readonly orderId?: string;
  readonly orderVersion?: number;
  readonly outcome: ProcessStripeWebhookResult['outcome'];
  readonly reasonCode?: string;
  readonly reconciliationRecorded?: boolean;
}

export type StripeWebhookHttpResponse = HttpResponse<undefined | ProblemDetails> & {
  readonly processing?: StripeWebhookProcessingObservation;
};

function header(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  return Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  )?.[1];
}

function noContent(
  requestId: string,
  processing?: StripeWebhookProcessingObservation,
): StripeWebhookHttpResponse {
  return {
    statusCode: 204,
    headers: { 'X-Request-Id': requestId },
    body: undefined,
    ...(processing === undefined ? {} : { processing }),
  };
}

export async function handleStripeWebhook(
  dependencies: StripeWebhookHandlerDependencies,
  request: StripeWebhookHttpRequest,
): Promise<StripeWebhookHttpResponse> {
  let verified;
  try {
    verified = verifyStripeWebhook({
      rawBody: request.rawBody,
      signature: header(request.headers, 'Stripe-Signature'),
      signingSecret: dependencies.signingSecret,
      toleranceSeconds: dependencies.signatureToleranceSeconds,
      receivedAtSeconds: Math.floor((dependencies.now ?? (() => new Date()))().getTime() / 1000),
    });
  } catch (error: unknown) {
    if (error instanceof InvalidStripeWebhookError) {
      return problemResponse(
        {
          status: 400,
          code: 'INVALID_STRIPE_WEBHOOK',
          title: 'Invalid Stripe webhook',
          detail: 'The Stripe signature or payload is absent, malformed, invalid, or expired.',
        },
        request.requestId,
      );
    }
    throw error;
  }

  if (!verified.supported) {
    return noContent(request.requestId);
  }
  if (verified.stripePaymentIntentId === undefined) {
    throw new Error('A supported Stripe event must identify a PaymentIntent.');
  }

  const eventType = verified.eventType as SupportedStripeWebhookEventType;
  const result = await processStripeWebhook(dependencies, {
    eventId: verified.eventId,
    eventType,
    stripePaymentIntentId: verified.stripePaymentIntentId,
    eventFingerprint: verified.eventFingerprint,
    correlationId: request.requestId,
  });
  return noContent(request.requestId, {
    eventId: verified.eventId,
    eventType,
    stripePaymentIntentId: verified.stripePaymentIntentId,
    ...(result.order === undefined
      ? {}
      : { orderId: result.order.orderId, orderVersion: result.order.version }),
    outcome: result.outcome,
    ...('reasonCode' in result ? { reasonCode: result.reasonCode } : {}),
    ...('recorded' in result ? { reconciliationRecorded: result.recorded } : {}),
  });
}
