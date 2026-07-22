import { randomUUID } from 'node:crypto';

import { asMerchantId, asOrderId, type Order } from '../../src/domain/order.js';

export function createOrderFixture(overrides: Partial<Order> = {}): Order {
  const suffix = randomUUID().replaceAll('-', '');
  const createdAt = '2026-07-21T12:30:00.000Z';

  return {
    orderId: asOrderId(`ord_${suffix}`),
    merchantId: asMerchantId(`mrc_${suffix}`),
    merchantOrderReference: `reference_${suffix}`,
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
      providerCode: 'mock-delivery',
      submissionKey: `submission_${suffix}`,
    },
    createdAt,
    updatedAt: createdAt,
    version: 1,
    ...overrides,
  };
}
