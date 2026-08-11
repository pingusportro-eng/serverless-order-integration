import { describe, expect, it } from 'vitest';

import { createOrder, fingerprintCreateOrderRequest } from '../../src/application/create-order.js';
import type { CreateOrderRequest } from '../../src/application/create-order-validation.js';
import { asMerchantId } from '../../src/domain/order.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
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
      merchantOrderId: request.merchantOrderId,
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

describe('createOrder payment gate', () => {
  it('creates one unpaid order with a stable server-derived Stripe key', async () => {
    const generated = ['orderidentifier0001', 'submissionidentifier0001'];
    const result = await createOrder(
      {
        repository: new InMemoryOrderRepository(),
        now: () => new Date('2026-08-11T11:00:00.000Z'),
        generateId: () => generated.shift() ?? 'unusedidentifier',
      },
      {
        merchantId: asMerchantId('mrc_demo'),
        idempotencyKey: 'create-payment-gated-order',
        correlationId: 'corr_create_payment_gate',
        causationId: 'request_create_payment_gate',
        body: createOrderRequestFixture(),
      },
    );

    expect(result).toMatchObject({
      outcome: 'created',
      order: {
        orderId: 'ord_orderidentifier0001',
        status: 'AWAITING_PAYMENT',
        total: { amountMinor: 2598, currency: 'RON' },
        payment: {
          status: 'NOT_STARTED',
          amount: { amountMinor: 2598, currency: 'RON' },
          stripeCreationKey: 'stripe-payment-intent:mrc_demo:ord_orderidentifier0001',
          createdAt: '2026-08-11T11:00:00.000Z',
          updatedAt: '2026-08-11T11:00:00.000Z',
        },
      },
    });
  });
});
