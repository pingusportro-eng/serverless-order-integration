import {
  PREPARED_PAYMENT_STATUSES,
  type CreateOrderRequest,
  type CreatedOrder,
  type Money,
  type PreparedPaymentIntent,
  type ProblemDetails,
} from './contracts.js';

export type BrowserAuthorization =
  | { readonly mode: 'local-bypass' }
  | { readonly mode: 'bearer'; readonly accessToken: () => string | undefined };

export interface CreateOrderCommand {
  readonly request: CreateOrderRequest;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface PreparePaymentIntentCommand {
  readonly orderId: string;
  readonly correlationId: string;
}

export interface OrdersApiClient {
  createOrder(command: CreateOrderCommand): Promise<CreatedOrder>;
  preparePaymentIntent(command: PreparePaymentIntentCommand): Promise<PreparedPaymentIntent>;
}

export class OrdersApiRejectedError extends Error {
  override readonly name = 'OrdersApiRejectedError';

  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail);
  }
}

export class OrdersApiOutcomeUnknownError extends Error {
  override readonly name = 'OrdersApiOutcomeUnknownError';

  constructor(
    message = 'The create-order outcome is unknown and must be retried with the same key.',
  ) {
    super(message);
  }
}

export class PaymentPreparationRejectedError extends Error {
  override readonly name = 'PaymentPreparationRejectedError';

  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail);
  }
}

export class PaymentPreparationOutcomeUnknownError extends Error {
  override readonly name = 'PaymentPreparationOutcomeUnknownError';

  constructor(
    message = 'Payment preparation has an unknown outcome and can be retried for the same order.',
  ) {
    super(message);
  }
}

export class BrowserAuthenticationRequiredError extends Error {
  override readonly name = 'BrowserAuthenticationRequiredError';

  constructor() {
    super('A Cognito access token is required.');
  }
}

type BrowserFetch = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMoney(value: unknown): Money | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const amountMinor = value['amountMinor'];
  const currency = value['currency'];
  return Number.isSafeInteger(amountMinor) &&
    (amountMinor as number) >= 0 &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
    ? { amountMinor: amountMinor as number, currency }
    : undefined;
}

function readCreatedOrder(value: unknown): CreatedOrder | undefined {
  if (!isRecord(value) || !isRecord(value['payment'])) {
    return undefined;
  }
  const total = readMoney(value['total']);
  const paymentAmount = readMoney(value['payment']['amount']);
  if (
    typeof value['orderId'] !== 'string' ||
    typeof value['merchantOrderId'] !== 'string' ||
    value['status'] !== 'AWAITING_PAYMENT' ||
    !Number.isSafeInteger(value['version']) ||
    (value['version'] as number) < 1 ||
    value['payment']['status'] !== 'NOT_STARTED' ||
    total === undefined ||
    paymentAmount === undefined
  ) {
    return undefined;
  }
  return {
    orderId: value['orderId'],
    merchantOrderId: value['merchantOrderId'],
    status: 'AWAITING_PAYMENT',
    version: value['version'] as number,
    total,
    payment: { status: 'NOT_STARTED', amount: paymentAmount },
  };
}

function readPreparedPaymentIntent(value: unknown): PreparedPaymentIntent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const amount = readMoney(value['amount']);
  const status = value['status'];
  if (
    typeof value['orderId'] !== 'string' ||
    !Number.isSafeInteger(value['orderVersion']) ||
    (value['orderVersion'] as number) < 1 ||
    typeof value['stripePaymentIntentId'] !== 'string' ||
    value['stripePaymentIntentId'].length === 0 ||
    !PREPARED_PAYMENT_STATUSES.some((candidate) => candidate === status) ||
    amount === undefined ||
    typeof value['clientSecret'] !== 'string' ||
    value['clientSecret'].length === 0
  ) {
    return undefined;
  }
  return {
    orderId: value['orderId'],
    orderVersion: value['orderVersion'] as number,
    stripePaymentIntentId: value['stripePaymentIntentId'],
    status: status as PreparedPaymentIntent['status'],
    amount,
    clientSecret: value['clientSecret'],
  };
}

