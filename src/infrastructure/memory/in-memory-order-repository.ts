import {
  assertNextOrderVersion,
  assertOrderPageLimit,
  IdempotencyConflictError,
  MerchantOrderIdConflictError,
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderVersionConflictError,
  type CreateOrderInput,
  type CreateOrderResult,
  type ListOrdersInput,
  type ListOrdersResult,
  type OrderRepository,
} from '../../application/order-repository.js';
import {
  ProviderEventIdConflictError,
  DeliveryProviderOrderIdConflictError,
  type ProviderWebhookRepository,
  type RecordProviderWebhookInput,
  type RecordProviderWebhookResult,
} from '../../application/provider-webhook-repository.js';
import type { MerchantId, Order, OrderId } from '../../domain/order.js';
import type { OrderStatusChangedMutation } from '../../events/order-mutation.js';

interface IdempotencyEntry {
  readonly requestFingerprint: string;
  readonly orderId: OrderId;
}

interface ProcessedProviderEvent {
  readonly fingerprint: string;
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

export class InMemoryOrderRepository implements OrderRepository, ProviderWebhookRepository {
  private readonly orders = new Map<string, Order>();
  private readonly idempotencyEntries = new Map<string, IdempotencyEntry>();
  private readonly merchantOrderIds = new Map<string, OrderId>();
  private readonly providerOrders = new Map<string, { merchantId: MerchantId; orderId: OrderId }>();
  private readonly processedProviderEvents = new Map<string, ProcessedProviderEvent>();

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

    const merchantOrderIdMapKey = tupleKey(order.merchantId, order.merchantOrderId);
    if (this.merchantOrderIds.has(merchantOrderIdMapKey)) {
      throw new MerchantOrderIdConflictError();
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
    this.merchantOrderIds.set(merchantOrderIdMapKey, order.orderId);

    return { outcome: 'created', order: cloneOrder(storedOrder) };
  }

  async get(merchantId: MerchantId, orderId: OrderId): Promise<Order | undefined> {
    await Promise.resolve();

    const order = this.orders.get(tupleKey(merchantId, orderId));
    return order ? cloneOrder(order) : undefined;
  }

  async getByDeliveryProviderOrderId(
    deliveryProviderCode: Order['provider']['deliveryProviderCode'],
    deliveryProviderOrderId: string,
  ): Promise<Order | undefined> {
    await Promise.resolve();

    const mapping = this.providerOrders.get(
      tupleKey(deliveryProviderCode, deliveryProviderOrderId),
    );
    if (mapping === undefined) {
      return undefined;
    }
    const order = this.orders.get(tupleKey(mapping.merchantId, mapping.orderId));
    return order === undefined ? undefined : cloneOrder(order);
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

    const deliveryProviderOrderId =
      mutation.previousStatus === 'PENDING_SUBMISSION' && order.status === 'SUBMITTED'
        ? order.provider.deliveryProviderOrderId
        : undefined;
    const providerMapKey =
      deliveryProviderOrderId === undefined
        ? undefined
        : tupleKey(order.provider.deliveryProviderCode, deliveryProviderOrderId);
    const existingProviderOrder =
      providerMapKey === undefined ? undefined : this.providerOrders.get(providerMapKey);
    if (
      existingProviderOrder !== undefined &&
      (existingProviderOrder.merchantId !== order.merchantId ||
        existingProviderOrder.orderId !== order.orderId)
    ) {
      throw new DeliveryProviderOrderIdConflictError();
    }

    const updatedOrder: Order = {
      orderId: existingOrder.orderId,
      merchantId: existingOrder.merchantId,
      merchantOrderId: existingOrder.merchantOrderId,
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
    if (providerMapKey !== undefined) {
      this.providerOrders.set(providerMapKey, {
        merchantId: order.merchantId,
        orderId: order.orderId,
      });
    }
  }

  async recordProviderWebhook(
    input: RecordProviderWebhookInput,
  ): Promise<RecordProviderWebhookResult> {
    await Promise.resolve();

    const eventMapKey = tupleKey('provider-webhook', input.eventId);
    const existingEvent = this.processedProviderEvents.get(eventMapKey);
    if (existingEvent !== undefined) {
      if (existingEvent.fingerprint === input.eventFingerprint) {
        return 'duplicate';
      }
      throw new ProviderEventIdConflictError();
    }

    const orderMapKey = tupleKey(input.currentOrder.merchantId, input.currentOrder.orderId);
    const storedOrder = this.orders.get(orderMapKey);
    if (storedOrder === undefined) {
      throw new OrderNotFoundError();
    }
    if (storedOrder.version !== input.currentOrder.version) {
      throw new OrderVersionConflictError(storedOrder.version);
    }
    if ((input.changedOrder === undefined) !== (input.mutation === undefined)) {
      throw new TypeError('A changed webhook order and its mutation must be supplied together.');
    }

    if (input.changedOrder !== undefined) {
      assertNextOrderVersion(input.changedOrder, input.currentOrder.version);
      this.orders.set(orderMapKey, cloneOrder(input.changedOrder));
    }
    this.processedProviderEvents.set(eventMapKey, { fingerprint: input.eventFingerprint });
    return 'recorded';
  }
}
