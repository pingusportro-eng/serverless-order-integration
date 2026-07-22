import type { Order } from '../domain/order.js';

export interface OrderRepresentation extends Omit<Order, 'provider'> {
  readonly provider: {
    readonly providerCode: 'mock-delivery';
    readonly providerOrderId?: string;
    readonly acceptedAt?: string;
  };
}

export function toOrderRepresentation(order: Order): OrderRepresentation {
  return {
    orderId: order.orderId,
    merchantId: order.merchantId,
    merchantOrderReference: order.merchantOrderReference,
    status: order.status,
    items: order.items,
    total: order.total,
    pickup: order.pickup,
    dropoff: order.dropoff,
    provider: {
      providerCode: order.provider.providerCode,
      ...(order.provider.providerOrderId === undefined
        ? {}
        : { providerOrderId: order.provider.providerOrderId }),
      ...(order.provider.acceptedAt === undefined ? {} : { acceptedAt: order.provider.acceptedAt }),
    },
    ...(order.failure === undefined ? {} : { failure: order.failure }),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    version: order.version,
  };
}
