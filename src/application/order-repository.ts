import type { MerchantId, Order, OrderId } from '../domain/order.js';

export interface CreateOrderInput {
  readonly order: Order;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export type CreateOrderResult =
  | { readonly outcome: 'created'; readonly order: Order }
  | { readonly outcome: 'replayed'; readonly order: Order };

export interface OrderRepository {
  create(input: CreateOrderInput): Promise<CreateOrderResult>;
  get(merchantId: MerchantId, orderId: OrderId): Promise<Order | undefined>;
  saveStatusChange(order: Order, expectedVersion: number): Promise<void>;
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor() {
    super('The idempotency key was already used with different request values.');
  }
}

export class MerchantReferenceConflictError extends Error {
  override readonly name = 'MerchantReferenceConflictError';

  constructor() {
    super('The merchant order reference is already assigned to another order.');
  }
}

export class OrderAlreadyExistsError extends Error {
  override readonly name = 'OrderAlreadyExistsError';

  constructor() {
    super('The generated order ID already exists.');
  }
}

export class OrderNotFoundError extends Error {
  override readonly name = 'OrderNotFoundError';

  constructor() {
    super('The order does not exist for this merchant.');
  }
}

export class OrderVersionConflictError extends Error {
  override readonly name = 'OrderVersionConflictError';

  constructor(readonly actualVersion: number) {
    super(`The expected order version does not match version ${String(actualVersion)}.`);
  }
}

export function assertNextOrderVersion(order: Order, expectedVersion: number): void {
  if (order.version !== expectedVersion + 1) {
    throw new RangeError('A status change must increment the order version exactly once.');
  }
}
