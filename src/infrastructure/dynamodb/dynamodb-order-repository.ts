import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

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

const SCHEMA_VERSION = 1;

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

interface StoredMerchantReferenceItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'ORDER_REFERENCE';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly orderId: OrderId;
  readonly createdAt: string;
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

function merchantReferenceKey(value: string): string {
  return `ORDER_REFERENCE#${value}`;
}

function orderListSortKey(order: Order): string {
  return `ORDER#${order.createdAt}#${order.orderId}`;
}

function toStoredOrder(order: Order): StoredOrderItem {
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

export class DynamoDbOrderRepository implements OrderRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { order, idempotencyKey: inputIdempotencyKey, requestFingerprint } = input;
    const pk = merchantKey(order.merchantId);
    const orderItem = toStoredOrder(order);
    const idempotencyItem: StoredIdempotencyItem = {
      pk,
      sk: idempotencyKey(inputIdempotencyKey),
      entityType: 'IDEMPOTENCY',
      schemaVersion: SCHEMA_VERSION,
      requestFingerprint,
      orderId: order.orderId,
      createdAt: order.createdAt,
    };
    const merchantReferenceItem: StoredMerchantReferenceItem = {
      pk,
      sk: merchantReferenceKey(order.merchantOrderReference),
      entityType: 'ORDER_REFERENCE',
      schemaVersion: SCHEMA_VERSION,
      orderId: order.orderId,
      createdAt: order.createdAt,
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [orderItem, idempotencyItem, merchantReferenceItem].map((Item) => ({
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

  async saveStatusChange(order: Order, expectedVersion: number): Promise<void> {
    assertNextOrderVersion(order, expectedVersion);
    const storedOrder = toStoredOrder(order);

    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: storedOrder.pk, sk: storedOrder.sk },
          ConditionExpression:
            'attribute_exists(pk) AND attribute_exists(sk) AND #version = :expectedVersion AND gsi2sk = :listSortKey',
          UpdateExpression:
            'SET #order = :order, #status = :status, #version = :nextVersion, gsi2pk = :statusIndexKey',
          ExpressionAttributeNames: {
            '#order': 'order',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':order': storedOrder.order,
            ':status': storedOrder.status,
            ':nextVersion': storedOrder.version,
            ':expectedVersion': expectedVersion,
            ':listSortKey': storedOrder.gsi2sk,
            ':statusIndexKey': storedOrder.gsi2pk,
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }

      const currentOrder = await this.get(order.merchantId, order.orderId);
      if (!currentOrder) {
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
        Key: { pk, sk: merchantReferenceKey(order.merchantOrderReference) },
        ConsistentRead: true,
      }),
    );

    if (referenceResult.Item !== undefined) {
      throw new MerchantReferenceConflictError();
    }

    const existingOrder = await this.get(order.merchantId, order.orderId);
    if (existingOrder) {
      throw new OrderAlreadyExistsError();
    }

    throw new Error('The order transaction was cancelled without a conflicting record.');
  }
}
