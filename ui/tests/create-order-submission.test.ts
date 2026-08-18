import { describe, expect, it, vi } from 'vitest';

import type { CreateOrderRequest, CreatedOrder } from '../src/api/contracts.js';
import {
  OrdersApiOutcomeUnknownError,
  OrdersApiRejectedError,
  type CreateOrderCommand,
  type OrdersApiClient,
} from '../src/api/orders-api-client.js';
import {
  CreateOrderSubmission,
  CreateOrderSubmissionError,
} from '../src/create-order-submission.js';
import { defaultCreateOrderRequest } from '../src/default-order.js';

const ORDER: CreatedOrder = {
  orderId: 'ord_12345678',
  merchantOrderId: 'pos-order-10042',
  status: 'AWAITING_PAYMENT',
  version: 1,
  total: { amountMinor: 1299, currency: 'RON' },
  payment: {
    status: 'NOT_STARTED',
    amount: { amountMinor: 1299, currency: 'RON' },
  },
};

function client(createOrder: OrdersApiClient['createOrder']): OrdersApiClient {
  return {
    createOrder,
    preparePaymentIntent: vi.fn<OrdersApiClient['preparePaymentIntent']>(),
    getOrder: vi.fn<OrdersApiClient['getOrder']>(),
  };
}

describe('create-order idempotency controller', () => {
  it('retries an ambiguous request with the same frozen body, key, and correlation ID', async () => {
    const commands: CreateOrderCommand[] = [];
    const createOrder = vi.fn((command: CreateOrderCommand) => {
      commands.push(command);
      if (commands.length === 1) {
        return Promise.reject(new OrdersApiOutcomeUnknownError());
      }
      return Promise.resolve(ORDER);
    });
    const submission = new CreateOrderSubmission(client(createOrder), () => 'operation-123');
    const request = defaultCreateOrderRequest('pos-order-10042');

    await expect(submission.submit(request)).rejects.toBeInstanceOf(OrdersApiOutcomeUnknownError);
    expect(submission.snapshot()).toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      idempotencyKey: 'create-order:operation-123',
      attemptCount: 1,
    });
    await expect(submission.retry()).resolves.toEqual(ORDER);

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.request).not.toBe(request);
    expect(Object.isFrozen(commands[0]?.request)).toBe(true);
    expect(submission.snapshot()).toMatchObject({ state: 'SUCCEEDED', attemptCount: 2 });
  });

  it('blocks overlapping attempts before a second API call can start', async () => {
    let resolveRequest: ((order: CreatedOrder) => void) | undefined;
    const createOrder = vi.fn(
      () =>
        new Promise<CreatedOrder>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const submission = new CreateOrderSubmission(client(createOrder), () => 'operation-123');
    const pending = submission.submit(defaultCreateOrderRequest('pos-order-10042'));

    expect(submission.snapshot().state).toBe('IN_FLIGHT');
    expect(() => submission.submit(defaultCreateOrderRequest('pos-order-10042'))).toThrow(
      CreateOrderSubmissionError,
    );
    expect(createOrder).toHaveBeenCalledTimes(1);

    resolveRequest?.(ORDER);
    await expect(pending).resolves.toEqual(ORDER);
  });

  it('requires an explicit reset after a known rejection before generating a new key', async () => {
    const keys: string[] = [];
    const createOrder = vi
      .fn<OrdersApiClient['createOrder']>()
      .mockRejectedValueOnce(
        new OrdersApiRejectedError(422, {
          status: 422,
          code: 'VALIDATION_ERROR',
          title: 'Request validation failed',
          detail: 'The request is invalid.',
        }),
      )
      .mockResolvedValueOnce(ORDER);
    const submission = new CreateOrderSubmission(client(createOrder), () => {
      const key = `operation-${String(keys.length + 1)}`;
      keys.push(key);
      return key;
    });
    const request: CreateOrderRequest = defaultCreateOrderRequest('pos-order-10042');

    await expect(submission.submit(request)).rejects.toBeInstanceOf(OrdersApiRejectedError);
    expect(submission.snapshot().state).toBe('REJECTED');
    expect(() => submission.submit(request)).toThrow(CreateOrderSubmissionError);

    submission.reset();
    await expect(submission.submit(request)).resolves.toEqual(ORDER);
    expect(createOrder.mock.calls.map(([command]) => command.idempotencyKey)).toEqual([
      'create-order:operation-1',
      'create-order:operation-2',
    ]);
  });

  it('does not allow an ambiguous operation to be discarded for a new key', async () => {
    const submission = new CreateOrderSubmission(
      client(async () => Promise.reject(new OrdersApiOutcomeUnknownError())),
      () => 'operation-123',
    );
    await expect(
      submission.submit(defaultCreateOrderRequest('pos-order-10042')),
    ).rejects.toBeInstanceOf(OrdersApiOutcomeUnknownError);

    expect(() => {
      submission.reset();
    }).toThrow(CreateOrderSubmissionError);
  });
});
