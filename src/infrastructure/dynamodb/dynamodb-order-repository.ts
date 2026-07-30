import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

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
  type OrderListPosition,
  type OrderRepository,
} from '../../application/order-repository.js';
import {
  PROVIDER_WEBHOOK_CONSUMER,
  ProviderEventIdConflictError,
  DeliveryProviderOrderIdConflictError,
  type ProviderWebhookRepository,
  type RecordProviderWebhookInput,
  type RecordProviderWebhookResult,
} from '../../application/provider-webhook-repository.js';
import type { MerchantId, Order, OrderId } from '../../domain/order.js';
import type { OrderMutation, OrderStatusChangedMutation } from '../../events/order-mutation.js';

const SCHEMA_VERSION = 2;

interface StoredOrderItem {
  readonly pk: string;
  readonly sk: string;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  readonly gsi2pk: string;
  readonly gsi2sk: string;
  readonly entityType: 'ORDER';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly status: Order['status'];
  readonly version: number;
  readonly order: Order;
  readonly mutation: OrderMutation;
}

interface StoredIdempotencyItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'IDEMPOTENCY';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly requestFingerprint: string;
  readonly orderId: OrderId;
  readonly createdAt: string;
}

interface StoredMerchantOrderIdItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'MERCHANT_ORDER_ID';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly orderId: OrderId;
  readonly createdAt: string;
}

interface StoredDeliveryProviderOrderItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DELIVERY_PROVIDER_ORDER';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly merchantId: MerchantId;
  readonly orderId: OrderId;
  readonly createdAt: string;
}

interface StoredProcessedEventItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'PROCESSED_EVENT';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly eventFingerprint: string;
  readonly deliveryProviderOrderId: string;
  readonly processedAt: string;
}

function merchantKey(merchantId: MerchantId): string {
  return `MERCHANT#${merchantId}`;
}

function orderKey(orderId: OrderId): string {
  return `ORDER#${orderId}`;
}

function idempotencyKey(value: string): string {
  return `IDEMPOTENCY#${value}`;
}

function merchantOrderIdKey(value: string): string {
  return `MERCHANT_ORDER_ID#${value}`;
}

function deliveryProviderKey(
  deliveryProviderCode: Order['provider']['deliveryProviderCode'],
): string {
  return `DELIVERY_PROVIDER#${deliveryProviderCode}`;
}

function processedEventConsumerKey(): string {
  return `CONSUMER#${PROVIDER_WEBHOOK_CONSUMER}`;
}

function eventKey(eventId: string): string {
  return `EVENT#${eventId}`;
}

function orderListSortKey(order: Order): string {
  return `ORDER#${order.createdAt}#${order.orderId}`;
}

function orderListPositionSortKey(position: OrderListPosition): string {
  return `ORDER#${position.createdAt}#${position.orderId}`;
}

