import { describe, expect, it } from 'vitest';

import {
  applyOrderStatusChange,
  InvalidOrderStatusDetailsError,
  InvalidOrderStatusTransitionError,
} from '../../src/domain/order-status-transition.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';
import { applyPaymentStatusChange } from '../../src/domain/payment-status-transition.js';
import { createOrderFixture } from '../fixtures/order.js';

const changedAt = '2026-07-22T10:00:00.000Z';

describe('order status transition', () => {
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
