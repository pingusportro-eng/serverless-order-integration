import { OrderNotFoundError } from '../application/order-repository.js';
import { StripePaymentIntentBindingConflictError } from '../application/payment-repository.js';
import {
  PaymentPreparationNotAllowedError,
  prepareStripePaymentIntent,
  type PrepareStripePaymentIntentDependencies,
  StripePaymentIntentContractError,
} from '../application/prepare-stripe-payment-intent.js';
import { StripeClientError } from '../application/stripe-payment-client.js';
import { asOrderId, type MerchantId, type Money } from '../domain/order.js';
import type { PaymentStatus } from '../domain/payment.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import { successResponse, type HttpResponse } from './response.js';

const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{8,60}$/;

export interface PrepareStripePaymentIntentHttpRequest {
  readonly merchantId: MerchantId;
  readonly requestId: string;
  readonly orderId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface PreparedStripePaymentIntentRepresentation {
  readonly orderId: string;
  readonly orderVersion: number;
  readonly stripePaymentIntentId: string;
  readonly status: Exclude<PaymentStatus, 'NOT_STARTED'>;
  readonly amount: Money;
  readonly clientSecret: string;
}

export type PrepareStripePaymentIntentHttpResponse = HttpResponse<
  PreparedStripePaymentIntentRepresentation | ProblemDetails
>;

function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  return entry?.[1];
}

function notFoundResponse(requestId: string): PrepareStripePaymentIntentHttpResponse {
  return problemResponse(
    {
      status: 404,
      code: 'ORDER_NOT_FOUND',
      title: 'Order not found',
      detail: 'The order does not exist or is not visible to this merchant.',
    },
    requestId,
  );
}

function retryAfterHeader(error: StripeClientError): Readonly<Record<string, string>> {
  if (error.retryAfterMs === undefined) {
    return {};
  }
  return { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) };
}

export async function handlePrepareStripePaymentIntent(
  dependencies: PrepareStripePaymentIntentDependencies,
  request: PrepareStripePaymentIntentHttpRequest,
): Promise<PrepareStripePaymentIntentHttpResponse> {
  if (!ORDER_ID_PATTERN.test(request.orderId)) {
    return notFoundResponse(request.requestId);
  }

  try {
    const result = await prepareStripePaymentIntent(dependencies, {
      merchantId: request.merchantId,
      orderId: asOrderId(request.orderId),
      correlationId: readHeader(request.headers, 'X-Correlation-Id') ?? request.requestId,
      causationId: request.requestId,
    });
    const clientSecret = result.stripePaymentIntent.clientSecret;
    const status = result.stripePaymentIntent.status;
    if (clientSecret === undefined) {
      throw new StripePaymentIntentContractError('clientSecret');
    }
    if (status === 'NOT_STARTED') {
      throw new StripePaymentIntentContractError('status');
    }

    return successResponse(
      result.outcome === 'created' ? 201 : 200,
      {
        orderId: result.order.orderId,
        orderVersion: result.order.version,
        stripePaymentIntentId: result.stripePaymentIntent.stripePaymentIntentId,
        status,
        amount: result.stripePaymentIntent.amount,
        clientSecret,
      },
      request.requestId,
      {
        'Cache-Control': 'no-store',
        ETag: `"${String(result.order.version)}"`,
      },
    );
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      return notFoundResponse(request.requestId);
    }
    if (error instanceof PaymentPreparationNotAllowedError) {
      return problemResponse(
        {
          status: 409,
          code: 'PAYMENT_PREPARATION_NOT_ALLOWED',
          title: 'Payment preparation not allowed',
          detail: error.message,
        },
        request.requestId,
      );
    }
    if (error instanceof StripePaymentIntentBindingConflictError) {
      return problemResponse(
        {
          status: 409,
          code: 'PAYMENT_INTENT_CONFLICT',
          title: 'PaymentIntent conflict',
          detail: 'The order has a conflicting Stripe PaymentIntent binding.',
        },
        request.requestId,
      );
    }
    if (error instanceof StripePaymentIntentContractError) {
      return problemResponse(
        {
          status: 502,
          code: 'PAYMENT_PROVIDER_ERROR',
          title: 'Payment provider response rejected',
          detail: 'Stripe returned a response that did not match the expected payment contract.',
        },
        request.requestId,
      );
    }
    if (error instanceof StripeClientError) {
      if (error.retryable) {
        return problemResponse(
          {
            status: 503,
            code: 'PAYMENT_PROVIDER_UNAVAILABLE',
            title: 'Payment provider temporarily unavailable',
            detail: 'Payment preparation can be retried safely.',
            headers: retryAfterHeader(error),
          },
          request.requestId,
        );
      }
      return problemResponse(
        {
          status: 502,
          code: 'PAYMENT_PROVIDER_ERROR',
          title: 'Payment provider request failed',
          detail: 'Stripe rejected or could not complete the payment preparation request.',
        },
        request.requestId,
      );
    }
    throw error;
  }
}
