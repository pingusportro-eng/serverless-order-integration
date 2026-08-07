import {
  assertNextOrderVersion,
  OrderNotFoundError,
  OrderVersionConflictError,
} from './order-repository.js';
import type { Order } from '../domain/order.js';
import type { OrderPaymentChangedMutation } from '../events/order-mutation.js';

export interface BindStripePaymentIntentInput {
  readonly currentOrder: Order;
  readonly changedOrder: Order;
  readonly mutation: OrderPaymentChangedMutation;
}

export type BindStripePaymentIntentResult =
  | { readonly outcome: 'bound'; readonly order: Order }
  | { readonly outcome: 'replayed'; readonly order: Order };

export interface PaymentRepository {
  bindStripePaymentIntent(
    input: BindStripePaymentIntentInput,
  ): Promise<BindStripePaymentIntentResult>;
  getByStripePaymentIntentId(stripePaymentIntentId: string): Promise<Order | undefined>;
}

export class StripePaymentIntentBindingConflictError extends Error {
  override readonly name = 'StripePaymentIntentBindingConflictError';

  constructor() {
    super('The Stripe PaymentIntent is already bound inconsistently.');
  }
}

export function stripePaymentIntentIdFromBinding(input: BindStripePaymentIntentInput): string {
  const { currentOrder, changedOrder, mutation } = input;
  assertNextOrderVersion(changedOrder, currentOrder.version);

  if (
    currentOrder.orderId !== changedOrder.orderId ||
    currentOrder.merchantId !== changedOrder.merchantId
  ) {
    throw new TypeError('A payment binding cannot change order identity.');
  }
  if (currentOrder.status !== changedOrder.status) {
    throw new TypeError('Binding a PaymentIntent cannot change the order status.');
  }
  if (currentOrder.payment === undefined || changedOrder.payment === undefined) {
    throw new TypeError('A payment binding requires an embedded payment value.');
  }
  if (mutation.previousPaymentStatus !== currentOrder.payment.status) {
    throw new TypeError('Payment mutation metadata does not match the current payment status.');
  }
  if (
    currentOrder.payment.amount.amountMinor !== changedOrder.payment.amount.amountMinor ||
    currentOrder.payment.amount.currency !== changedOrder.payment.amount.currency ||
    currentOrder.payment.stripeCreationKey !== changedOrder.payment.stripeCreationKey ||
    currentOrder.payment.createdAt !== changedOrder.payment.createdAt
  ) {
    throw new TypeError('A payment binding cannot change immutable payment details.');
  }
  if (changedOrder.payment.updatedAt !== changedOrder.updatedAt) {
    throw new TypeError('Payment and order update timestamps must match.');
  }

  const stripePaymentIntentId = changedOrder.payment.stripePaymentIntentId;
  if (stripePaymentIntentId === undefined || stripePaymentIntentId.length === 0) {
    throw new TypeError('A payment binding requires a Stripe PaymentIntent ID.');
  }
  if (
    currentOrder.payment.stripePaymentIntentId !== undefined &&
    currentOrder.payment.stripePaymentIntentId !== stripePaymentIntentId
  ) {
    throw new StripePaymentIntentBindingConflictError();
  }

  return stripePaymentIntentId;
}

export function orderFromPaymentBinding(input: BindStripePaymentIntentInput): Order {
  const payment = input.changedOrder.payment;
  if (payment === undefined) {
    throw new TypeError('A payment binding requires an embedded payment value.');
  }
  return structuredClone({
    ...input.currentOrder,
    payment,
    updatedAt: input.changedOrder.updatedAt,
    version: input.changedOrder.version,
  });
}

export function resolvePaymentBindingOrder(
  storedOrder: Order | undefined,
  input: BindStripePaymentIntentInput,
  stripePaymentIntentId: string,
): Order {
  if (storedOrder === undefined) {
    throw new OrderNotFoundError();
  }
  const storedStripePaymentIntentId = storedOrder.payment?.stripePaymentIntentId;
  if (
    storedStripePaymentIntentId !== undefined &&
    storedStripePaymentIntentId !== stripePaymentIntentId
  ) {
    throw new StripePaymentIntentBindingConflictError();
  }
  if (storedOrder.version !== input.currentOrder.version) {
    throw new OrderVersionConflictError(storedOrder.version);
  }
  return storedOrder;
}
