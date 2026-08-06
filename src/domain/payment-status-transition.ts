import {
  isTerminalPaymentStatus,
  type OrderPayment,
  type PaymentFailure,
  type PaymentStatus,
} from './payment.js';

export interface PaymentStatusChange {
  readonly targetStatus: Exclude<PaymentStatus, 'NOT_STARTED'>;
  readonly stripePaymentIntentId: string;
  readonly lastFailure?: PaymentFailure;
}

export class InvalidPaymentStatusTransitionError extends Error {
  override readonly name = 'InvalidPaymentStatusTransitionError';

  constructor(
    readonly currentStatus: PaymentStatus,
    readonly targetStatus: PaymentStatus,
  ) {
    super(`A payment cannot change from ${currentStatus} to ${targetStatus}.`);
  }
}

export class InvalidPaymentStatusDetailsError extends Error {
  override readonly name = 'InvalidPaymentStatusDetailsError';
}

function validateDetails(payment: OrderPayment, change: PaymentStatusChange): void {
  if (change.stripePaymentIntentId.length === 0) {
    throw new InvalidPaymentStatusDetailsError('The Stripe PaymentIntent ID must not be empty.');
  }

  if (
    payment.stripePaymentIntentId !== undefined &&
    payment.stripePaymentIntentId !== change.stripePaymentIntentId
  ) {
    throw new InvalidPaymentStatusDetailsError('The Stripe PaymentIntent ID cannot be changed.');
  }
}

function sameFailure(
  current: PaymentFailure | undefined,
  proposed: PaymentFailure | undefined,
): boolean {
  return (
    current === proposed ||
    (current !== undefined &&
      proposed !== undefined &&
      current.reasonCode === proposed.reasonCode &&
      current.occurredAt === proposed.occurredAt)
  );
}

export function applyPaymentStatusChange(
  payment: OrderPayment,
  change: PaymentStatusChange,
  changedAt: string,
): OrderPayment {
  validateDetails(payment, change);

  if (isTerminalPaymentStatus(payment.status) && payment.status !== change.targetStatus) {
    throw new InvalidPaymentStatusTransitionError(payment.status, change.targetStatus);
  }

  if (changedAt < payment.createdAt) {
    throw new RangeError('A payment change cannot occur before the payment was created.');
  }

  const stripePaymentIntentId = payment.stripePaymentIntentId ?? change.stripePaymentIntentId;
  const lastFailure = change.lastFailure ?? payment.lastFailure;

  if (
    payment.status === change.targetStatus &&
    payment.stripePaymentIntentId === stripePaymentIntentId &&
    sameFailure(payment.lastFailure, lastFailure)
  ) {
    return payment;
  }

  if (changedAt < payment.updatedAt) {
    throw new RangeError('A payment change cannot occur before the previous payment update.');
  }

  return {
    status: change.targetStatus,
    amount: payment.amount,
    stripeCreationKey: payment.stripeCreationKey,
    stripePaymentIntentId,
    ...(lastFailure === undefined ? {} : { lastFailure }),
    createdAt: payment.createdAt,
    updatedAt: changedAt,
  };
}
