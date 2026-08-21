import Stripe from 'stripe';

import {
  assertStripePaymentIntentInput,
  STRIPE_APPLICATION_METADATA_NAMESPACE,
  StripeClientError,
  type CreateStripePaymentIntentInput,
  type StripeClientErrorOptions,
  type StripePaymentClient,
  type StripePaymentIntentSnapshot,
} from '../application/stripe-payment-client.js';
import { asMerchantId, asOrderId } from '../domain/order.js';
import type { PaymentStatus } from '../domain/payment.js';

interface StripePaymentIntentsApi {
  create(
    params: Stripe.PaymentIntentCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.PaymentIntent>;
  retrieve(stripePaymentIntentId: string): Promise<Stripe.PaymentIntent>;
}

export interface StripeSdkClient {
  readonly paymentIntents: StripePaymentIntentsApi;
}

export interface CreateStripePaymentClientOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly sdkClient?: StripeSdkClient;
}

const MAX_RETRY_AFTER_MS = 60_000;
const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractMismatch(message: string): StripeClientError {
  return new StripeClientError({ code: 'CONTRACT_MISMATCH', retryable: false, message });
}

function paymentStatus(status: string): PaymentStatus {
  switch (status) {
    case 'requires_payment_method':
      return 'REQUIRES_PAYMENT_METHOD';
    case 'requires_confirmation':
      return 'REQUIRES_CONFIRMATION';
    case 'requires_action':
      return 'REQUIRES_ACTION';
    case 'processing':
      return 'PROCESSING';
    case 'succeeded':
      return 'SUCCEEDED';
    case 'canceled':
      return 'CANCELLED';
    case 'requires_capture':
      throw contractMismatch('Stripe returned a manual-capture PaymentIntent.');
    default:
      throw new StripeClientError({
        code: 'INVALID_RESPONSE',
        retryable: true,
        message: 'Stripe returned an unsupported PaymentIntent status.',
      });
  }
}

function failureReasonCode(paymentIntent: Stripe.PaymentIntent): string | undefined {
  const paymentError = paymentIntent.last_payment_error;
  if (paymentError === null) {
    return undefined;
  }
  const reasonCode = paymentError.code ?? paymentError.decline_code ?? paymentError.type;
  return SAFE_REASON_CODE.test(reasonCode) ? reasonCode : 'UNKNOWN_PAYMENT_ERROR';
}

export function stripePaymentIntentSnapshot(
  paymentIntent: Stripe.PaymentIntent,
): StripePaymentIntentSnapshot {
  if (paymentIntent.livemode) {
    throw contractMismatch('A live-mode Stripe PaymentIntent is not allowed in this lab.');
  }
  if (paymentIntent.capture_method !== 'automatic') {
    throw contractMismatch('Stripe PaymentIntent capture mode must be automatic.');
  }
  if (!Number.isSafeInteger(paymentIntent.amount) || paymentIntent.amount <= 0) {
    throw new StripeClientError({
      code: 'INVALID_RESPONSE',
      retryable: true,
      message: 'Stripe returned an invalid PaymentIntent amount.',
    });
  }
  if (!/^[a-z]{3}$/.test(paymentIntent.currency)) {
    throw new StripeClientError({
      code: 'INVALID_RESPONSE',
      retryable: true,
      message: 'Stripe returned an invalid PaymentIntent currency.',
    });
  }
  const merchantId = paymentIntent.metadata['merchantId'];
  const orderId = paymentIntent.metadata['orderId'];
  if (
    merchantId === undefined ||
    merchantId.length === 0 ||
    orderId === undefined ||
    orderId.length === 0
  ) {
    throw contractMismatch('Stripe PaymentIntent ownership metadata is missing.');
  }
  if (paymentIntent.id.length === 0) {
    throw new StripeClientError({
      code: 'INVALID_RESPONSE',
      retryable: true,
      message: 'Stripe returned an invalid PaymentIntent ID.',
    });
  }
  if (paymentIntent.client_secret !== null && paymentIntent.client_secret.length === 0) {
    throw new StripeClientError({
      code: 'INVALID_RESPONSE',
      retryable: true,
      message: 'Stripe returned an invalid PaymentIntent client secret.',
    });
  }

  const reasonCode = failureReasonCode(paymentIntent);
  return {
    stripePaymentIntentId: paymentIntent.id,
    status: paymentStatus(paymentIntent.status),
    amount: {
      amountMinor: paymentIntent.amount,
      currency: paymentIntent.currency.toUpperCase(),
    },
    captureMethod: 'AUTOMATIC',
    merchantId: asMerchantId(merchantId),
    orderId: asOrderId(orderId),
    ...(paymentIntent.client_secret === null ? {} : { clientSecret: paymentIntent.client_secret }),
    ...(reasonCode === undefined ? {} : { lastFailureReasonCode: reasonCode }),
  };
}

