import {
  assertNextOrderVersion,
  IdempotencyConflictError,
  MerchantReferenceConflictError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderVersionConflictError,
  type CreateOrderInput,
  type CreateOrderResult,
  type OrderRepository,
} from '../../application/order-repository.js';
import type { MerchantId, Order, OrderId } from '../../domain/order.js';

interface IdempotencyEntry {
  readonly requestFingerprint: string;
  readonly orderId: OrderId;
}

function tupleKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function cloneOrder(order: Order): Order {
  return structuredClone(order);
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();
  private readonly idempotencyEntries = new Map<string, IdempotencyEntry>();
  private readonly merchantReferences = new Map<string, OrderId>();

  async create(input: CreateOrderInput): Promise<CreateOrderResult> {
    await Promise.resolve();

    const { order, idempotencyKey, requestFingerprint } = input;
    const idempotencyMapKey = tupleKey(order.merchantId, idempotencyKey);
    const existingIdempotencyEntry = this.idempotencyEntries.get(idempotencyMapKey);

    if (existingIdempotencyEntry) {
      if (existingIdempotencyEntry.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError();
      }

      const replayedOrder = this.orders.get(
        tupleKey(order.merchantId, existingIdempotencyEntry.orderId),
      );

      if (!replayedOrder) {
        throw new Error('The idempotency record refers to a missing order.');
      }

      return { outcome: 'replayed', order: cloneOrder(replayedOrder) };
    }

    const referenceMapKey = tupleKey(order.merchantId, order.merchantOrderReference);
    if (this.merchantReferences.has(referenceMapKey)) {
      throw new MerchantReferenceConflictError();
    }

    const orderMapKey = tupleKey(order.merchantId, order.orderId);
    if (this.orders.has(orderMapKey)) {
      throw new OrderAlreadyExistsError();
    }

    const storedOrder = cloneOrder(order);
    this.orders.set(orderMapKey, storedOrder);
    this.idempotencyEntries.set(idempotencyMapKey, {
      requestFingerprint,
      orderId: order.orderId,
    });
    this.merchantReferences.set(referenceMapKey, order.orderId);

    return { outcome: 'created', order: cloneOrder(storedOrder) };
  }

  async get(merchantId: MerchantId, orderId: OrderId): Promise<Order | undefined> {
    await Promise.resolve();

    const order = this.orders.get(tupleKey(merchantId, orderId));
    return order ? cloneOrder(order) : undefined;
  }

  async saveStatusChange(order: Order, expectedVersion: number): Promise<void> {
    await Promise.resolve();

    assertNextOrderVersion(order, expectedVersion);

    const orderMapKey = tupleKey(order.merchantId, order.orderId);
    const existingOrder = this.orders.get(orderMapKey);

    if (!existingOrder) {
      throw new OrderNotFoundError();
    }

    if (existingOrder.version !== expectedVersion) {
      throw new OrderVersionConflictError(existingOrder.version);
    }

    const updatedOrder: Order = {
      orderId: existingOrder.orderId,
      merchantId: existingOrder.merchantId,
      merchantOrderReference: existingOrder.merchantOrderReference,
      status: order.status,
      items: structuredClone(existingOrder.items),
      total: structuredClone(existingOrder.total),
      pickup: structuredClone(existingOrder.pickup),
      dropoff: structuredClone(existingOrder.dropoff),
      provider: structuredClone(order.provider),
      createdAt: existingOrder.createdAt,
      updatedAt: order.updatedAt,
      version: order.version,
      ...(order.failure === undefined ? {} : { failure: structuredClone(order.failure) }),
    };

    this.orders.set(orderMapKey, updatedOrder);
  }
}
