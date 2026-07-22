import { asOrderId, type MerchantId, type Order } from '../domain/order.js';
import {
  applyOrderStatusChange,
  type OrderStatusChange,
} from '../domain/order-status-transition.js';
import type { ValidationIssue } from '../http/problem-details.js';
import {
  validateChangeOrderStatusRequest,
  type ChangeOrderStatusRequest,
} from './change-order-status-validation.js';
import {
  OrderNotFoundError,
  OrderVersionConflictError,
  type OrderRepository,
} from './order-repository.js';

export interface ChangeOrderStatusDependencies {
  readonly repository: OrderRepository;
  readonly now?: () => Date;
}

export interface ChangeOrderStatusCommand {
  readonly merchantId: MerchantId;
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly body: unknown;
}

export type ChangeOrderStatusResult =
  | { readonly outcome: 'invalid'; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: 'changed' | 'unchanged'; readonly order: Order };

function toDomainChange(request: ChangeOrderStatusRequest): OrderStatusChange {
  return {
    targetStatus: request.targetStatus,
    ...(request.providerOrderId === undefined ? {} : { providerOrderId: request.providerOrderId }),
    ...(request.failure === undefined ? {} : { failure: request.failure }),
  };
}

export async function changeOrderStatus(
  dependencies: ChangeOrderStatusDependencies,
  command: ChangeOrderStatusCommand,
): Promise<ChangeOrderStatusResult> {
  const validation = validateChangeOrderStatusRequest(command.body);
  if (!validation.valid) {
    return { outcome: 'invalid', issues: validation.issues };
  }

  const currentOrder = await dependencies.repository.get(
    command.merchantId,
    asOrderId(command.orderId),
  );
  if (currentOrder === undefined) {
    throw new OrderNotFoundError();
  }
  if (currentOrder.version !== command.expectedVersion) {
    throw new OrderVersionConflictError(currentOrder.version);
  }

  const changedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const changedOrder = applyOrderStatusChange(
    currentOrder,
    toDomainChange(validation.value),
    changedAt,
  );
  if (changedOrder === currentOrder) {
    return { outcome: 'unchanged', order: currentOrder };
  }

  await dependencies.repository.saveStatusChange(changedOrder, command.expectedVersion);
  return { outcome: 'changed', order: changedOrder };
}
