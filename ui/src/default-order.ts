import type { CreateOrderRequest } from './api/contracts.js';

export function defaultCreateOrderRequest(merchantOrderId: string): CreateOrderRequest {
  return {
    merchantOrderId,
    items: [
      {
        itemReference: 'pizza-margherita',
        description: 'Synthetic margherita pizza',
        quantity: 1,
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
  };
}
