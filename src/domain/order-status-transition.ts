import type { FailureDetails, Order } from './order.js';
import type { OrderStatus } from './order-status.js';

const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, ReadonlySet<OrderStatus>>> = {
  PENDING_SUBMISSION: new Set(['SUBMITTED', 'SUBMISSION_FAILED', 'CANCELLED']),
  SUBMISSION_FAILED: new Set(['PENDING_SUBMISSION', 'CANCELLED']),
  SUBMITTED: new Set(['PICKED_UP', 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED']),
  PICKED_UP: new Set(['DELIVERED', 'DELIVERY_FAILED']),
  DELIVERED: new Set(),
  DELIVERY_FAILED: new Set(),
  CANCELLED: new Set(),
};

export interface OrderStatusChange {
  readonly targetStatus: OrderStatus;
  readonly deliveryProviderOrderId?: string;
  readonly acceptedAt?: string;
  readonly failure?: FailureDetails;
}

export class InvalidOrderStatusTransitionError extends Error {
  override readonly name = 'InvalidOrderStatusTransitionError';

  constructor(
    readonly currentStatus: OrderStatus,
    readonly targetStatus: OrderStatus,
  ) {
    super(`An order cannot change from ${currentStatus} to ${targetStatus}.`);
  }
}

export class InvalidOrderStatusDetailsError extends Error {
  override readonly name = 'InvalidOrderStatusDetailsError';

  constructor(
    readonly field: 'deliveryProviderOrderId' | 'failure' | 'failure.stage',
    message: string,
  ) {
    super(message);
  }
}

function validateFailure(change: OrderStatusChange): void {
  if (change.targetStatus === 'SUBMISSION_FAILED') {
    if (change.failure === undefined) {
      throw new InvalidOrderStatusDetailsError(
        'failure',
        'Submission failure details are required.',
      );
    }
    if (change.failure.stage !== 'SUBMISSION') {
      throw new InvalidOrderStatusDetailsError(
        'failure.stage',
        'A submission failure must use the SUBMISSION stage.',
      );
    }
    return;
  }

  if (change.targetStatus === 'DELIVERY_FAILED') {
    if (change.failure === undefined) {
      throw new InvalidOrderStatusDetailsError('failure', 'Delivery failure details are required.');
    }
    if (change.failure.stage !== 'DELIVERY') {
      throw new InvalidOrderStatusDetailsError(
        'failure.stage',
        'A delivery failure must use the DELIVERY stage.',
      );
    }
    return;
  }

  if (change.failure !== undefined) {
    throw new InvalidOrderStatusDetailsError(
      'failure',
      'Failure details are only allowed for a failed status.',
    );
  }
}

function providerForChange(
  order: Order,
  change: OrderStatusChange,
  changedAt: string,
): Order['provider'] {
  const existingDeliveryProviderOrderId = order.provider.deliveryProviderOrderId;

  if (
    change.deliveryProviderOrderId !== undefined &&
    existingDeliveryProviderOrderId !== undefined &&
    change.deliveryProviderOrderId !== existingDeliveryProviderOrderId
  ) {
    throw new InvalidOrderStatusDetailsError(
      'deliveryProviderOrderId',
      'The delivery-provider order ID cannot be changed.',
    );
  }

  if (
    change.deliveryProviderOrderId !== undefined &&
    existingDeliveryProviderOrderId === undefined &&
    change.targetStatus !== 'SUBMITTED'
  ) {
    throw new InvalidOrderStatusDetailsError(
      'deliveryProviderOrderId',
      'A delivery-provider order ID can first be recorded only when confirming submission.',
    );
  }

  if (change.targetStatus === 'SUBMITTED') {
    const deliveryProviderOrderId =
      existingDeliveryProviderOrderId ?? change.deliveryProviderOrderId;
    if (deliveryProviderOrderId === undefined) {
      throw new InvalidOrderStatusDetailsError(
        'deliveryProviderOrderId',
        'A delivery-provider order ID is required when confirming submission.',
      );
    }

    return {
      ...order.provider,
      deliveryProviderOrderId,
      acceptedAt: order.provider.acceptedAt ?? change.acceptedAt ?? changedAt,
    };
  }

  if (
    change.targetStatus === 'PICKED_UP' ||
    change.targetStatus === 'DELIVERED' ||
    change.targetStatus === 'DELIVERY_FAILED'
  ) {
    if (existingDeliveryProviderOrderId === undefined || order.provider.acceptedAt === undefined) {
      throw new InvalidOrderStatusDetailsError(
        'deliveryProviderOrderId',
        'Provider acceptance must be recorded before a delivery status.',
      );
    }
  }

  return order.provider;
}

export function applyOrderStatusChange(
  order: Order,
  change: OrderStatusChange,
  changedAt: string,
): Order {
  if (change.targetStatus === order.status) {
    return order;
  }

  if (!ALLOWED_TRANSITIONS[order.status].has(change.targetStatus)) {
    throw new InvalidOrderStatusTransitionError(order.status, change.targetStatus);
  }

  if (changedAt < order.createdAt) {
    throw new RangeError('A status change cannot occur before the order was created.');
  }

  validateFailure(change);
  const provider = providerForChange(order, change, changedAt);

  return {
    orderId: order.orderId,
    merchantId: order.merchantId,
    merchantOrderId: order.merchantOrderId,
    status: change.targetStatus,
    items: order.items,
    total: order.total,
    pickup: order.pickup,
    dropoff: order.dropoff,
    provider,
    ...(change.failure === undefined ? {} : { failure: change.failure }),
    createdAt: order.createdAt,
    updatedAt: changedAt,
    version: order.version + 1,
  };
}
