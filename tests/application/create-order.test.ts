import { describe, expect, it } from 'vitest';

import { fingerprintCreateOrderRequest } from '../../src/application/create-order.js';
import type { CreateOrderRequest } from '../../src/application/create-order-validation.js';
import { createOrderRequestFixture } from '../fixtures/create-order-request.js';

describe('create-order fingerprint', () => {
  it('is independent of input object property order', () => {
    const request = createOrderRequestFixture();
    const reordered: CreateOrderRequest = {
      dropoff: request.dropoff,
      pickup: request.pickup,
      items: request.items.map((line) => ({
        unitPrice: { currency: line.unitPrice.currency, amountMinor: line.unitPrice.amountMinor },
        quantity: line.quantity,
        description: line.description,
        itemReference: line.itemReference,
      })),
      merchantOrderReference: request.merchantOrderReference,
    };

    expect(fingerprintCreateOrderRequest(reordered)).toBe(fingerprintCreateOrderRequest(request));
  });

  it('changes when a business value changes', () => {
    const request = createOrderRequestFixture();
    const firstLine = request.items[0];
    if (!firstLine) {
      throw new Error('The valid request fixture must contain one order line.');
    }
    const changed = createOrderRequestFixture({
      items: [{ ...firstLine, quantity: firstLine.quantity + 1 }],
    });

    expect(fingerprintCreateOrderRequest(changed)).not.toBe(fingerprintCreateOrderRequest(request));
  });
});
