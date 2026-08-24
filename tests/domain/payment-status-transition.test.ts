import { describe, expect, it } from 'vitest';

import {
  applyPaymentStatusChange,
  InvalidPaymentStatusDetailsError,
  InvalidPaymentStatusTransitionError,
} from '../../src/domain/payment-status-transition.js';
import {
  createInitialOrderPayment,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
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

const PAYMENT_TARGET_STATUSES = PAYMENT_STATUSES.filter(
  (status): status is Exclude<PaymentStatus, 'NOT_STARTED'> => status !== 'NOT_STARTED',
);

const PAYMENT_TRANSITION_CASES = PAYMENT_STATUSES.flatMap((currentStatus) =>
  PAYMENT_TARGET_STATUSES.map((targetStatus) => ({ currentStatus, targetStatus })),
);

function paymentWithStatus(status: PaymentStatus): OrderPayment {
  const payment = initialPayment();
  return status === 'NOT_STARTED'
    ? payment
    : { ...payment, status, stripePaymentIntentId: 'pi_payment_123' };
}

describe('payment status transition', () => {
  it.each(PAYMENT_TRANSITION_CASES)(
    'enforces the complete $currentStatus -> $targetStatus matrix',
    ({ currentStatus, targetStatus }) => {
      const payment = paymentWithStatus(currentStatus);
      const change = { targetStatus, stripePaymentIntentId: 'pi_payment_123' };

      if (isTerminalPaymentStatus(currentStatus) && currentStatus !== targetStatus) {
        expect(() => applyPaymentStatusChange(payment, change, changedAt)).toThrow(
          InvalidPaymentStatusTransitionError,
        );
        return;
      }

      const changed = applyPaymentStatusChange(payment, change, changedAt);
      expect(changed.status).toBe(targetStatus);
      if (currentStatus === targetStatus) {
        expect(changed).toBe(payment);
      }
    },
  );

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
      {
        targetStatus: 'SUCCEEDED',
        stripePaymentIntentId: 'pi_payment_123',
        lastFailure: { reasonCode: 'CARD_DECLINED', occurredAt: changedAt },
      },
      changedAt,
    );

    expect(
      applyPaymentStatusChange(
        succeeded,
        {
          targetStatus: 'SUCCEEDED',
          stripePaymentIntentId: 'pi_payment_123',
          lastFailure: { reasonCode: 'CARD_DECLINED', occurredAt: changedAt },
        },
        '2026-08-05T10:00:30.000Z',
      ),
    ).toBe(succeeded);
  });

  it('rejects a new payment value that would move its update time backwards', () => {
    const processing = applyPaymentStatusChange(
      initialPayment(),
      { targetStatus: 'PROCESSING', stripePaymentIntentId: 'pi_payment_123' },
      '2026-08-05T10:03:00.000Z',
    );

    expect(() =>
      applyPaymentStatusChange(
        processing,
        { targetStatus: 'REQUIRES_ACTION', stripePaymentIntentId: 'pi_payment_123' },
        '2026-08-05T10:02:00.000Z',
      ),
    ).toThrow('before the previous payment update');
    expect(processing).toMatchObject({
      status: 'PROCESSING',
      updatedAt: '2026-08-05T10:03:00.000Z',
    });
  });
});
