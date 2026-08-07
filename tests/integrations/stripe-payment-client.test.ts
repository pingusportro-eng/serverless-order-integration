import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type { CreateStripePaymentIntentInput } from '../../src/application/stripe-payment-client.js';
import { asMerchantId, asOrderId } from '../../src/domain/order.js';
import {
  createStripePaymentClient,
  mapStripeClientError,
  stripePaymentIntentSnapshot,
  type StripeSdkClient,
} from '../../src/integrations/stripe-payment-client.js';

function input(): CreateStripePaymentIntentInput {
  return {
    merchantId: asMerchantId('mrc_stripe_adapter'),
    orderId: asOrderId('ord_stripe_adapter'),
    amount: { amountMinor: 2500, currency: 'RON' },
    stripeCreationKey: 'stripe-payment-intent:mrc_stripe_adapter:ord_stripe_adapter',
  };
}

function paymentIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_adapter_123',
    status: 'requires_payment_method',
    amount: 2500,
    currency: 'ron',
    capture_method: 'automatic',
    livemode: false,
    metadata: { merchantId: 'mrc_stripe_adapter', orderId: 'ord_stripe_adapter' },
    client_secret: 'pi_adapter_123_secret_synthetic',
    last_payment_error: null,
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

function sdkClient(options: {
  readonly createResult?: Stripe.PaymentIntent;
  readonly retrieveResult?: Stripe.PaymentIntent;
  readonly createError?: Error;
  readonly retrieveError?: Error;
}) {
  const create = vi.fn(
    (
      params: Stripe.PaymentIntentCreateParams,
      requestOptions?: Stripe.RequestOptions,
    ): Promise<Stripe.PaymentIntent> => {
      void params;
      void requestOptions;
      if (options.createError !== undefined) {
        return Promise.reject(options.createError);
      }
      return Promise.resolve(options.createResult ?? paymentIntent());
    },
  );
  const retrieve = vi.fn((id: string): Promise<Stripe.PaymentIntent> => {
    void id;
    if (options.retrieveError !== undefined) {
      return Promise.reject(options.retrieveError);
    }
    return Promise.resolve(options.retrieveResult ?? paymentIntent());
  });
  return {
    create,
    retrieve,
    client: { paymentIntents: { create, retrieve } } satisfies StripeSdkClient,
  };
}

function clientWithSdk(sdk: StripeSdkClient) {
  return createStripePaymentClient({
    apiKey: 'sk_test_synthetic_adapter_key',
    timeoutMs: 500,
    sdkClient: sdk,
  });
}

