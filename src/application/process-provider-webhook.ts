import { createHash } from 'node:crypto';

import type { Order } from '../domain/order.js';
import {
  applyOrderStatusChange,
  InvalidOrderStatusTransitionError,
  type OrderStatusChange,
} from '../domain/order-status-transition.js';
import type { OrderStatus } from '../domain/order-status.js';
import type { ProviderWebhookEvent } from './provider-webhook-validation.js';
import {
  type ProviderWebhookRepository,
  type RecordProviderWebhookResult,
} from './provider-webhook-repository.js';
import { OrderNotFoundError, OrderVersionConflictError } from './order-repository.js';

const MAX_CONCURRENT_WRITE_ATTEMPTS = 3;

export interface ProcessProviderWebhookDependencies {
  readonly repository: ProviderWebhookRepository;
  readonly now?: () => Date;
}

export interface ProcessProviderWebhookCommand {
  readonly event: ProviderWebhookEvent;
  readonly correlationId: string;
}

export type ProcessProviderWebhookResult =
  | { readonly outcome: 'applied'; readonly order: Order }
  | { readonly outcome: 'duplicate' | 'stale'; readonly order: Order };

function targetStatus(eventType: ProviderWebhookEvent['eventType']): OrderStatus {
  switch (eventType) {
    case 'DELIVERY_PICKED_UP':
      return 'PICKED_UP';
    case 'DELIVERY_DELIVERED':
      return 'DELIVERED';
    case 'DELIVERY_FAILED':
      return 'DELIVERY_FAILED';
    case 'DELIVERY_CANCELLED':
      return 'CANCELLED';
  }
}

function toStatusChange(event: ProviderWebhookEvent): OrderStatusChange {
  return {
    targetStatus: targetStatus(event.eventType),
    ...(event.failure === undefined ? {} : { failure: event.failure }),
  };
}

function fingerprint(event: ProviderWebhookEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function changedOrderFor(event: ProviderWebhookEvent, order: Order): Order | undefined {
  if (event.occurredAt < order.updatedAt) {
    return undefined;
  }

  try {
    const changed = applyOrderStatusChange(order, toStatusChange(event), event.occurredAt);
    return changed === order ? undefined : changed;
  } catch (error: unknown) {
    if (error instanceof InvalidOrderStatusTransitionError) {
      return undefined;
    }
    throw error;
  }
}

function result(
  recordResult: RecordProviderWebhookResult,
  currentOrder: Order,
  changedOrder: Order | undefined,
): ProcessProviderWebhookResult {
  if (recordResult === 'duplicate') {
    return { outcome: 'duplicate', order: currentOrder };
  }
  if (changedOrder === undefined) {
    return { outcome: 'stale', order: currentOrder };
  }
  return { outcome: 'applied', order: changedOrder };
}

export async function processProviderWebhook(
  dependencies: ProcessProviderWebhookDependencies,
  command: ProcessProviderWebhookCommand,
): Promise<ProcessProviderWebhookResult> {
  for (let attempt = 1; attempt <= MAX_CONCURRENT_WRITE_ATTEMPTS; attempt += 1) {
    const currentOrder = await dependencies.repository.getByProviderOrderId(
      'mock-delivery',
      command.event.providerOrderId,
    );
    if (currentOrder === undefined) {
      throw new OrderNotFoundError();
    }

    const changedOrder = changedOrderFor(command.event, currentOrder);
    try {
      const recordResult = await dependencies.repository.recordProviderWebhook({
        eventId: command.event.eventId,
        eventFingerprint: fingerprint(command.event),
        providerOrderId: command.event.providerOrderId,
        processedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        currentOrder,
        ...(changedOrder === undefined
          ? {}
          : {
              changedOrder,
              mutation: {
                kind: 'ORDER_STATUS_CHANGED',
                previousStatus: currentOrder.status,
                correlationId: command.correlationId,
                causationId: command.event.eventId,
              },
            }),
      });
      return result(recordResult, currentOrder, changedOrder);
    } catch (error: unknown) {
      if (error instanceof OrderVersionConflictError && attempt < MAX_CONCURRENT_WRITE_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }

  throw new Error('Provider webhook processing exhausted its concurrency attempts.');
}
