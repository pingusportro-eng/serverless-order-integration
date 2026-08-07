import { createHash } from 'node:crypto';

import {
  assertStripePaymentIntentInput,
  StripeClientError,
  type CreateStripePaymentIntentInput,
  type StripePaymentClient,
  type StripePaymentIntentSnapshot,
} from '../application/stripe-payment-client.js';
import type { PaymentStatus } from '../domain/payment.js';

export const FAKE_STRIPE_SCENARIOS = [
  'requires-payment-method',
  'success',
  'timeout',
  'decline',
  'requires-action',
  'processing',
  'cancellation',
  'conflicting-data',
] as const;

export type FakeStripeScenario = (typeof FAKE_STRIPE_SCENARIOS)[number];

export interface FakeStripePaymentClientOptions {
  readonly scenarios?: readonly FakeStripeScenario[];
}

interface StoredFakePaymentIntent {
  readonly input: CreateStripePaymentIntentInput;
  snapshot: StripePaymentIntentSnapshot;
}

function fakePaymentIntentId(stripeCreationKey: string): string {
  return `pi_fake_${createHash('sha256').update(stripeCreationKey).digest('hex').slice(0, 24)}`;
}

function sameRequest(
  first: CreateStripePaymentIntentInput,
  second: CreateStripePaymentIntentInput,
): boolean {
  return (
    first.merchantId === second.merchantId &&
    first.orderId === second.orderId &&
    first.amount.amountMinor === second.amount.amountMinor &&
    first.amount.currency === second.amount.currency
  );
}

function scenarioStatus(scenario: FakeStripeScenario): PaymentStatus {
  switch (scenario) {
    case 'success':
      return 'SUCCEEDED';
    case 'requires-action':
      return 'REQUIRES_ACTION';
    case 'processing':
      return 'PROCESSING';
    case 'cancellation':
      return 'CANCELLED';
    case 'requires-payment-method':
    case 'timeout':
    case 'decline':
    case 'conflicting-data':
      return 'REQUIRES_PAYMENT_METHOD';
  }
}

export class FakeStripePaymentClient implements StripePaymentClient {
  readonly createCalls: CreateStripePaymentIntentInput[] = [];
  readonly retrieveCalls: string[] = [];
  private readonly scenarios: FakeStripeScenario[];
  private readonly byCreationKey = new Map<string, StoredFakePaymentIntent>();
  private readonly byPaymentIntentId = new Map<string, StoredFakePaymentIntent>();

  constructor(options: FakeStripePaymentClientOptions = {}) {
    this.scenarios = [...(options.scenarios ?? ['requires-payment-method'])];
  }

  async createPaymentIntent(
    input: CreateStripePaymentIntentInput,
  ): Promise<StripePaymentIntentSnapshot> {
    await Promise.resolve();
    assertStripePaymentIntentInput(input);
    this.createCalls.push(structuredClone(input));

    const existing = this.byCreationKey.get(input.stripeCreationKey);
    if (existing !== undefined) {
      if (!sameRequest(existing.input, input)) {
        throw new StripeClientError({
          code: 'IDEMPOTENCY_CONFLICT',
          retryable: false,
          message: 'Stripe rejected conflicting idempotency data.',
        });
      }
      return structuredClone(existing.snapshot);
    }

    const scenario = this.scenarios.shift() ?? 'requires-payment-method';
    const stripePaymentIntentId = fakePaymentIntentId(input.stripeCreationKey);
    const snapshot: StripePaymentIntentSnapshot = {
      stripePaymentIntentId,
      status: scenarioStatus(scenario),
      amount: structuredClone(input.amount),
      captureMethod: 'AUTOMATIC',
      merchantId:
        scenario === 'conflicting-data'
          ? (`${input.merchantId}-conflict` as typeof input.merchantId)
          : input.merchantId,
      orderId: input.orderId,
      clientSecret: `${stripePaymentIntentId}_secret_synthetic`,
      ...(scenario === 'decline' ? { lastFailureReasonCode: 'card_declined' } : {}),
    };
    const stored = { input: structuredClone(input), snapshot: structuredClone(snapshot) };
    this.byCreationKey.set(input.stripeCreationKey, stored);
    this.byPaymentIntentId.set(stripePaymentIntentId, stored);

    if (scenario === 'timeout') {
      throw new StripeClientError({
        code: 'TIMEOUT',
        retryable: true,
        message: 'Stripe request timed out with an uncertain result.',
      });
    }

    return structuredClone(snapshot);
  }

  async retrievePaymentIntent(stripePaymentIntentId: string): Promise<StripePaymentIntentSnapshot> {
    await Promise.resolve();
    this.retrieveCalls.push(stripePaymentIntentId);
    const stored = this.byPaymentIntentId.get(stripePaymentIntentId);
    if (stored === undefined) {
      throw new StripeClientError({
        code: 'NOT_FOUND',
        retryable: false,
        message: 'Stripe PaymentIntent was not found.',
        statusCode: 404,
      });
    }
    return structuredClone(stored.snapshot);
  }

  setPaymentIntentStatus(
    stripePaymentIntentId: string,
    status: PaymentStatus,
    lastFailureReasonCode?: string,
  ): void {
    const stored = this.byPaymentIntentId.get(stripePaymentIntentId);
    if (stored === undefined) {
      throw new Error('Fake Stripe PaymentIntent was not found.');
    }
    const snapshotWithoutFailure = { ...stored.snapshot };
    Reflect.deleteProperty(snapshotWithoutFailure, 'lastFailureReasonCode');
    stored.snapshot = {
      ...snapshotWithoutFailure,
      status,
      ...(lastFailureReasonCode === undefined ? {} : { lastFailureReasonCode }),
    };
  }
}
