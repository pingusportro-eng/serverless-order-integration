import { describe, expect, it } from 'vitest';

import {
  calculateOrderTotal,
  validateCreateOrderRequest,
} from '../../src/application/create-order-validation.js';
import type { OrderLine } from '../../src/domain/order.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';

function orderLineFixture(): OrderLine {
  const line = createOrderRequestFixture().items[0];
  if (!line) {
    throw new Error('The valid request fixture must contain one order line.');
  }
  return line;
}

function invalidPointers(value: unknown): readonly string[] {
  const result = validateCreateOrderRequest(value);
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.issues.map((issue) => issue.pointer);
}

describe('create-order validation', () => {
  it('accepts a contract-compatible request and calculates its total', () => {
    const request = createOrderRequestFixture({
      items: [
        {
          itemReference: 'item-1',
          description: 'First item',
          quantity: 2,
          unitPrice: { amountMinor: 100, currency: 'RON' },
        },
        {
          itemReference: 'item-2',
          description: 'Second item',
          quantity: 3,
          unitPrice: { amountMinor: 250, currency: 'RON' },
        },
      ],
    });

    const result = validateCreateOrderRequest(request);

    expect(result).toEqual({ valid: true, value: request });
    if (result.valid) {
      expect(calculateOrderTotal(result.value)).toEqual({ amountMinor: 950, currency: 'RON' });
    }
  });

  it.each([
    ['non-object body', null, '#'],
    [
      'unknown top-level field',
      { ...createOrderRequestFixture(), unexpected: true },
      '#/unexpected',
    ],
    [
      'missing merchant order ID',
      { ...createOrderRequestFixture(), merchantOrderId: undefined },
      '#/merchantOrderId',
    ],
    [
      'long merchant order ID',
      createOrderRequestFixture({ merchantOrderId: 'x'.repeat(101) }),
      '#/merchantOrderId',
    ],
    ['non-array items', { ...createOrderRequestFixture(), items: 'invalid' }, '#/items'],
    ['empty items', createOrderRequestFixture({ items: [] }), '#/items'],
    [
      'too many items',
      createOrderRequestFixture({
        items: Array.from({ length: 51 }, () => orderLineFixture()),
      }),
      '#/items',
    ],
    ['non-object line', createOrderRequestFixture({ items: [null as never] }), '#/items/0'],
    [
      'unknown line field',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), extra: true } as never],
      }),
      '#/items/0/extra',
    ],
    [
      'invalid item reference',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), itemReference: '' }],
      }),
      '#/items/0/itemReference',
    ],
    [
      'invalid description',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), description: 42 as never }],
      }),
      '#/items/0/description',
    ],
    [
      'fractional quantity',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), quantity: 1.5 }],
      }),
      '#/items/0/quantity',
    ],
    [
      'quantity outside range',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), quantity: 101 }],
      }),
      '#/items/0/quantity',
    ],
    [
      'non-object money',
      createOrderRequestFixture({
        items: [{ ...orderLineFixture(), unitPrice: null as never }],
      }),
      '#/items/0/unitPrice',
    ],
    [
      'unknown money field',
      createOrderRequestFixture({
        items: [
          {
            ...orderLineFixture(),
            unitPrice: { amountMinor: 100, currency: 'RON', extra: true } as never,
          },
        ],
      }),
      '#/items/0/unitPrice/extra',
    ],
    [
      'negative amount',
      createOrderRequestFixture({
        items: [
          {
            ...orderLineFixture(),
            unitPrice: { amountMinor: -1, currency: 'RON' },
          },
        ],
      }),
      '#/items/0/unitPrice/amountMinor',
    ],
    [
      'invalid currency',
      createOrderRequestFixture({
        items: [
          {
            ...orderLineFixture(),
            unitPrice: { amountMinor: 100, currency: 'ron' },
          },
        ],
      }),
      '#/items/0/unitPrice/currency',
    ],
    ['non-object pickup', createOrderRequestFixture({ pickup: null as never }), '#/pickup'],
    [
      'unknown location field',
      createOrderRequestFixture({
        pickup: { ...createOrderRequestFixture().pickup, extra: true } as never,
      }),
      '#/pickup/extra',
    ],
    [
      'invalid address',
      createOrderRequestFixture({
        pickup: { ...createOrderRequestFixture().pickup, addressLine: '' },
      }),
      '#/pickup/addressLine',
    ],
    [
      'invalid city',
      createOrderRequestFixture({
        pickup: { ...createOrderRequestFixture().pickup, city: 1 as never },
      }),
      '#/pickup/city',
    ],
    [
      'invalid postal code',
      createOrderRequestFixture({
        pickup: { ...createOrderRequestFixture().pickup, postalCode: '' },
      }),
      '#/pickup/postalCode',
    ],
    [
      'invalid country',
      createOrderRequestFixture({
        pickup: { ...createOrderRequestFixture().pickup, countryCode: 'ro' },
      }),
      '#/pickup/countryCode',
    ],
  ] as const)('rejects %s', (_description, value, expectedPointer) => {
    expect(invalidPointers(value)).toContain(expectedPointer);
  });

  it('requires one currency across all lines', () => {
    const firstLine = orderLineFixture();
    const value = createOrderRequestFixture({
      items: [firstLine, { ...firstLine, unitPrice: { amountMinor: 100, currency: 'EUR' } }],
    });

    expect(invalidPointers(value)).toContain('#/items/1/unitPrice/currency');
  });

  it('rejects a total that exceeds safe integer arithmetic', () => {
    const value = createOrderRequestFixture({
      items: [
        {
          ...orderLineFixture(),
          quantity: 2,
          unitPrice: { amountMinor: Number.MAX_SAFE_INTEGER, currency: 'RON' },
        },
      ],
    });

    expect(invalidPointers(value)).toContain('#/items');
  });

  it('requires pickup and dropoff to differ', () => {
    const pickup = createOrderRequestFixture().pickup;
    const value = createOrderRequestFixture({ pickup, dropoff: { ...pickup } });

    expect(invalidPointers(value)).toContain('#/dropoff');
  });
});
