import type { Order } from '../domain/order.js';
import type { OrderPayment } from '../domain/payment.js';

export type PaymentRepresentation = Omit<OrderPayment, 'stripeCreationKey'>;

export interface OrderRepresentation extends Omit<Order, 'provider' | 'payment'> {
  readonly provider: {
    readonly deliveryProviderCode: 'mock-delivery';
    readonly deliveryProviderOrderId?: string;
    readonly acceptedAt?: string;
  };
  readonly payment?: PaymentRepresentation;
}

function toPaymentRepresentation(payment: OrderPayment): PaymentRepresentation {
  return {
    status: payment.status,
    amount: payment.amount,
    ...(payment.stripePaymentIntentId === undefined
      ? {}
      : { stripePaymentIntentId: payment.stripePaymentIntentId }),
    ...(payment.lastFailure === undefined ? {} : { lastFailure: payment.lastFailure }),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
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
    ...(order.payment === undefined ? {} : { payment: toPaymentRepresentation(order.payment) }),
    ...(order.failure === undefined ? {} : { failure: order.failure }),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    version: order.version,
  };
}
