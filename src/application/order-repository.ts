import type { MerchantId, Order, OrderId } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';

export interface CreateOrderInput {
  readonly order: Order;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export type CreateOrderResult =
  | { readonly outcome: 'created'; readonly order: Order }
  | { readonly outcome: 'replayed'; readonly order: Order };

export interface OrderListPosition {
  readonly createdAt: string;
  readonly orderId: OrderId;
}

export interface ListOrdersInput {
  readonly merchantId: MerchantId;
  readonly status?: OrderStatus;
  readonly limit: number;
  readonly position?: OrderListPosition;
}

export interface ListOrdersResult {
  readonly orders: readonly Order[];
  readonly nextPosition?: OrderListPosition;
}

export interface OrderRepository {
  create(input: CreateOrderInput): Promise<CreateOrderResult>;
  get(merchantId: MerchantId, orderId: OrderId): Promise<Order | undefined>;
  list(input: ListOrdersInput): Promise<ListOrdersResult>;
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

export function assertOrderPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('An order page limit must be an integer from 1 through 100.');
  }
}
