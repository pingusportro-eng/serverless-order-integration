import { describe, expect, it } from 'vitest';

import {
  applyPaymentStatusChange,
  InvalidPaymentStatusDetailsError,
  InvalidPaymentStatusTransitionError,
} from '../../src/domain/payment-status-transition.js';
import {
  createInitialOrderPayment,
  isTerminalPaymentStatus,
  type OrderPayment,
  type PaymentStatus,
} from '../../src/domain/payment.js';

const createdAt = '2026-08-05T10:00:00.000Z';
const changedAt = '2026-08-05T10:01:00.000Z';

function initialPayment(): OrderPayment {
  return createInitialOrderPayment(
    { amountMinor: 2500, currency: 'RON' },
    'stripe-payment-intent:mrc_demo:ord_demo',
    createdAt,
  );
}

describe('payment status transition', () => {
  it.each<PaymentStatus>(['SUCCEEDED', 'CANCELLED'])('recognizes %s as terminal', (status) => {
    expect(isTerminalPaymentStatus(status)).toBe(true);
  });

  it.each<PaymentStatus>([
    'NOT_STARTED',
    'REQUIRES_PAYMENT_METHOD',
    'REQUIRES_CONFIRMATION',
    'REQUIRES_ACTION',
    'PROCESSING',
  ])('recognizes %s as non-terminal', (status) => {
    expect(isTerminalPaymentStatus(status)).toBe(false);
  });

  it('creates the reviewed initial payment snapshot', () => {
    expect(initialPayment()).toEqual({
      status: 'NOT_STARTED',
      amount: { amountMinor: 2500, currency: 'RON' },
      stripeCreationKey: 'stripe-payment-intent:mrc_demo:ord_demo',
      createdAt,
      updatedAt: createdAt,
    });
  });

  it('records one immutable PaymentIntent and preserves the server-owned amount and key', () => {
    const initial = initialPayment();

    const changed = applyPaymentStatusChange(
      initial,
      {
        targetStatus: 'REQUIRES_PAYMENT_METHOD',
        stripePaymentIntentId: 'pi_payment_123',
      },
      changedAt,
    );

    expect(changed).toMatchObject({
      status: 'REQUIRES_PAYMENT_METHOD',
      amount: initial.amount,
      stripeCreationKey: initial.stripeCreationKey,
      stripePaymentIntentId: 'pi_payment_123',
      updatedAt: changedAt,
    });
    expect(() =>
      applyPaymentStatusChange(
        changed,
        { targetStatus: 'PROCESSING', stripePaymentIntentId: 'pi_different' },
        changedAt,
      ),
    ).toThrow(InvalidPaymentStatusDetailsError);
  });

  it('records a safe decline and permits the same intent to succeed later', () => {
    const declined = applyPaymentStatusChange(
      initialPayment(),
      {
        targetStatus: 'REQUIRES_PAYMENT_METHOD',
        stripePaymentIntentId: 'pi_payment_123',
        lastFailure: { reasonCode: 'CARD_DECLINED', occurredAt: changedAt },
      },
      changedAt,
    );

    const succeeded = applyPaymentStatusChange(
      declined,
      { targetStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
      '2026-08-05T10:02:00.000Z',
    );

    expect(succeeded.status).toBe('SUCCEEDED');
    expect(succeeded.lastFailure).toEqual(declined.lastFailure);
  });

  it('keeps safe operator evidence independent of the current payment status', () => {
    const cancelled = applyPaymentStatusChange(
      initialPayment(),
      {
        targetStatus: 'CANCELLED',
        stripePaymentIntentId: 'pi_payment_123',
        lastFailure: {
          reasonCode: 'UNKNOWN_PAYMENT_ERROR',
          occurredAt: changedAt,
        },
      },
      changedAt,
    );

    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      lastFailure: {
        reasonCode: 'UNKNOWN_PAYMENT_ERROR',
        occurredAt: changedAt,
      },
    });
  });

  it('allows an authoritative retrieved Stripe state to skip intermediate local states', () => {
    const succeeded = applyPaymentStatusChange(
      initialPayment(),
      { targetStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
      changedAt,
    );

    expect(succeeded.status).toBe('SUCCEEDED');
  });

  it.each<Exclude<PaymentStatus, 'SUCCEEDED' | 'CANCELLED'>>([
    'NOT_STARTED',
    'REQUIRES_PAYMENT_METHOD',
    'REQUIRES_CONFIRMATION',
    'REQUIRES_ACTION',
    'PROCESSING',
  ])('allows authoritative Stripe reconciliation from non-terminal %s', (currentStatus) => {
    const payment: OrderPayment = {
      ...initialPayment(),
      status: currentStatus,
      ...(currentStatus === 'NOT_STARTED' ? {} : { stripePaymentIntentId: 'pi_payment_123' }),
    };

    for (const targetStatus of [
      'REQUIRES_PAYMENT_METHOD',
      'REQUIRES_CONFIRMATION',
      'REQUIRES_ACTION',
      'PROCESSING',
      'SUCCEEDED',
      'CANCELLED',
    ] as const) {
      expect(
        applyPaymentStatusChange(
          payment,
          { targetStatus, stripePaymentIntentId: 'pi_payment_123' },
          changedAt,
        ).status,
      ).toBe(targetStatus);
    }
  });

  it('makes success and cancellation terminal', () => {
    for (const terminalStatus of ['SUCCEEDED', 'CANCELLED'] as const) {
      const terminal = applyPaymentStatusChange(
        initialPayment(),
        { targetStatus: terminalStatus, stripePaymentIntentId: 'pi_payment_123' },
        changedAt,
      );

      expect(() =>
        applyPaymentStatusChange(
          terminal,
          {
            targetStatus: 'REQUIRES_PAYMENT_METHOD',
            stripePaymentIntentId: 'pi_payment_123',
          },
          '2026-08-05T10:02:00.000Z',
        ),
      ).toThrow(InvalidPaymentStatusTransitionError);
    }
  });

  it('returns the original value for an idempotent terminal replay', () => {
    const succeeded = applyPaymentStatusChange(
      initialPayment(),
      { targetStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
      changedAt,
    );

    expect(
      applyPaymentStatusChange(
        succeeded,
        { targetStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
        '2026-08-05T10:02:00.000Z',
      ),
    ).toBe(succeeded);
  });
});