function toStoredOrder(order: Order, mutation: OrderMutation): StoredOrderItem {
  const merchantPartitionKey = merchantKey(order.merchantId);
  const listSortKey = orderListSortKey(order);

  return {
    pk: merchantPartitionKey,
    sk: orderKey(order.orderId),
    gsi1pk: merchantPartitionKey,
    gsi1sk: listSortKey,
    gsi2pk: `${merchantPartitionKey}#STATUS#${order.status}`,
    gsi2sk: listSortKey,
    entityType: 'ORDER',
    schemaVersion: SCHEMA_VERSION,
    status: order.status,
    version: order.version,
    order: structuredClone(order),
    mutation: structuredClone(mutation),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStoredOrder(item: unknown): Order {
  if (
    !isRecord(item) ||
    item['entityType'] !== 'ORDER' ||
    item['schemaVersion'] !== SCHEMA_VERSION ||
    !isRecord(item['order'])
  ) {
    throw new Error('The stored order item has an unsupported representation.');
  }

  return structuredClone(item['order']) as unknown as Order;
}

function readStoredIdempotency(item: unknown): StoredIdempotencyItem | undefined {
  if (
    !isRecord(item) ||
    item['entityType'] !== 'IDEMPOTENCY' ||
    item['schemaVersion'] !== SCHEMA_VERSION ||
    typeof item['requestFingerprint'] !== 'string' ||
    typeof item['orderId'] !== 'string'
  ) {
    return undefined;
  }

  return item as unknown as StoredIdempotencyItem;
}

function readStoredDeliveryProviderOrder(
  item: unknown,
): StoredDeliveryProviderOrderItem | undefined {
  if (
    !isRecord(item) ||
    item['entityType'] !== 'DELIVERY_PROVIDER_ORDER' ||
    item['schemaVersion'] !== SCHEMA_VERSION ||
    typeof item['merchantId'] !== 'string' ||
    typeof item['orderId'] !== 'string'
  ) {
    return undefined;
  }

  return item as unknown as StoredDeliveryProviderOrderItem;
}

function readStoredProcessedEvent(item: unknown): StoredProcessedEventItem | undefined {
  if (
    !isRecord(item) ||
    item['entityType'] !== 'PROCESSED_EVENT' ||
    item['schemaVersion'] !== SCHEMA_VERSION ||
    typeof item['eventFingerprint'] !== 'string'
  ) {
    return undefined;
  }

  return item as unknown as StoredProcessedEventItem;
}

function statusUpdate(tableName: string, order: StoredOrderItem, expectedVersion: number) {
  return {
    TableName: tableName,
    Key: { pk: order.pk, sk: order.sk },
    ConditionExpression:
      'attribute_exists(pk) AND attribute_exists(sk) AND #version = :expectedVersion AND gsi2sk = :listSortKey',
    UpdateExpression:
      'SET #order = :order, #status = :status, #version = :nextVersion, #mutation = :mutation, gsi2pk = :statusIndexKey',
    ExpressionAttributeNames: {
      '#order': 'order',
      '#status': 'status',
      '#version': 'version',
      '#mutation': 'mutation',
    },
    ExpressionAttributeValues: {
      ':order': order.order,
      ':status': order.status,
      ':nextVersion': order.version,
      ':expectedVersion': expectedVersion,
      ':listSortKey': order.gsi2sk,
      ':statusIndexKey': order.gsi2pk,
      ':mutation': order.mutation,
    },
  };
}

export class DynamoDbOrderRepository implements OrderRepository, ProviderWebhookRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { order, idempotencyKey: inputIdempotencyKey, requestFingerprint } = input;
    const pk = merchantKey(order.merchantId);
    const orderItem = toStoredOrder(order, input.mutation);
    const idempotencyItem: StoredIdempotencyItem = {
      pk,
      sk: idempotencyKey(inputIdempotencyKey),
      entityType: 'IDEMPOTENCY',
      schemaVersion: SCHEMA_VERSION,
      requestFingerprint,
      orderId: order.orderId,
      createdAt: order.createdAt,
    };
    const merchantOrderIdItem: StoredMerchantOrderIdItem = {
      pk,
      sk: merchantOrderIdKey(order.merchantOrderId),
      entityType: 'MERCHANT_ORDER_ID',
      schemaVersion: SCHEMA_VERSION,
      orderId: order.orderId,
      createdAt: order.createdAt,
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [orderItem, idempotencyItem, merchantOrderIdItem].map((Item) => ({
            Put: {
              TableName: this.tableName,
              Item,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          })),
        }),
      );

      return { outcome: 'created', order: structuredClone(order) };
    } catch (error) {
      if (
        !(error instanceof TransactionCanceledException) ||
        !error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
      ) {
        throw error;
      }

      return this.resolveCreateConflict(input);
    }
  }

  async get(merchantId: MerchantId, orderId: OrderId): Promise<Order | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: merchantKey(merchantId), sk: orderKey(orderId) },
        ConsistentRead: true,
      }),
    );

    return result.Item === undefined ? undefined : readStoredOrder(result.Item);
  }

  async getByDeliveryProviderOrderId(
    deliveryProviderCode: Order['provider']['deliveryProviderCode'],
    deliveryProviderOrderId: string,
  ): Promise<Order | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: deliveryProviderKey(deliveryProviderCode),
          sk: orderKey(deliveryProviderOrderId as OrderId),
        },
        ConsistentRead: true,
      }),
    );
    const mapping = readStoredDeliveryProviderOrder(result.Item);
    return mapping === undefined ? undefined : this.get(mapping.merchantId, mapping.orderId);
  }

  async list(input: ListOrdersInput): Promise<ListOrdersResult> {
    assertOrderPageLimit(input.limit);

    const pk = merchantKey(input.merchantId);
    const hasStatusFilter = input.status !== undefined;
    const indexName = hasStatusFilter ? 'byMerchantStatusCreatedAt' : 'byMerchantCreatedAt';
    const indexPkName = hasStatusFilter ? 'gsi2pk' : 'gsi1pk';
    const indexSkName = hasStatusFilter ? 'gsi2sk' : 'gsi1sk';
    const indexPk = hasStatusFilter ? `${pk}#STATUS#${input.status}` : pk;
    const exclusiveStartKey = input.position
      ? {
          pk,
          sk: orderKey(input.position.orderId),
          [indexPkName]: indexPk,
          [indexSkName]: orderListPositionSortKey(input.position),
        }
      : undefined;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: indexName,
        KeyConditionExpression: '#indexPk = :indexPk',
        ExpressionAttributeNames: { '#indexPk': indexPkName },
        ExpressionAttributeValues: { ':indexPk': indexPk },
        ScanIndexForward: false,
        Limit: input.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const orders = (result.Items ?? []).map(readStoredOrder);
    const lastOrder = orders[orders.length - 1];

    if (result.LastEvaluatedKey !== undefined && lastOrder === undefined) {
      throw new Error('The paginated order query returned an invalid continuation position.');
    }

    return {
      orders,
      ...(result.LastEvaluatedKey !== undefined && lastOrder
        ? { nextPosition: { createdAt: lastOrder.createdAt, orderId: lastOrder.orderId } }
        : {}),
    };
  }

  async saveStatusChange(
    order: Order,
    expectedVersion: number,
    mutation: OrderStatusChangedMutation,
  ): Promise<void> {
    assertNextOrderVersion(order, expectedVersion);
    const storedOrder = toStoredOrder(order, mutation);
    const deliveryProviderOrderId =
      mutation.previousStatus === 'PENDING_SUBMISSION' && order.status === 'SUBMITTED'
        ? order.provider.deliveryProviderOrderId
        : undefined;

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                ...statusUpdate(this.tableName, storedOrder, expectedVersion),
              },
            },
            ...(deliveryProviderOrderId === undefined
              ? []
              : [
                  {
                    Put: {
                      TableName: this.tableName,
                      Item: {
                        pk: deliveryProviderKey(order.provider.deliveryProviderCode),
                        sk: orderKey(deliveryProviderOrderId as OrderId),
                        entityType: 'DELIVERY_PROVIDER_ORDER',
                        schemaVersion: SCHEMA_VERSION,
                        merchantId: order.merchantId,
                        orderId: order.orderId,
                        createdAt: order.updatedAt,
                      } satisfies StoredDeliveryProviderOrderItem,
                      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
                    },
                  },
                ]),
          ],
        }),
      );
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      const currentOrder = await this.get(order.merchantId, order.orderId);
      if (!currentOrder) {
        throw new OrderNotFoundError();
      }
      if (currentOrder.version !== expectedVersion) {
        throw new OrderVersionConflictError(currentOrder.version);
      }
      if (deliveryProviderOrderId !== undefined) {
        throw new DeliveryProviderOrderIdConflictError();
      }
      throw new OrderVersionConflictError(currentOrder.version);
    }
  }

  async recordProviderWebhook(
    input: RecordProviderWebhookInput,
  ): Promise<RecordProviderWebhookResult> {
    const changedOrder = input.changedOrder;
    if ((changedOrder === undefined) !== (input.mutation === undefined)) {
      throw new TypeError('A changed webhook order and its mutation must be supplied together.');
    }
    if (changedOrder !== undefined) {
      assertNextOrderVersion(changedOrder, input.currentOrder.version);
    }

    const eventItem: StoredProcessedEventItem = {
      pk: processedEventConsumerKey(),
      sk: eventKey(input.eventId),
      entityType: 'PROCESSED_EVENT',
      schemaVersion: SCHEMA_VERSION,
      eventFingerprint: input.eventFingerprint,
      deliveryProviderOrderId: input.deliveryProviderOrderId,
      processedAt: input.processedAt,
    };
    const orderKeyValue = {
      pk: merchantKey(input.currentOrder.merchantId),
      sk: orderKey(input.currentOrder.orderId),
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            changedOrder === undefined
              ? {
                  ConditionCheck: {
                    TableName: this.tableName,
                    Key: orderKeyValue,
                    ConditionExpression: '#version = :expectedVersion',
                    ExpressionAttributeNames: { '#version': 'version' },
                    ExpressionAttributeValues: {
                      ':expectedVersion': input.currentOrder.version,
                    },
                  },
                }
              : {
                  Update: {
                    ...statusUpdate(
                      this.tableName,
                      toStoredOrder(changedOrder, input.mutation as OrderStatusChangedMutation),
                      input.currentOrder.version,
                    ),
                  },
                },
            {
              Put: {
                TableName: this.tableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );
      return 'recorded';
    } catch (error: unknown) {
      if (!(error instanceof TransactionCanceledException)) {
        throw error;
      }

      const eventResult = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: eventItem.pk, sk: eventItem.sk },
          ConsistentRead: true,
        }),
      );
      const existingEvent = readStoredProcessedEvent(eventResult.Item);
      if (existingEvent !== undefined) {
        if (existingEvent.eventFingerprint === input.eventFingerprint) {
          return 'duplicate';
        }
        throw new ProviderEventIdConflictError();
      }

      const currentOrder = await this.get(
        input.currentOrder.merchantId,
        input.currentOrder.orderId,
      );
      if (currentOrder === undefined) {
        throw new OrderNotFoundError();
      }
      throw new OrderVersionConflictError(currentOrder.version);
    }
  }

  private async resolveCreateConflict(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { order, idempotencyKey: inputIdempotencyKey, requestFingerprint } = input;
    const pk = merchantKey(order.merchantId);
    const idempotencyResult = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk: idempotencyKey(inputIdempotencyKey) },
        ConsistentRead: true,
      }),
    );
    const existingIdempotency = readStoredIdempotency(idempotencyResult.Item);

    if (existingIdempotency) {
      if (existingIdempotency.requestFingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError();
      }

      const replayedOrder = await this.get(order.merchantId, existingIdempotency.orderId);
      if (!replayedOrder) {
        throw new Error('The idempotency record refers to a missing order.');
      }

      return { outcome: 'replayed', order: replayedOrder };
    }

    const referenceResult = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk: merchantOrderIdKey(order.merchantOrderId) },
        ConsistentRead: true,
      }),
    );

    if (referenceResult.Item !== undefined) {
      throw new MerchantOrderIdConflictError();
    }

    const existingOrder = await this.get(order.merchantId, order.orderId);
    if (existingOrder) {
      throw new OrderAlreadyExistsError();
    }

    throw new Error('The order transaction was cancelled without a conflicting record.');
  }
}