function fallbackProblem(status: number): ProblemDetails {
  return {
    status,
    code: 'HTTP_ERROR',
    title: 'Request rejected',
    detail: `The orders API rejected the request with HTTP ${String(status)}.`,
  };
}

function readProblem(value: unknown, status: number): ProblemDetails {
  if (
    !isRecord(value) ||
    typeof value['code'] !== 'string' ||
    typeof value['title'] !== 'string' ||
    typeof value['detail'] !== 'string'
  ) {
    return fallbackProblem(status);
  }
  return {
    status,
    code: value['code'],
    title: value['title'],
    detail: value['detail'],
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function authorizationHeader(
  authorization: BrowserAuthorization,
): Readonly<Record<string, string>> {
  if (authorization.mode === 'local-bypass') {
    return {};
  }
  const accessToken = authorization.accessToken()?.trim();
  if (!accessToken) {
    throw new BrowserAuthenticationRequiredError();
  }
  return { Authorization: `Bearer ${accessToken}` };
}

function canSafelyReplaceOperation(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isDefinitePaymentRejection(status: number, problem: ProblemDetails): boolean {
  return (
    canSafelyReplaceOperation(status) ||
    (status === 502 && problem.code === 'PAYMENT_PROVIDER_ERROR')
  );
}

export function createOrdersApiClient(input: {
  readonly baseUrl: string;
  readonly authorization: BrowserAuthorization;
  readonly fetch?: BrowserFetch;
}): OrdersApiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const request = input.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async createOrder(command) {
      let response: Response;
      try {
        response = await request(`${baseUrl}/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': command.idempotencyKey,
            'X-Correlation-Id': command.correlationId,
            ...authorizationHeader(input.authorization),
          },
          body: JSON.stringify(command.request),
        });
      } catch (error) {
        if (error instanceof BrowserAuthenticationRequiredError) {
          throw error;
        }
        throw new OrdersApiOutcomeUnknownError();
      }

      const body = parseJson(await response.text());
      if (!response.ok) {
        const problem = readProblem(body, response.status);
        if (canSafelyReplaceOperation(response.status)) {
          throw new OrdersApiRejectedError(response.status, problem);
        }
        throw new OrdersApiOutcomeUnknownError(
          `${problem.detail} Retry with the same idempotency key.`,
        );
      }

      const order = readCreatedOrder(body);
      if (order === undefined) {
        throw new OrdersApiOutcomeUnknownError(
          'The orders API returned an invalid success response; retry with the same key.',
        );
      }
      return order;
    },

    async preparePaymentIntent(command) {
      let response: Response;
      try {
        response = await request(
          `${baseUrl}/orders/${encodeURIComponent(command.orderId)}/payment-intents`,
          {
            method: 'POST',
            headers: {
              'X-Correlation-Id': command.correlationId,
              ...authorizationHeader(input.authorization),
            },
          },
        );
      } catch (error) {
        if (error instanceof BrowserAuthenticationRequiredError) {
          throw error;
        }
        throw new PaymentPreparationOutcomeUnknownError();
      }

      const body = parseJson(await response.text());
      if (!response.ok) {
        const problem = readProblem(body, response.status);
        if (isDefinitePaymentRejection(response.status, problem)) {
          throw new PaymentPreparationRejectedError(response.status, problem);
        }
        throw new PaymentPreparationOutcomeUnknownError(
          `${problem.detail} Retry payment preparation for the same order.`,
        );
      }

      const preparedPayment = readPreparedPaymentIntent(body);
      if (preparedPayment === undefined || preparedPayment.orderId !== command.orderId) {
        throw new PaymentPreparationOutcomeUnknownError(
          'The orders API returned an invalid payment response; retry for the same order.',
        );
      }
      return preparedPayment;
    },
  };
}
