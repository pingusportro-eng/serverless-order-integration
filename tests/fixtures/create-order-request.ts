import type { CreateOrderRequest } from '../../src/application/create-order-validation.js';

export function createOrderRequestFixture(
  overrides: Partial<CreateOrderRequest> = {},
): CreateOrderRequest {
  return {
    merchantOrderReference: 'pos-order-10042',
    items: [
      {
        itemReference: 'pizza-margherita',
        description: 'Synthetic margherita pizza',
        quantity: 2,
        unitPrice: { amountMinor: 1299, currency: 'RON' },
      },
    ],
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
    ...overrides,
  };
}
