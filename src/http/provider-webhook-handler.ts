import {
  processProviderWebhook,
  type ProcessProviderWebhookDependencies,
  type ProcessProviderWebhookResult,
} from '../application/process-provider-webhook.js';
import {
  ProviderEventIdConflictError,
  type ProviderWebhookRepository,
} from '../application/provider-webhook-repository.js';
import {
  validateProviderWebhookEvent,
  type ProviderWebhookEvent,
} from '../application/provider-webhook-validation.js';
import { OrderNotFoundError, OrderVersionConflictError } from '../application/order-repository.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import type { HttpResponse } from './response.js';
import { InvalidWebhookSignatureError, verifyWebhookSignature } from './webhook-signature.js';

export interface ProviderWebhookHandlerDependencies extends ProcessProviderWebhookDependencies {
  readonly repository: ProviderWebhookRepository;
  readonly signingSecret: string;
  readonly signatureToleranceSeconds: number;
}

export interface ProviderWebhookHttpRequest {
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

export type ProviderWebhookProcessingObservation = {
  readonly eventId: string;
  readonly eventType: ProviderWebhookEvent['eventType'];
  readonly orderId: string;
  readonly orderVersion: number;
  readonly outcome: ProcessProviderWebhookResult['outcome'];
};

export type ProviderWebhookHttpResponse = HttpResponse<undefined | ProblemDetails> & {
  readonly processing?: ProviderWebhookProcessingObservation;
};

function header(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  return entry?.[1];
}

function noContent(
  requestId: string,
  processing: ProviderWebhookProcessingObservation,
): ProviderWebhookHttpResponse {
  return {
    statusCode: 204,
    headers: { 'X-Request-Id': requestId },
    body: undefined,
    processing,
  };
}

function invalidSignature(requestId: string): ProviderWebhookHttpResponse {
  return problemResponse(
    {
      status: 401,
      code: 'INVALID_WEBHOOK_SIGNATURE',
      title: 'Invalid webhook signature',
      detail: 'The webhook signature or timestamp is absent, invalid, or expired.',
    },
    requestId,
  );
}

export async function handleProviderWebhook(
  dependencies: ProviderWebhookHandlerDependencies,
  request: ProviderWebhookHttpRequest,
): Promise<ProviderWebhookHttpResponse> {
  try {
    verifyWebhookSignature({
      secret: dependencies.signingSecret,
      rawBody: request.rawBody,
      timestamp: header(request.headers, 'X-Webhook-Timestamp'),
      signature: header(request.headers, 'X-Webhook-Signature'),
      toleranceSeconds: dependencies.signatureToleranceSeconds,
      now: (dependencies.now ?? (() => new Date()))(),
    });
  } catch (error: unknown) {
    if (error instanceof InvalidWebhookSignatureError) {
      return invalidSignature(request.requestId);
    }
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(request.rawBody) as unknown;
  } catch {
    return problemResponse(
      {
        status: 400,
        code: 'MALFORMED_REQUEST',
        title: 'Malformed request',
        detail: 'The request body must contain valid JSON.',
      },
      request.requestId,
    );
  }

  const validation = validateProviderWebhookEvent(body);
  if (!validation.valid) {
    return problemResponse(
      {
        status: 422,
        code: 'VALIDATION_ERROR',
        title: 'Request validation failed',
        detail: 'One or more webhook values are invalid.',
        errors: validation.issues,
      },
      request.requestId,
    );
  }

  try {
    const result = await processProviderWebhook(dependencies, {
      event: validation.value,
      correlationId: header(request.headers, 'X-Correlation-Id') ?? request.requestId,
    });
    return noContent(request.requestId, {
      eventId: validation.value.eventId,
      eventType: validation.value.eventType,
      orderId: result.order.orderId,
      orderVersion: result.order.version,
      outcome: result.outcome,
    });
  } catch (error: unknown) {
    if (error instanceof OrderNotFoundError) {
      return problemResponse(
        {
          status: 404,
          code: 'ORDER_NOT_FOUND',
          title: 'Order not found',
          detail: 'The delivery-provider order ID does not identify an order.',
        },
        request.requestId,
      );
    }
    if (error instanceof ProviderEventIdConflictError) {
      return problemResponse(
        {
          status: 409,
          code: 'EVENT_ID_CONFLICT',
          title: 'Provider event conflict',
          detail: error.message,
        },
        request.requestId,
      );
    }
    if (error instanceof OrderVersionConflictError) {
      return problemResponse(
        {
          status: 409,
          code: 'VERSION_MISMATCH',
          title: 'Concurrent order update',
          detail: 'The order changed repeatedly while the webhook was being processed.',
        },
        request.requestId,
      );
    }
    throw error;
  }
}
