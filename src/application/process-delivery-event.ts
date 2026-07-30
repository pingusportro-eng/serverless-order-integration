import {
  OrderNotFoundError,
  OrderVersionConflictError,
  type OrderRepository,
} from './order-repository.js';
import { asOrderId, type FailureDetails, type Order } from '../domain/order.js';
import { applyOrderStatusChange } from '../domain/order-status-transition.js';
import type { DeliveryRequestedEvent } from '../events/delivery-requested-event.js';
import type { DeliveryVendorClient } from '../integrations/delivery-vendor-client.js';
import { VendorSubmissionError } from '../integrations/delivery-vendor-client.js';

export interface ProcessDeliveryEventDependencies {
  readonly repository: OrderRepository;
  readonly vendorClient: DeliveryVendorClient;
  readonly now?: () => Date;
}

export type ProcessDeliveryEventOutcome =
  | { readonly outcome: 'submitted'; readonly order: Order }
  | { readonly outcome: 'submission_failed'; readonly order: Order }
  | { readonly outcome: 'duplicate_or_stale'; readonly order: Order };

export class DeliveryReconciliationRequiredError extends Error {
  override readonly name = 'DeliveryReconciliationRequiredError';

  constructor() {
    super('The stored order does not prove that the provider submission outcome was recorded.');
  }
}

function validateEventAgainstOrder(event: DeliveryRequestedEvent, order: Order): void {
  if (order.merchantId !== event.payload.merchantId) {
    throw new Error('Delivery event merchant does not match the stored order.');
  }
  if (
    order.provider.deliveryProviderSubmissionKey !== event.payload.deliveryProviderSubmissionKey
  ) {
    throw new Error(
      'The delivery-provider submission key in the event does not match the stored order.',
    );
  }
  if (order.version < event.aggregateVersion) {
    throw new Error('Delivery event refers to an order version that is not available.');
  }
}

function progressedAfter(event: DeliveryRequestedEvent, order: Order): boolean {
  return order.version > event.aggregateVersion;
}

function safelyCompletedBefore(event: DeliveryRequestedEvent, order: Order): boolean {
  if (!progressedAfter(event, order)) {
    return false;
  }

  return (
    order.provider.deliveryProviderOrderId !== undefined ||
    order.status === 'SUBMISSION_FAILED' ||
    (event.eventType === 'order.created' && order.status === 'PENDING_SUBMISSION')
  );
}

function submissionFailure(error: VendorSubmissionError, occurredAt: string): FailureDetails {
  return {
    stage: 'SUBMISSION',
    reasonCode: error.code,
    summary: error.message,
    occurredAt,
  };
}

async function resolveVersionConflict(
  repository: OrderRepository,
  event: DeliveryRequestedEvent,
  intendedOrder: Order,
): Promise<ProcessDeliveryEventOutcome> {
  const current = await repository.get(event.payload.merchantId, asOrderId(event.aggregateId));
  if (
    current !== undefined &&
    progressedAfter(event, current) &&
    intendedOutcomeWasRecorded(intendedOrder, current)
  ) {
    return { outcome: 'duplicate_or_stale', order: current };
  }
  if (current !== undefined && progressedAfter(event, current)) {
    throw new DeliveryReconciliationRequiredError();
  }
  throw new OrderVersionConflictError(current?.version ?? event.aggregateVersion);
}

function intendedOutcomeWasRecorded(intended: Order, current: Order): boolean {
  if (intended.status === 'SUBMITTED') {
    return (
      current.provider.deliveryProviderOrderId === intended.provider.deliveryProviderOrderId &&
      current.provider.acceptedAt === intended.provider.acceptedAt
    );
  }

  return (
    intended.status === 'SUBMISSION_FAILED' &&
    current.status === 'SUBMISSION_FAILED' &&
    current.failure?.stage === 'SUBMISSION' &&
    current.failure.reasonCode === intended.failure?.reasonCode
  );
}

export async function processDeliveryEvent(
  dependencies: ProcessDeliveryEventDependencies,
  event: DeliveryRequestedEvent,
): Promise<ProcessDeliveryEventOutcome> {
  const order = await dependencies.repository.get(
    event.payload.merchantId,
    asOrderId(event.aggregateId),
  );
  if (order === undefined) {
    throw new OrderNotFoundError();
  }

  validateEventAgainstOrder(event, order);
  if (progressedAfter(event, order)) {
    if (safelyCompletedBefore(event, order)) {
      return { outcome: 'duplicate_or_stale', order };
    }
    throw new DeliveryReconciliationRequiredError();
  }
  if (order.status !== 'PENDING_SUBMISSION') {
    throw new Error('Delivery event is inconsistent with the current order state.');
  }

  let changedOrder: Order;
  let outcome: 'submitted' | 'submission_failed';
  try {
    const acceptance = await dependencies.vendorClient.submitDelivery(order, event.correlationId);
    changedOrder = applyOrderStatusChange(
      order,
      {
        targetStatus: 'SUBMITTED',
        deliveryProviderOrderId: acceptance.deliveryProviderOrderId,
        acceptedAt: acceptance.acceptedAt,
      },
      (dependencies.now ?? (() => new Date()))().toISOString(),
    );
    outcome = 'submitted';
  } catch (error: unknown) {
    if (!(error instanceof VendorSubmissionError) || error.retryable) {
      throw error;
    }
    const failedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    changedOrder = applyOrderStatusChange(
      order,
      {
        targetStatus: 'SUBMISSION_FAILED',
        failure: submissionFailure(error, failedAt),
      },
      failedAt,
    );
    outcome = 'submission_failed';
  }

  try {
    await dependencies.repository.saveStatusChange(changedOrder, order.version, {
      kind: 'ORDER_STATUS_CHANGED',
      previousStatus: order.status,
      correlationId: event.correlationId,
      causationId: event.eventId,
    });
  } catch (error: unknown) {
    if (error instanceof OrderVersionConflictError) {
      return resolveVersionConflict(dependencies.repository, event, changedOrder);
    }
    throw error;
  }

  return { outcome, order: changedOrder };
}
