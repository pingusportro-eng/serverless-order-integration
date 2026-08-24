import { describe, expect, it } from 'vitest';

import {
  applyOrderStatusChange,
  InvalidOrderStatusDetailsError,
  InvalidOrderStatusTransitionError,
  type OrderStatusChange,
} from '../../src/domain/order-status-transition.js';
import { ORDER_STATUSES, type OrderStatus } from '../../src/domain/order-status.js';
import type { Order } from '../../src/domain/order.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { applyPaymentStatusChange } from '../../src/domain/payment-status-transition.js';
import { createOrderFixture } from '../fixtures/order.js';

const changedAt = '2026-07-22T10:00:00.000Z';

const ALLOWED_TRANSITIONS = {
  AWAITING_PAYMENT: ['PENDING_SUBMISSION', 'CANCELLED'],
  PENDING_SUBMISSION: ['SUBMITTED', 'SUBMISSION_FAILED', 'CANCELLED'],
  SUBMISSION_FAILED: ['PENDING_SUBMISSION', 'CANCELLED'],
  SUBMITTED: ['PICKED_UP', 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'],
  PICKED_UP: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED: [],
  DELIVERY_FAILED: [],
  CANCELLED: [],
} as const satisfies Readonly<Record<OrderStatus, readonly OrderStatus[]>>;

function completedPayment(status: 'SUCCEEDED' | 'CANCELLED') {
  return applyPaymentStatusChange(
    createInitialOrderPayment(
      { amountMinor: 2500, currency: 'RON' },
      'stripe-payment-intent:mrc_demo:ord_demo',
      '2026-07-22T09:00:00.000Z',
    ),
    { targetStatus: status, stripePaymentIntentId: 'pi_payment_123' },
    '2026-07-22T09:30:00.000Z',
  );
}

function orderForTransition(currentStatus: OrderStatus, targetStatus: OrderStatus): Order {
  const base = createOrderFixture();
  const providerAccepted =
    currentStatus === 'SUBMITTED' ||
    currentStatus === 'PICKED_UP' ||
    currentStatus === 'DELIVERED' ||
    currentStatus === 'DELIVERY_FAILED';

  return createOrderFixture({
    status: currentStatus,
    ...(currentStatus === 'AWAITING_PAYMENT'
      ? { payment: completedPayment(targetStatus === 'CANCELLED' ? 'CANCELLED' : 'SUCCEEDED') }
      : {}),
    ...(providerAccepted
      ? {
          provider: {
            ...base.provider,
            deliveryProviderOrderId: 'provider-matrix',
            acceptedAt: '2026-07-22T09:30:00.000Z',
          },
        }
      : {}),
    ...(currentStatus === 'SUBMISSION_FAILED'
      ? {
          failure: {
            stage: 'SUBMISSION' as const,
            reasonCode: 'PROVIDER_REJECTED',
            summary: 'The provider rejected the submission.',
            occurredAt: '2026-07-22T09:30:00.000Z',
          },
        }
      : {}),
    ...(currentStatus === 'DELIVERY_FAILED'
      ? {
          failure: {
            stage: 'DELIVERY' as const,
            reasonCode: 'DELIVERY_FAILED',
            summary: 'The accepted delivery failed.',
            occurredAt: '2026-07-22T09:30:00.000Z',
          },
        }
      : {}),
  });
}

function changeForTransition(targetStatus: OrderStatus): OrderStatusChange {
  if (targetStatus === 'SUBMITTED') {
    return { targetStatus, deliveryProviderOrderId: 'provider-matrix' };
  }
  if (targetStatus === 'SUBMISSION_FAILED') {
    return {
      targetStatus,
      failure: {
        stage: 'SUBMISSION',
        reasonCode: 'PROVIDER_REJECTED',
        summary: 'The provider rejected the submission.',
        occurredAt: changedAt,
      },
    };
  }
  if (targetStatus === 'DELIVERY_FAILED') {
    return {
      targetStatus,
      failure: {
        stage: 'DELIVERY',
        reasonCode: 'DELIVERY_FAILED',
        summary: 'The accepted delivery failed.',
        occurredAt: changedAt,
      },
    };
  }
  return { targetStatus };
}

const ORDER_TRANSITION_CASES = ORDER_STATUSES.flatMap((currentStatus) =>
  ORDER_STATUSES.map((targetStatus) => ({ currentStatus, targetStatus })),
);

describe('order status transition', () => {
  it.each(ORDER_TRANSITION_CASES)(
    'enforces the complete $currentStatus -> $targetStatus matrix',
    ({ currentStatus, targetStatus }) => {
      const order = orderForTransition(currentStatus, targetStatus);
      const change = changeForTransition(targetStatus);

      if (currentStatus === targetStatus) {
        expect(applyOrderStatusChange(order, change, changedAt)).toBe(order);
        return;
      }

      if (ALLOWED_TRANSITIONS[currentStatus].some((status) => status === targetStatus)) {
        expect(applyOrderStatusChange(order, change, changedAt)).toMatchObject({
          status: targetStatus,
          version: order.version + 1,
        });
        return;
      }

      expect(() => applyOrderStatusChange(order, change, changedAt)).toThrow(
        InvalidOrderStatusTransitionError,
      );
    },
  );

  it('opens delivery only after payment is durably successful', () => {
    const payment = applyPaymentStatusChange(
      createInitialOrderPayment(
        { amountMinor: 2500, currency: 'RON' },
        'stripe-payment-intent:mrc_demo:ord_demo',
        '2026-07-22T09:00:00.000Z',
      ),
      { targetStatus: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
      '2026-07-22T09:30:00.000Z',
    );
    const order = createOrderFixture({ status: 'AWAITING_PAYMENT', payment });

    const changed = applyOrderStatusChange(
      order,
      { targetStatus: 'PENDING_SUBMISSION' },
      changedAt,
    );

    expect(changed).toMatchObject({
      status: 'PENDING_SUBMISSION',
      payment: { status: 'SUCCEEDED', stripePaymentIntentId: 'pi_payment_123' },
      version: 2,
    });
  });

  it('rejects delivery eligibility before payment success', () => {
    const payment = createInitialOrderPayment(
      { amountMinor: 2500, currency: 'RON' },
      'stripe-payment-intent:mrc_demo:ord_demo',
      '2026-07-22T09:00:00.000Z',
    );
    const order = createOrderFixture({ status: 'AWAITING_PAYMENT', payment });

    expect(() =>
      applyOrderStatusChange(order, { targetStatus: 'PENDING_SUBMISSION' }, changedAt),
    ).toThrow(InvalidOrderStatusDetailsError);
  });

  it('allows awaiting-payment cancellation only after payment cancellation is recorded', () => {
    const initialPayment = createInitialOrderPayment(
      { amountMinor: 2500, currency: 'RON' },
      'stripe-payment-intent:mrc_demo:ord_demo',
      '2026-07-22T09:00:00.000Z',
    );
    const awaiting = createOrderFixture({
      status: 'AWAITING_PAYMENT',
      payment: initialPayment,
    });

    expect(() =>
      applyOrderStatusChange(awaiting, { targetStatus: 'CANCELLED' }, changedAt),
    ).toThrow(InvalidOrderStatusDetailsError);

    const cancelledPayment = applyPaymentStatusChange(
      initialPayment,
      { targetStatus: 'CANCELLED', stripePaymentIntentId: 'pi_payment_123' },
      '2026-07-22T09:30:00.000Z',
    );
    const changed = applyOrderStatusChange(
      { ...awaiting, payment: cancelledPayment },
      { targetStatus: 'CANCELLED' },
      changedAt,
    );

    expect(changed).toMatchObject({ status: 'CANCELLED', payment: { status: 'CANCELLED' } });
  });

  it('confirms provider submission atomically', () => {
    const order = createOrderFixture();

    const changed = applyOrderStatusChange(
      order,
      { targetStatus: 'SUBMITTED', deliveryProviderOrderId: 'provider-123' },
      changedAt,
    );

    expect(changed).toMatchObject({
      status: 'SUBMITTED',
      provider: {
        deliveryProviderOrderId: 'provider-123',
        acceptedAt: changedAt,
        deliveryProviderSubmissionKey: order.provider.deliveryProviderSubmissionKey,
      },
      updatedAt: changedAt,
      version: 2,
    });
  });

  it('returns the original aggregate for an idempotent no-op', () => {
    const order = createOrderFixture();

    const unchanged = applyOrderStatusChange(
      order,
      { targetStatus: 'PENDING_SUBMISSION' },
      changedAt,
    );

    expect(unchanged).toBe(order);
    expect(unchanged.version).toBe(1);
  });

  it('clears a submission failure during an approved retry', () => {
    const failedOrder = createOrderFixture({
      status: 'SUBMISSION_FAILED',
      failure: {
        stage: 'SUBMISSION',
        reasonCode: 'PROVIDER_REJECTED',
        summary: 'The mock provider rejected the request.',
        occurredAt: '2026-07-22T09:00:00.000Z',
      },
    });

    const changed = applyOrderStatusChange(
      failedOrder,
      { targetStatus: 'PENDING_SUBMISSION' },
      changedAt,
    );

    expect(changed.status).toBe('PENDING_SUBMISSION');
    expect(changed).not.toHaveProperty('failure');
    expect(changed.provider.deliveryProviderSubmissionKey).toBe(
      failedOrder.provider.deliveryProviderSubmissionKey,
    );
  });

  it('rejects transitions out of a terminal state without mutation', () => {
    const deliveredOrder = createOrderFixture({
      status: 'DELIVERED',
      provider: {
        ...createOrderFixture().provider,
        deliveryProviderOrderId: 'provider-terminal',
        acceptedAt: '2026-07-22T09:00:00.000Z',
      },
      version: 4,
    });

    expect(() =>
      applyOrderStatusChange(deliveredOrder, { targetStatus: 'CANCELLED' }, changedAt),
    ).toThrow(InvalidOrderStatusTransitionError);
    expect(deliveredOrder).toMatchObject({ status: 'DELIVERED', version: 4 });
  });

  it('requires immutable provider acceptance details for delivery states', () => {
    const order = createOrderFixture();

    expect(() => applyOrderStatusChange(order, { targetStatus: 'SUBMITTED' }, changedAt)).toThrow(
      InvalidOrderStatusDetailsError,
    );

    const submittedOrder = applyOrderStatusChange(
      order,
      { targetStatus: 'SUBMITTED', deliveryProviderOrderId: 'provider-original' },
      changedAt,
    );
    expect(() =>
      applyOrderStatusChange(
        submittedOrder,
        { targetStatus: 'PICKED_UP', deliveryProviderOrderId: 'provider-replacement' },
        changedAt,
      ),
    ).toThrow(InvalidOrderStatusDetailsError);
  });

  it('requires delivery-stage failure details for DELIVERY_FAILED', () => {
    const submittedOrder = createOrderFixture({
      status: 'SUBMITTED',
      provider: {
        ...createOrderFixture().provider,
        deliveryProviderOrderId: 'provider-failure',
        acceptedAt: '2026-07-22T09:00:00.000Z',
      },
      version: 2,
    });

    expect(() =>
      applyOrderStatusChange(submittedOrder, { targetStatus: 'DELIVERY_FAILED' }, changedAt),
    ).toThrow(InvalidOrderStatusDetailsError);
    expect(() =>
      applyOrderStatusChange(
        submittedOrder,
        {
          targetStatus: 'DELIVERY_FAILED',
          failure: {
            stage: 'SUBMISSION',
            reasonCode: 'WRONG_STAGE',
            summary: 'Wrong failure stage.',
            occurredAt: changedAt,
          },
        },
        changedAt,
      ),
    ).toThrow(InvalidOrderStatusDetailsError);
  });
});
