import type { Order } from '../domain/order.js';

export interface OrderRepresentation extends Omit<Order, 'provider'> {
  readonly provider: {
    readonly deliveryProviderCode: 'mock-delivery';
    readonly deliveryProviderOrderId?: string;
    readonly acceptedAt?: string;
  };
}

export function toOrderRepresentation(order: Order): OrderRepresentation {
  return {
    orderId: order.orderId,
    merchantId: order.merchantId,
    merchantOrderId: order.merchantOrderId,
    status: order.status,
    items: order.items,
    total: order.total,
    pickup: order.pickup,
    dropoff: order.dropoff,
    provider: {
      deliveryProviderCode: order.provider.deliveryProviderCode,
      ...(order.provider.deliveryProviderOrderId === undefined
        ? {}
        : { deliveryProviderOrderId: order.provider.deliveryProviderOrderId }),
      ...(order.provider.acceptedAt === undefined ? {} : { acceptedAt: order.provider.acceptedAt }),
    },
    ...(order.failure === undefined ? {} : { failure: order.failure }),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    version: order.version,
  };
}
