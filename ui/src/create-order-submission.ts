import {
  beginIdempotentOperationAttempt,
  createIdempotentOperation,
  InvalidIdempotentOperationError,
  markIdempotentOperationOutcome,
  type IdempotentOperation,
  type IdempotentOperationState,
} from '../../src/client/idempotent-operation.js';
import {
  OrdersApiOutcomeUnknownError,
  OrdersApiRejectedError,
  type OrdersApiClient,
} from './api/orders-api-client.js';
import type { CreateOrderRequest, CreatedOrder } from './api/contracts.js';

export interface CreateOrderSubmissionSnapshot {
  readonly state: 'NOT_STARTED' | IdempotentOperationState;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly attemptCount: number;
  readonly order?: CreatedOrder;
  readonly error?: string;
}

export class CreateOrderSubmissionError extends Error {
  override readonly name = 'CreateOrderSubmissionError';
}

function requestFingerprint(request: CreateOrderRequest): string {
  return JSON.stringify(request);
}

export class CreateOrderSubmission {
  private operation: IdempotentOperation<CreateOrderRequest> | undefined;
  private correlationId: string | undefined;
  private order: CreatedOrder | undefined;
  private error: string | undefined;

  constructor(
    private readonly client: OrdersApiClient,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  snapshot(): CreateOrderSubmissionSnapshot {
    return {
      state: this.operation?.state ?? 'NOT_STARTED',
      ...(this.operation === undefined ? {} : { idempotencyKey: this.operation.idempotencyKey }),
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      attemptCount: this.operation?.attemptCount ?? 0,
      ...(this.order === undefined ? {} : { order: this.order }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  submit(request: CreateOrderRequest): Promise<CreatedOrder> {
    if (this.operation !== undefined) {
      throw new CreateOrderSubmissionError(
        `The existing create-order operation is ${this.operation.state}; reset or retry it explicitly.`,
      );
    }
    const operationId = this.createId();
    this.correlationId = `ui-create-order:${operationId}`;
    this.operation = createIdempotentOperation(
      `create-order:${operationId}`,
      request,
      requestFingerprint(request),
    );
    return this.attempt();
  }

  retry(): Promise<CreatedOrder> {
    if (this.operation?.state !== 'OUTCOME_UNKNOWN') {
      throw new CreateOrderSubmissionError(
        'Only an operation with an unknown outcome can be retried.',
      );
    }
    return this.attempt();
  }

  reset(): void {
    if (this.operation?.state === 'IN_FLIGHT' || this.operation?.state === 'OUTCOME_UNKNOWN') {
      throw new CreateOrderSubmissionError(
        'An in-flight or ambiguous operation cannot be replaced with a new idempotency key.',
      );
    }
    this.operation = undefined;
    this.correlationId = undefined;
    this.order = undefined;
    this.error = undefined;
  }

  private async attempt(): Promise<CreatedOrder> {
    if (this.operation === undefined || this.correlationId === undefined) {
      throw new CreateOrderSubmissionError('The create-order operation has not been initialized.');
    }
    try {
      this.operation = beginIdempotentOperationAttempt(
        this.operation,
        this.operation.requestFingerprint,
      );
    } catch (error) {
      if (error instanceof InvalidIdempotentOperationError) {
        throw new CreateOrderSubmissionError(error.message);
      }
      throw error;
    }
    this.error = undefined;

    try {
      const order = await this.client.createOrder({
        request: this.operation.request,
        idempotencyKey: this.operation.idempotencyKey,
        correlationId: this.correlationId,
      });
      this.operation = markIdempotentOperationOutcome(this.operation, 'SUCCEEDED');
      this.order = order;
      return order;
    } catch (error) {
      const rejected = error instanceof OrdersApiRejectedError;
      this.operation = markIdempotentOperationOutcome(
        this.operation,
        rejected ? 'REJECTED' : 'OUTCOME_UNKNOWN',
      );
      this.error =
        error instanceof OrdersApiRejectedError || error instanceof OrdersApiOutcomeUnknownError
          ? error.message
          : 'The outcome is unknown; retry the exact operation with the same key.';
      throw error;
    }
  }
}
