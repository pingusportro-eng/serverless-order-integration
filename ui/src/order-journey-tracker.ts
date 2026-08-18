import type { TrackedOrder } from './api/contracts.js';
import {
  BrowserAuthenticationRequiredError,
  OrderTrackingRejectedError,
  OrderTrackingUnavailableError,
  type OrdersApiClient,
} from './api/orders-api-client.js';

export type OrderJourneyTrackingState =
  | 'NOT_STARTED'
  | 'POLLING'
  | 'DELIVERED'
  | 'ATTENTION_REQUIRED'
  | 'TIMED_OUT'
  | 'STOPPED'
  | 'REJECTED';

export interface OrderJourneyTrackingSnapshot {
  readonly state: OrderJourneyTrackingState;
  readonly attemptCount: number;
  readonly correlationId?: string;
  readonly order?: TrackedOrder;
  readonly error?: string;
}

export interface OrderJourneyTrackerOptions {
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
  readonly createId?: () => string;
  readonly wait?: (intervalMs: number, signal: AbortSignal) => Promise<void>;
}

export class OrderJourneyTrackerError extends Error {
  override readonly name = 'OrderJourneyTrackerError';
}

function defaultWait(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = globalThis.setTimeout(finish, intervalMs);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      finish();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function requiresAttention(order: TrackedOrder): boolean {
  return (
    order.payment?.status === 'CANCELLED' ||
    order.status === 'SUBMISSION_FAILED' ||
    order.status === 'DELIVERY_FAILED' ||
    order.status === 'CANCELLED'
  );
}

export class OrderJourneyTracker {
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly createId: () => string;
  private readonly wait: (intervalMs: number, signal: AbortSignal) => Promise<void>;
  private state: OrderJourneyTrackingState = 'NOT_STARTED';
  private attemptCount = 0;
  private correlationId: string | undefined;
  private order: TrackedOrder | undefined;
  private error: string | undefined;
  private abortController: AbortController | undefined;

  constructor(
    private readonly client: OrdersApiClient,
    options: OrderJourneyTrackerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.maxAttempts = options.maxAttempts ?? 30;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.wait = options.wait ?? defaultWait;
    if (this.intervalMs < 0 || !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError(
        'Order tracking requires a non-negative interval and at least one attempt.',
      );
    }
  }

  snapshot(): OrderJourneyTrackingSnapshot {
    return {
      state: this.state,
      attemptCount: this.attemptCount,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      ...(this.order === undefined ? {} : { order: this.order }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  async start(
    orderId: string,
    onChange: (snapshot: OrderJourneyTrackingSnapshot) => void,
  ): Promise<OrderJourneyTrackingSnapshot> {
    if (this.state !== 'NOT_STARTED') {
      throw new OrderJourneyTrackerError(`Order tracking is already ${this.state}.`);
    }
    this.state = 'POLLING';
    this.correlationId = `ui-track-order:${orderId}:${this.createId()}`;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    onChange(this.snapshot());

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.wasStopped()) {
        return this.stopped();
      }
      this.attemptCount = attempt;
      this.error = undefined;
      onChange(this.snapshot());

      try {
        const order = await this.client.getOrder({
          orderId,
          correlationId: this.correlationId,
          signal,
        });
        if (this.wasStopped()) {
          return this.stopped();
        }
        this.order = order;
        if (order.status === 'DELIVERED') {
          this.state = 'DELIVERED';
          onChange(this.snapshot());
          return this.snapshot();
        }
        if (requiresAttention(order)) {
          this.state = 'ATTENTION_REQUIRED';
          this.error = `Order processing stopped in ${order.status}.`;
          onChange(this.snapshot());
          return this.snapshot();
        }
      } catch (error) {
        if (this.wasStopped()) {
          return this.stopped();
        }
        if (
          error instanceof OrderTrackingRejectedError ||
          error instanceof BrowserAuthenticationRequiredError
        ) {
          this.state = 'REJECTED';
          this.error = error.message;
          onChange(this.snapshot());
          return this.snapshot();
        }
        this.error =
          error instanceof OrderTrackingUnavailableError
            ? error.message
            : 'The latest stored order state is temporarily unavailable.';
      }

      onChange(this.snapshot());
      if (attempt < this.maxAttempts) {
        await this.wait(this.intervalMs, signal);
      }
    }

    if (this.wasStopped()) {
      return this.stopped();
    }
    this.state = 'TIMED_OUT';
    this.error = `Tracking stopped after ${String(this.maxAttempts)} bounded attempts.`;
    onChange(this.snapshot());
    return this.snapshot();
  }

  stop(): void {
    this.abortController?.abort();
  }

  private stopped(): OrderJourneyTrackingSnapshot {
    this.state = 'STOPPED';
    return this.snapshot();
  }

  private wasStopped(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }
}
