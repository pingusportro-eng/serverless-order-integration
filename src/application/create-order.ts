import { createHash, randomUUID } from 'node:crypto';

import type { OrderRepository } from './order-repository.js';
import {
  calculateOrderTotal,
  type CreateOrderRequest,
  validateCreateOrderRequest,
} from './create-order-validation.js';
import { asOrderId, type MerchantId, type Order } from '../domain/order.js';
import { createInitialOrderPayment } from '../domain/payment.js';
import type { ValidationIssue } from '../http/problem-details.js';

export interface CreateOrderDependencies {
  readonly repository: OrderRepository;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export interface CreateOrderCommand {
  readonly merchantId: MerchantId;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly body: unknown;
}

export type CreateOrderApplicationResult =
  | { readonly outcome: 'invalid'; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: 'created' | 'replayed'; readonly order: Order };

function canonicalRequest(request: CreateOrderRequest): object {
  return {
    merchantOrderId: request.merchantOrderId,
    items: request.items.map((line) => ({
      itemReference: line.itemReference,
      description: line.description,
      quantity: line.quantity,
      unitPrice: {
        amountMinor: line.unitPrice.amountMinor,
        currency: line.unitPrice.currency,
      },
    })),
    pickup: {
      addressLine: request.pickup.addressLine,
      city: request.pickup.city,
      postalCode: request.pickup.postalCode,
      countryCode: request.pickup.countryCode,
    },
    dropoff: {
      addressLine: request.dropoff.addressLine,
      city: request.dropoff.city,
      postalCode: request.dropoff.postalCode,
      countryCode: request.dropoff.countryCode,
    },
  };
}

export function fingerprintCreateOrderRequest(request: CreateOrderRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalRequest(request)))
    .digest('hex');
}

function identifier(prefix: 'ord_' | 'submission_', generateId: () => string): string {
  return `${prefix}${generateId().replaceAll('-', '')}`;
}

export async function createOrder(
  dependencies: CreateOrderDependencies,
  command: CreateOrderCommand,
): Promise<CreateOrderApplicationResult> {
  const validation = validateCreateOrderRequest(command.body);
  if (!validation.valid) {
    return { outcome: 'invalid', issues: validation.issues };
  }

  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? randomUUID;
  const timestamp = now().toISOString();
  const orderId = asOrderId(identifier('ord_', generateId));
  const total = calculateOrderTotal(validation.value);
  const order: Order = {
    orderId,
    merchantId: command.merchantId,
    merchantOrderId: validation.value.merchantOrderId,
    status: 'AWAITING_PAYMENT',
    items: validation.value.items,
    total,
    pickup: validation.value.pickup,
    dropoff: validation.value.dropoff,
    provider: {
      deliveryProviderCode: 'mock-delivery',
      deliveryProviderSubmissionKey: identifier('submission_', generateId),
    },
    payment: createInitialOrderPayment(
      total,
      `stripe-payment-intent:${command.merchantId}:${orderId}`,
      timestamp,
    ),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
  const result = await dependencies.repository.create({
    order,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: fingerprintCreateOrderRequest(validation.value),
    mutation: {
      kind: 'ORDER_CREATED',
      correlationId: command.correlationId,
      causationId: command.causationId,
    },
  });

  return result;
}
