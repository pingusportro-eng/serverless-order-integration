import type { Money } from './order.js';

export const PAYMENT_STATUSES = [
  'NOT_STARTED',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_CONFIRMATION',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'CANCELLED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set(['SUCCEEDED', 'CANCELLED']);

export interface PaymentFailure {
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface OrderPayment {
  readonly status: PaymentStatus;
  readonly amount: Money;
  readonly stripeCreationKey: string;
  readonly stripePaymentIntentId?: string;
  readonly lastFailure?: PaymentFailure;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.has(status);
}

export function createInitialOrderPayment(
  amount: Money,
  stripeCreationKey: string,
  createdAt: string,
): OrderPayment {
  if (stripeCreationKey.length === 0) {
    throw new RangeError('The Stripe creation key must not be empty.');
  }

  return {
    status: 'NOT_STARTED',
    amount,
    stripeCreationKey,
    createdAt,
    updatedAt: createdAt,
  };
}
