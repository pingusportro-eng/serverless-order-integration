import type { MerchantId, Money, OrderId } from '../domain/order.js';
import type { PaymentStatus } from '../domain/payment.js';

export const STRIPE_APPLICATION_METADATA_NAMESPACE = 'serverless-order-integration';

export interface CreateStripePaymentIntentInput {
  readonly merchantId: MerchantId;
  readonly orderId: OrderId;
  readonly amount: Money;
  readonly stripeCreationKey: string;
}

export interface StripePaymentIntentSnapshot {
  readonly stripePaymentIntentId: string;
  readonly status: PaymentStatus;
  readonly amount: Money;
  readonly captureMethod: 'AUTOMATIC';
  readonly merchantId: MerchantId;
  readonly orderId: OrderId;
  readonly clientSecret?: string;
  readonly lastFailureReasonCode?: string;
}

export interface StripePaymentClient {
  createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntentSnapshot>;
  retrievePaymentIntent(stripePaymentIntentId: string): Promise<StripePaymentIntentSnapshot>;
}

export const STRIPE_CLIENT_FAILURE_CODES = [
  'TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'STRIPE_UNAVAILABLE',
  'AUTHENTICATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'REQUEST_REJECTED',
  'NOT_FOUND',
  'INVALID_RESPONSE',
  'CONTRACT_MISMATCH',
] as const;

export type StripeClientFailureCode = (typeof STRIPE_CLIENT_FAILURE_CODES)[number];

export interface StripeClientErrorOptions {
  readonly code: StripeClientFailureCode;
  readonly retryable: boolean;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly stripeRequestId?: string;
}

export class StripeClientError extends Error {
  override readonly name = 'StripeClientError';
  readonly code: StripeClientFailureCode;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly stripeRequestId?: string;

  constructor(options: StripeClientErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.stripeRequestId !== undefined) {
      this.stripeRequestId = options.stripeRequestId;
    }
  }
}

export function assertStripePaymentIntentInput(input: CreateStripePaymentIntentInput): void {
  if (!Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor <= 0) {
    throw new RangeError('Stripe PaymentIntent amount must be a positive safe integer.');
  }
  if (!/^[A-Z]{3}$/.test(input.amount.currency)) {
    throw new TypeError('Stripe PaymentIntent currency must use three uppercase letters.');
  }
  if (input.merchantId.length === 0 || input.orderId.length === 0) {
    throw new TypeError('Stripe PaymentIntent ownership identifiers must not be empty.');
  }
  if (input.stripeCreationKey.length === 0 || input.stripeCreationKey.length > 255) {
    throw new TypeError('Stripe creation key must contain between 1 and 255 characters.');
  }
}