describe('Stripe payment client adapter', () => {
  it('creates an automatic PaymentIntent with server-owned data and the stable key', async () => {
    const sdk = sdkClient({});

    const result = await clientWithSdk(sdk.client).createPaymentIntent(input());

    expect(sdk.create).toHaveBeenCalledWith(
      {
        amount: 2500,
        currency: 'ron',
        capture_method: 'automatic',
        automatic_payment_methods: { enabled: true },
        metadata: { merchantId: 'mrc_stripe_adapter', orderId: 'ord_stripe_adapter' },
      },
      { idempotencyKey: 'stripe-payment-intent:mrc_stripe_adapter:ord_stripe_adapter' },
    );
    expect(result).toEqual({
      stripePaymentIntentId: 'pi_adapter_123',
      status: 'REQUIRES_PAYMENT_METHOD',
      amount: { amountMinor: 2500, currency: 'RON' },
      captureMethod: 'AUTOMATIC',
      merchantId: 'mrc_stripe_adapter',
      orderId: 'ord_stripe_adapter',
      clientSecret: 'pi_adapter_123_secret_synthetic',
    });
  });

  it('retrieves current state without sending a creation key', async () => {
    const sdk = sdkClient({ retrieveResult: paymentIntent({ status: 'processing' }) });

    const result = await clientWithSdk(sdk.client).retrievePaymentIntent('pi_adapter_123');

    expect(sdk.retrieve).toHaveBeenCalledWith('pi_adapter_123');
    expect(result.status).toBe('PROCESSING');
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each([
    ['requires_payment_method', 'REQUIRES_PAYMENT_METHOD'],
    ['requires_confirmation', 'REQUIRES_CONFIRMATION'],
    ['requires_action', 'REQUIRES_ACTION'],
    ['processing', 'PROCESSING'],
    ['succeeded', 'SUCCEEDED'],
    ['canceled', 'CANCELLED'],
  ] as const)('maps Stripe status %s to %s', (stripeStatus, domainStatus) => {
    expect(stripePaymentIntentSnapshot(paymentIntent({ status: stripeStatus })).status).toBe(
      domainStatus,
    );
  });

  it('keeps only a safe payment failure reason', () => {
    expect(
      stripePaymentIntentSnapshot(
        paymentIntent({
          last_payment_error: {
            type: 'card_error',
            code: 'card_declined',
          },
        }),
      ).lastFailureReasonCode,
    ).toBe('card_declined');
    expect(
      stripePaymentIntentSnapshot(
        paymentIntent({
          last_payment_error: {
            type: 'bad reason containing spaces and unsafe content',
          } as unknown as Stripe.PaymentIntent.LastPaymentError,
        }),
      ).lastFailureReasonCode,
    ).toBe('UNKNOWN_PAYMENT_ERROR');
  });

  it.each([
    paymentIntent({ status: 'requires_capture' }),
    paymentIntent({ capture_method: 'manual' }),
    paymentIntent({ livemode: true }),
    paymentIntent({ metadata: {} }),
  ])('rejects a PaymentIntent that violates the reviewed contract', (stripeIntent) => {
    expect(() => stripePaymentIntentSnapshot(stripeIntent)).toThrow(
      expect.objectContaining({ code: 'CONTRACT_MISMATCH', retryable: false }),
    );
  });

  it.each([
    paymentIntent({ amount: 0 }),
    paymentIntent({ currency: 'invalid' }),
    paymentIntent({ id: '' }),
    paymentIntent({ client_secret: '' }),
    paymentIntent({ status: 'future_status' as Stripe.PaymentIntent.Status }),
  ])('rejects an unusable Stripe response as retryable', (stripeIntent) => {
    expect(() => stripePaymentIntentSnapshot(stripeIntent)).toThrow(
      expect.objectContaining({ code: 'INVALID_RESPONSE', retryable: true }),
    );
  });

  it('maps rate limiting with bounded retry and safe request evidence', () => {
    const error = new Stripe.errors.StripeRateLimitError({
      type: 'rate_limit_error',
      message: 'raw Stripe message',
      statusCode: 429,
      headers: { 'retry-after': '120' },
      requestId: 'req_safe_123',
    });

    expect(mapStripeClientError(error)).toEqual(
      expect.objectContaining({
        code: 'RATE_LIMITED',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 60_000,
        stripeRequestId: 'req_safe_123',
        message: 'Stripe rate limit exceeded.',
      }),
    );
  });

  it.each([
    [
      new Stripe.errors.StripeConnectionError({
        type: 'api_error',
        message: 'timeout',
        code: 'ETIMEDOUT',
      }),
      'TIMEOUT',
      true,
    ],
    [
      new Stripe.errors.StripeConnectionError({
        type: 'api_error',
        message: 'connection',
      }),
      'NETWORK_ERROR',
      true,
    ],
    [
      new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'unavailable' }),
      'STRIPE_UNAVAILABLE',
      true,
    ],
    [
      new Stripe.errors.StripeAuthenticationError({
        type: 'authentication_error',
        message: 'secret detail',
      }),
      'AUTHENTICATION_FAILED',
      false,
    ],
    [
      new Stripe.errors.StripeIdempotencyError({
        type: 'idempotency_error',
        message: 'conflict detail',
      }),
      'IDEMPOTENCY_CONFLICT',
      false,
    ],
    [
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'request detail',
        statusCode: 400,
      }),
      'REQUEST_REJECTED',
      false,
    ],
    [
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'missing detail',
        statusCode: 404,
      }),
      'NOT_FOUND',
      false,
    ],
  ] as const)('maps an SDK failure to safe code %s', (stripeError, code, retryable) => {
    expect(mapStripeClientError(stripeError)).toMatchObject({ code, retryable });
    expect(mapStripeClientError(stripeError).message).not.toContain('detail');
  });

  it('maps errors thrown by an injected SDK and never exposes its raw message', async () => {
    const sdk = sdkClient({
      createError: new Stripe.errors.StripeAPIError({
        type: 'api_error',
        message: 'raw provider response must stay internal',
      }),
    });

    await expect(clientWithSdk(sdk.client).createPaymentIntent(input())).rejects.toMatchObject({
      code: 'STRIPE_UNAVAILABLE',
      retryable: true,
      message: 'Stripe is temporarily unavailable.',
    });
  });

  it('refuses live keys and invalid timeouts before constructing an adapter', () => {
    expect(() =>
      createStripePaymentClient({ apiKey: 'sk_live_forbidden', timeoutMs: 500 }),
    ).toThrow('Sandbox secret key');
    expect(() => createStripePaymentClient({ apiKey: 'sk_test_synthetic', timeoutMs: 0 })).toThrow(
      'positive integer',
    );
  });
});
