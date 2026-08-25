import { randomUUID } from 'node:crypto';

import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';
import { applyPaymentStatusChange } from '../../src/domain/payment-status-transition.js';
import { createInitialOrderPayment } from '../../src/domain/payment.js';

export function createOrderFixture(overrides: Partial<Order> = {}): Order {
  const suffix = randomUUID().replaceAll('-', '');
  const createdAt = '2026-07-21T12:30:00.000Z';

  return {
    orderId: asOrderId(`ord_${suffix}`),
    merchantId: asMerchantId(`mrc_${suffix}`),
    merchantOrderId: `merchant_order_${suffix}`,
    status: 'PENDING_SUBMISSION',
    items: [
      {
        itemReference: 'item-1',
        description: 'Synthetic lunch',
        quantity: 2,
        unitPrice: { amountMinor: 1250, currency: 'RON' },
      },
    ],
    total: { amountMinor: 2500, currency: 'RON' },
    pickup: {
      addressLine: '10 Example Street',
      city: 'Bucharest',
      postalCode: '010101',
      countryCode: 'RO',
    },
    dropoff: {
      addressLine: '20 Example Avenue',
      city: 'Bucharest',
      postalCode: '020202',
      countryCode: 'RO',
    },
    provider: {
      deliveryProviderCode: 'mock-delivery',
      deliveryProviderSubmissionKey: `submission_${suffix}`,
    },
    createdAt,
    updatedAt: createdAt,
    version: 1,
    ...overrides,
  };
}

export function createPaidOrderFixture(overrides: Partial<Order> = {}): Order {
  const order = createOrderFixture(overrides);
  const initialPayment = createInitialOrderPayment(
    order.total,
    `stripe-payment-intent:${order.merchantId}:${order.orderId}`,
    order.createdAt,
  );
  const payment = applyPaymentStatusChange(
    initialPayment,
    {
      targetStatus: 'SUCCEEDED',
      stripePaymentIntentId: `pi_${order.orderId.slice(4)}`,
    },
    order.updatedAt,
  );
  return { ...order, payment };
}
