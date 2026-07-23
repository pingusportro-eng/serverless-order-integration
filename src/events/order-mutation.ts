import type { OrderStatus } from '../domain/order-status.js';

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

export type OrderMutation = OrderCreatedMutation | OrderStatusChangedMutation;
