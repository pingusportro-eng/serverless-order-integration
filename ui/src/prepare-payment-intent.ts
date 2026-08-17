import type { PreparedPaymentIntent, PreparedPaymentStatus } from './api/contracts.js';
import {
  BrowserAuthenticationRequiredError,
  PaymentPreparationOutcomeUnknownError,
  PaymentPreparationRejectedError,
  type OrdersApiClient,
} from './api/orders-api-client.js';

export type PaymentPreparationState =
  'NOT_STARTED' | 'IN_FLIGHT' | 'RETRYABLE' | 'SUCCEEDED' | 'REJECTED';

export interface PaymentPreparationSnapshot {
  readonly state: PaymentPreparationState;
  readonly attemptCount: number;
  readonly correlationId?: string;
  readonly orderId?: string;
  readonly orderVersion?: number;
  readonly stripePaymentIntentId?: string;
  readonly status?: PreparedPaymentStatus;
  readonly amountLabel?: string;
  readonly error?: string;
}

export class PaymentPreparationError extends Error {
  override readonly name = 'PaymentPreparationError';
}

function amountLabel(payment: PreparedPaymentIntent): string {
  return `${(payment.amount.amountMinor / 100).toFixed(2)} ${payment.amount.currency}`;
}

export class PreparePaymentIntent {
  private state: PaymentPreparationState = 'NOT_STARTED';
  private attemptCount = 0;
  private orderId: string | undefined;
  private correlationId: string | undefined;
  private payment: PreparedPaymentIntent | undefined;
  private error: string | undefined;

  constructor(
    private readonly client: OrdersApiClient,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  snapshot(): PaymentPreparationSnapshot {
    return {
      state: this.state,
      attemptCount: this.attemptCount,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      ...(this.orderId === undefined ? {} : { orderId: this.orderId }),
      ...(this.payment === undefined
        ? {}
        : {
            orderVersion: this.payment.orderVersion,
            stripePaymentIntentId: this.payment.stripePaymentIntentId,
            status: this.payment.status,
            amountLabel: amountLabel(this.payment),
          }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  clientSecret(): string | undefined {
    return this.state === 'SUCCEEDED' ? this.payment?.clientSecret : undefined;
  }

  prepare(orderId: string): Promise<PreparedPaymentIntent> {
    if (this.state !== 'NOT_STARTED') {
      throw new PaymentPreparationError(
        `Payment preparation is ${this.state}; retry it only when it is retryable.`,
      );
    }
    this.orderId = orderId;
    this.correlationId = `ui-prepare-payment:${orderId}:${this.createId()}`;
    return this.attempt();
  }

  retry(): Promise<PreparedPaymentIntent> {
    if (this.state !== 'RETRYABLE') {
      throw new PaymentPreparationError(
        'Only retryable payment preparation can be attempted again.',
      );
    }
    return this.attempt();
  }

  private async attempt(): Promise<PreparedPaymentIntent> {
    if (this.orderId === undefined || this.correlationId === undefined) {
      throw new PaymentPreparationError('Payment preparation has not been initialized.');
    }
    this.state = 'IN_FLIGHT';
    this.attemptCount += 1;
    this.error = undefined;

    try {
      const payment = await this.client.preparePaymentIntent({
        orderId: this.orderId,
        correlationId: this.correlationId,
      });
      this.payment = payment;
      this.state = 'SUCCEEDED';
      return payment;
    } catch (error) {
      const rejected =
        error instanceof PaymentPreparationRejectedError ||
        error instanceof BrowserAuthenticationRequiredError;
      this.state = rejected ? 'REJECTED' : 'RETRYABLE';
      this.error =
        error instanceof PaymentPreparationRejectedError ||
        error instanceof PaymentPreparationOutcomeUnknownError ||
        error instanceof BrowserAuthenticationRequiredError
          ? error.message
          : 'Payment preparation has an unknown outcome; retry it for the same order.';
      throw error;
    }
  }
}
