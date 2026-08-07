import type { OrderStatus } from '../domain/order-status.js';
import type { PaymentStatus } from '../domain/payment.js';

interface OrderMutationTrace {
  readonly correlationId: string;
  readonly causationId: string;
}

export interface OrderCreatedMutation extends OrderMutationTrace {
  readonly kind: 'ORDER_CREATED';
}

export interface OrderStatusChangedMutation extends OrderMutationTrace {
  readonly kind: 'ORDER_STATUS_CHANGED';
  readonly previousStatus: OrderStatus;
  readonly reason?: string;
}

export interface OrderPaymentChangedMutation extends OrderMutationTrace {
  readonly kind: 'ORDER_PAYMENT_CHANGED';
  readonly previousPaymentStatus: PaymentStatus;
}

export type OrderMutation =
  OrderCreatedMutation | OrderStatusChangedMutation | OrderPaymentChangedMutation;
