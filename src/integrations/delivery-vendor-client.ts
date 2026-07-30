import type { Order } from '../domain/order.js';
import type {
  DeliveryProviderAcceptance,
  DeliveryProviderSubmission,
} from './delivery-provider-contract.js';

export const VENDOR_SUBMISSION_FAILURE_CODES = [
  'TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INVALID_RESPONSE',
  'AUTHENTICATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'REQUEST_REJECTED',
] as const;

export type VendorSubmissionFailureCode = (typeof VENDOR_SUBMISSION_FAILURE_CODES)[number];

export interface VendorSubmissionErrorOptions {
  readonly code: VendorSubmissionFailureCode;
  readonly retryable: boolean;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
}

export class VendorSubmissionError extends Error {
  public readonly code: VendorSubmissionFailureCode;
  public readonly retryable: boolean;
  public readonly statusCode?: number;
  public readonly retryAfterMs?: number;

  public constructor(options: VendorSubmissionErrorOptions) {
    super(options.message);
    this.name = 'VendorSubmissionError';
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

export interface DeliveryVendorClient {
  submitDelivery(order: Order, correlationId: string): Promise<DeliveryProviderAcceptance>;
}

export interface CreateDeliveryVendorClientOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly timeoutMs: number;
}

const MAX_RETRY_AFTER_MS = 60_000;

function toSubmission(order: Order): DeliveryProviderSubmission {
  return {
    platformOrderId: order.orderId,
    merchantOrderId: order.merchantOrderId,
    items: order.items.map((item) => ({
      itemReference: item.itemReference,
      quantity: item.quantity,
    })),
    pickup: order.pickup,
    dropoff: order.dropoff,
  };
}

function isAcceptance(value: unknown): value is DeliveryProviderAcceptance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['deliveryProviderOrderId'] === 'string' &&
    candidate['deliveryProviderOrderId'].length >= 1 &&
    candidate['deliveryProviderOrderId'].length <= 128 &&
    candidate['status'] === 'ACCEPTED' &&
    typeof candidate['acceptedAt'] === 'string' &&
    Number.isFinite(Date.parse(candidate['acceptedAt']))
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The mapped provider error remains more useful than a body cleanup error.
  }
}

function mapStatus(response: Response): VendorSubmissionError {
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new VendorSubmissionError({
      code: 'RATE_LIMITED',
      retryable: true,
      message: 'Delivery provider rate limit exceeded.',
      statusCode: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  if (response.status >= 500) {
    return new VendorSubmissionError({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'Delivery provider is unavailable.',
      statusCode: response.status,
    });
  }

  if (response.status === 401 || response.status === 403) {
    return new VendorSubmissionError({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      message: 'Delivery provider authentication failed.',
      statusCode: response.status,
    });
  }

  if (response.status === 409) {
    return new VendorSubmissionError({
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
      message: 'Delivery provider rejected conflicting idempotency data.',
      statusCode: response.status,
    });
  }

  if (response.status >= 400) {
    return new VendorSubmissionError({
      code: 'REQUEST_REJECTED',
      retryable: false,
      message: 'Delivery provider rejected the submission.',
      statusCode: response.status,
    });
  }

  return new VendorSubmissionError({
    code: 'INVALID_RESPONSE',
    retryable: true,
    message: 'Delivery provider returned an unexpected response.',
    statusCode: response.status,
  });
}

function mapFetchError(error: unknown): VendorSubmissionError {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new VendorSubmissionError({
      code: 'TIMEOUT',
      retryable: true,
      message: 'Delivery provider request timed out.',
    });
  }

  return new VendorSubmissionError({
    code: 'NETWORK_ERROR',
    retryable: true,
    message: 'Delivery provider could not be reached.',
  });
}

export function createDeliveryVendorClient(
  options: CreateDeliveryVendorClientOptions,
): DeliveryVendorClient {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('Delivery provider URL must use HTTP or HTTPS.');
  }
  if (options.authToken.length === 0) {
    throw new Error('Delivery provider auth token must not be empty.');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Delivery provider timeout must be a positive integer.');
  }

  const deliveryUrl = new URL('/deliveries', baseUrl);

  return {
    async submitDelivery(order: Order, correlationId: string): Promise<DeliveryProviderAcceptance> {
      if (correlationId.length === 0) {
        throw new Error('Correlation ID must not be empty.');
      }

      let response: Response;
      try {
        response = await fetch(deliveryUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.authToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': order.provider.deliveryProviderSubmissionKey,
            'X-Correlation-Id': correlationId,
          },
          body: JSON.stringify(toSubmission(order)),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error: unknown) {
        throw mapFetchError(error);
      }

      if (response.status !== 201) {
        const mappedError = mapStatus(response);
        await discard(response);
        throw mappedError;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VendorSubmissionError({
          code: 'INVALID_RESPONSE',
          retryable: true,
          message: 'Delivery provider returned an unusable response.',
          statusCode: response.status,
        });
      }

      if (!isAcceptance(body)) {
        throw new VendorSubmissionError({
          code: 'INVALID_RESPONSE',
          retryable: true,
          message: 'Delivery provider returned an unusable response.',
          statusCode: response.status,
        });
      }

      return {
        deliveryProviderOrderId: body.deliveryProviderOrderId,
        status: body.status,
        acceptedAt: body.acceptedAt,
      };
    },
  };
}
