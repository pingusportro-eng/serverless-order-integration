import {
  assertNextOrderVersion,
  assertOrderPageLimit,
  IdempotencyConflictError,
  MerchantReferenceConflictError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderVersionConflictError,
  type CreateOrderInput,
  type CreateOrderResult,
  type ListOrdersInput,
  type ListOrdersResult,
  type OrderRepository,
} from '../../application/order-repository.js';
import type { MerchantId, Order, OrderId } from '../../domain/order.js';
import type { OrderStatusChangedMutation } from '../../events/order-mutation.js';

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

function orderListSortKey(order: Pick<Order, 'createdAt' | 'orderId'>): string {
  return `ORDER#${order.createdAt}#${order.orderId}`;
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

  async list(input: ListOrdersInput): Promise<ListOrdersResult> {
    await Promise.resolve();
    assertOrderPageLimit(input.limit);

    const positionKey = input.position ? orderListSortKey(input.position) : undefined;
    const candidates = [...this.orders.values()]
      .filter(
        (order) =>
          order.merchantId === input.merchantId &&
          (input.status === undefined || order.status === input.status) &&
          (positionKey === undefined || orderListSortKey(order) < positionKey),
      )
      .sort((left, right) => {
        const leftKey = orderListSortKey(left);
        const rightKey = orderListSortKey(right);
        return leftKey === rightKey ? 0 : leftKey < rightKey ? 1 : -1;
      });
    const orders = candidates.slice(0, input.limit).map(cloneOrder);
    const lastOrder = orders[orders.length - 1];

    return {
      orders,
      ...(candidates.length > input.limit && lastOrder
        ? { nextPosition: { createdAt: lastOrder.createdAt, orderId: lastOrder.orderId } }
        : {}),
    };
  }

  async saveStatusChange(
    order: Order,
    expectedVersion: number,
    mutation: OrderStatusChangedMutation,
  ): Promise<void> {
    await Promise.resolve();
    void mutation;

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