function retryAfterMs(error: Stripe.errors.StripeError): number | undefined {
  const rawValue = error.headers?.['retry-after'];
  if (rawValue === undefined) {
    return undefined;
  }
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
}

function errorOptions(
  error: Stripe.errors.StripeError,
  options: Omit<StripeClientErrorOptions, 'statusCode' | 'stripeRequestId'>,
): StripeClientErrorOptions {
  return {
    ...options,
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.requestId === undefined ? {} : { stripeRequestId: error.requestId }),
  };
}

function isTimeout(error: Stripe.errors.StripeConnectionError): boolean {
  const detail = error.detail;
  return (
    (isRecord(detail) &&
      (detail['code'] === 'ETIMEDOUT' || detail['code'] === 'ESOCKETTIMEDOUT')) ||
    error.code === 'ETIMEDOUT'
  );
}

export function mapStripeClientError(error: unknown): StripeClientError {
  if (error instanceof StripeClientError) {
    return error;
  }
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    const retryAfter = retryAfterMs(error);
    return new StripeClientError({
      ...errorOptions(error, {
        code: 'RATE_LIMITED',
        retryable: true,
        message: 'Stripe rate limit exceeded.',
      }),
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    });
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    const timeout = isTimeout(error);
    return new StripeClientError(
      errorOptions(error, {
        code: timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        retryable: true,
        message: timeout
          ? 'Stripe request timed out with an uncertain result.'
          : 'Stripe could not be reached.',
      }),
    );
  }
  if (error instanceof Stripe.errors.StripeAPIError) {
    return new StripeClientError(
      errorOptions(error, {
        code: 'STRIPE_UNAVAILABLE',
        retryable: true,
        message: 'Stripe is temporarily unavailable.',
      }),
    );
  }
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return new StripeClientError(
      errorOptions(error, {
        code: 'AUTHENTICATION_FAILED',
        retryable: false,
        message: 'Stripe authentication failed.',
      }),
    );
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return new StripeClientError(
      errorOptions(error, {
        code: 'IDEMPOTENCY_CONFLICT',
        retryable: false,
        message: 'Stripe rejected conflicting idempotency data.',
      }),
    );
  }
  if (
    error instanceof Stripe.errors.StripeInvalidRequestError ||
    error instanceof Stripe.errors.StripeCardError
  ) {
    const code = error.statusCode === 404 ? 'NOT_FOUND' : 'REQUEST_REJECTED';
    return new StripeClientError(
      errorOptions(error, {
        code,
        retryable: false,
        message:
          code === 'NOT_FOUND'
            ? 'Stripe PaymentIntent was not found.'
            : 'Stripe rejected the PaymentIntent request.',
      }),
    );
  }
  if (error instanceof Stripe.errors.StripeError) {
    return new StripeClientError(
      errorOptions(error, {
        code: 'INVALID_RESPONSE',
        retryable: true,
        message: 'Stripe returned an unexpected error.',
      }),
    );
  }
  return new StripeClientError({
    code: 'INVALID_RESPONSE',
    retryable: true,
    message: 'Stripe client returned an unexpected error.',
  });
}

export function createStripePaymentClient(
  options: CreateStripePaymentClientOptions,
): StripePaymentClient {
  if (!options.apiKey.startsWith('sk_test_')) {
    throw new Error('Stripe client requires a Sandbox secret key beginning with sk_test_.');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Stripe timeout must be a positive integer.');
  }
  const stripe =
    options.sdkClient ??
    new Stripe(options.apiKey, { timeout: options.timeoutMs, maxNetworkRetries: 0 });

  return {
    async createPaymentIntent(
      input: CreateStripePaymentIntentInput,
    ): Promise<StripePaymentIntentSnapshot> {
      assertStripePaymentIntentInput(input);
      try {
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: input.amount.amountMinor,
            currency: input.amount.currency.toLowerCase(),
            capture_method: 'automatic',
            automatic_payment_methods: { enabled: true },
            metadata: {
              application: STRIPE_APPLICATION_METADATA_NAMESPACE,
              merchantId: input.merchantId,
              orderId: input.orderId,
            },
          },
          { idempotencyKey: input.stripeCreationKey },
        );
        return stripePaymentIntentSnapshot(paymentIntent);
      } catch (error: unknown) {
        throw mapStripeClientError(error);
      }
    },

    async retrievePaymentIntent(
      stripePaymentIntentId: string,
    ): Promise<StripePaymentIntentSnapshot> {
      if (stripePaymentIntentId.length === 0) {
        throw new TypeError('Stripe PaymentIntent ID must not be empty.');
      }
      try {
        const snapshot = stripePaymentIntentSnapshot(
          await stripe.paymentIntents.retrieve(stripePaymentIntentId),
        );
        if (snapshot.stripePaymentIntentId !== stripePaymentIntentId) {
          throw contractMismatch('Stripe returned a different PaymentIntent than requested.');
        }
        return snapshot;
      } catch (error: unknown) {
        throw mapStripeClientError(error);
      }
    },
  };
}
