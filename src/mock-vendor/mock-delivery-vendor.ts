import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { signWebhook } from '../http/webhook-signature.js';
import type {
  DeliveryProviderAcceptance,
  DeliveryProviderLine,
  DeliveryProviderSubmission,
} from '../integrations/delivery-provider-contract.js';

export const MOCK_VENDOR_SCENARIOS = [
  'success',
  'timeout',
  'rate-limit',
  'server-error',
  'request-rejected',
  'malformed-response',
] as const;

export type MockVendorScenario = (typeof MOCK_VENDOR_SCENARIOS)[number];

export type MockDeliveryLine = DeliveryProviderLine;
export type MockDeliverySubmission = DeliveryProviderSubmission;
export type MockDeliveryAcceptance = DeliveryProviderAcceptance;

export interface StartMockDeliveryVendorOptions {
  readonly authToken: string;
  readonly host?: string;
  readonly port?: number;
  readonly timeoutDelayMs?: number;
  readonly defaultScenario?: MockVendorScenario;
  readonly now?: () => string;
  readonly onAttempt?: (attempt: MockVendorAttempt) => void;
  readonly onActivity?: (activity: MockVendorActivity) => void;
  readonly webhook?: MockVendorWebhookOptions;
}

export interface RunningMockDeliveryVendor {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface MockVendorAttempt {
  readonly timestamp: string;
  readonly scenario: MockVendorScenario;
  readonly correlationId?: string;
  readonly idempotencyKeyDigest?: string;
  readonly statusCode: number;
}

export interface MockVendorWebhookOptions {
  readonly url: string;
  readonly signingSecret: string;
  readonly pickupDelayMs?: number;
  readonly deliveredDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
  readonly maximumAttempts?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export type MockVendorActivity =
  | {
      readonly kind: 'delivery.request.received';
      readonly timestamp: string;
      readonly method: string;
      readonly path: string;
      readonly correlationId?: string;
    }
  | {
      readonly kind: 'delivery.response.sent';
      readonly timestamp: string;
      readonly statusCode: number;
      readonly correlationId?: string;
      readonly platformOrderId?: string;
      readonly deliveryProviderOrderId?: string;
      readonly scenario?: MockVendorScenario;
    }
  | {
      readonly kind: 'webhook.request.sent';
      readonly timestamp: string;
      readonly attempt: number;
      readonly eventId: string;
      readonly eventType: 'DELIVERY_PICKED_UP' | 'DELIVERY_DELIVERED';
      readonly deliveryProviderOrderId: string;
      readonly correlationId?: string;
    }
  | {
      readonly kind: 'webhook.response.received';
      readonly timestamp: string;
      readonly attempt: number;
      readonly eventId: string;
      readonly eventType: 'DELIVERY_PICKED_UP' | 'DELIVERY_DELIVERED';
      readonly deliveryProviderOrderId: string;
      readonly statusCode: number;
      readonly correlationId?: string;
    }
  | {
      readonly kind: 'webhook.delivery.exhausted';
      readonly timestamp: string;
      readonly attempts: number;
      readonly eventId: string;
      readonly eventType: 'DELIVERY_PICKED_UP' | 'DELIVERY_DELIVERED';
      readonly deliveryProviderOrderId: string;
      readonly lastStatusCode?: number;
      readonly correlationId?: string;
    };

function fields(values: Readonly<Record<string, string | number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');
}

export function formatMockVendorActivity(activity: MockVendorActivity): string {
  switch (activity.kind) {
    case 'delivery.request.received':
      return `[VENDOR <- WORKER] ${fields({
        method: activity.method,
        path: activity.path,
        correlationId: activity.correlationId,
      })}`;
    case 'delivery.response.sent':
      return `[VENDOR -> WORKER] ${fields({
        status: activity.statusCode,
        scenario: activity.scenario,
        platformOrderId: activity.platformOrderId,
        deliveryProviderOrderId: activity.deliveryProviderOrderId,
        correlationId: activity.correlationId,
      })}`;
    case 'webhook.request.sent':
      return `[VENDOR -> API] ${fields({
        method: 'POST',
        path: '/webhooks/vendor',
        eventType: activity.eventType,
        eventId: activity.eventId,
        deliveryProviderOrderId: activity.deliveryProviderOrderId,
        correlationId: activity.correlationId,
        attempt: activity.attempt,
      })}`;
    case 'webhook.response.received':
      return `[VENDOR <- API] ${fields({
        status: activity.statusCode,
        eventType: activity.eventType,
        eventId: activity.eventId,
        deliveryProviderOrderId: activity.deliveryProviderOrderId,
        correlationId: activity.correlationId,
        attempt: activity.attempt,
      })}`;
    case 'webhook.delivery.exhausted':
      return `[VENDOR !! API] ${fields({
        outcome: 'exhausted',
        eventType: activity.eventType,
        eventId: activity.eventId,
        deliveryProviderOrderId: activity.deliveryProviderOrderId,
        correlationId: activity.correlationId,
        attempts: activity.attempts,
        lastStatus: activity.lastStatusCode,
      })}`;
  }
}

interface AcceptedSubmission {
  readonly fingerprint: string;
  readonly response: MockDeliveryAcceptance;
}

class RequestError extends Error {
  public constructor(
    public readonly statusCode: 400 | 401 | 404 | 409 | 413 | 415,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_DELAY_MS = 10_000;
const DEFAULT_WEBHOOK_PICKUP_DELAY_MS = 2_500;
const DEFAULT_WEBHOOK_DELIVERED_DELAY_MS = 2_500;
const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 1_000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;
const DEFAULT_WEBHOOK_MAXIMUM_ATTEMPTS = 3;
const SCENARIOS = new Set<string>(MOCK_VENDOR_SCENARIOS);

export function parseMockVendorScenario(value: string): MockVendorScenario {
  if (!SCENARIOS.has(value)) {
    throw new Error(
      `Mock vendor scenario must be one of ${MOCK_VENDOR_SCENARIOS.join(', ')}; received ${value}.`,
    );
  }
  return value as MockVendorScenario;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(statusCode, {
    ...headers,
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function problem(
  response: ServerResponse,
  statusCode: number,
  code: string,
  detail: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  json(response, statusCode, { code, detail }, headers);
}

function scenarioFrom(
  request: IncomingMessage,
  defaultScenario: MockVendorScenario,
): MockVendorScenario {
  const value = header(request, 'x-mock-vendor-scenario') ?? defaultScenario;
  try {
    return parseMockVendorScenario(value);
  } catch {
    throw new RequestError(400, 'INVALID_SCENARIO', 'Unknown mock vendor scenario.');
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > MAX_BODY_BYTES) {
      throw new RequestError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds 65536 bytes.');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'MALFORMED_REQUEST', 'Request body must contain valid JSON.');
  }
}

function isSubmission(value: unknown): value is MockDeliverySubmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['platformOrderId'] === 'string' &&
    typeof candidate['merchantOrderId'] === 'string' &&
    Array.isArray(candidate['items']) &&
    candidate['items'].length > 0 &&
    typeof candidate['pickup'] === 'object' &&
    candidate['pickup'] !== null &&
    typeof candidate['dropoff'] === 'object' &&
    candidate['dropoff'] !== null
  );
}

function fingerprint(value: MockDeliverySubmission): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function deliveryProviderOrderId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('base64url').slice(0, 24);
  return `delivery_${digest}`;
}

function idempotencyKeyDigest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(value).digest('hex');
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return selected;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return selected;
}

function stableWebhookEventId(
  deliveryProviderOrderIdValue: string,
  eventType: 'DELIVERY_PICKED_UP' | 'DELIVERY_DELIVERED',
): string {
  const digest = createHash('sha256')
    .update(`${deliveryProviderOrderIdValue}:${eventType}`)
    .digest('hex')
    .slice(0, 32);
  return `provider_${digest}`;
}

function retryableWebhookStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 429 || statusCode >= 500;
}

export async function startMockDeliveryVendor(
  options: StartMockDeliveryVendorOptions,
): Promise<RunningMockDeliveryVendor> {
  if (options.authToken.length === 0) {
    throw new Error('Mock vendor auth token must not be empty.');
  }

  const acceptedSubmissions = new Map<string, AcceptedSubmission>();
  const scheduledWebhookSubmissions = new Set<string>();
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutDelayMs = options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS;
  const shutdown = new AbortController();
  const isShuttingDown = (): boolean => shutdown.signal.aborted;
  const pendingWebhooks = new Set<Promise<void>>();
  const webhook = options.webhook;
  const webhookFetch = webhook?.fetch ?? globalThis.fetch;
  const pickupDelayMs = nonNegativeInteger(
    webhook?.pickupDelayMs,
    DEFAULT_WEBHOOK_PICKUP_DELAY_MS,
    'Mock vendor pickup webhook delay',
  );
  const deliveredDelayMs = nonNegativeInteger(
    webhook?.deliveredDelayMs,
    DEFAULT_WEBHOOK_DELIVERED_DELAY_MS,
    'Mock vendor delivered webhook delay',
  );
  const webhookRetryDelayMs = nonNegativeInteger(
    webhook?.retryDelayMs,
    DEFAULT_WEBHOOK_RETRY_DELAY_MS,
    'Mock vendor webhook retry delay',
  );
  const webhookTimeoutMs = positiveInteger(
    webhook?.timeoutMs,
    DEFAULT_WEBHOOK_TIMEOUT_MS,
    'Mock vendor webhook timeout',
  );
  const webhookMaximumAttempts = positiveInteger(
    webhook?.maximumAttempts,
    DEFAULT_WEBHOOK_MAXIMUM_ATTEMPTS,
    'Mock vendor webhook maximum attempts',
  );

  if (webhook !== undefined) {
    let parsedWebhookUrl: URL;
    try {
      parsedWebhookUrl = new URL(webhook.url);
    } catch {
      throw new Error('Mock vendor webhook URL must be a valid URL.');
    }
    if (parsedWebhookUrl.protocol !== 'https:' && parsedWebhookUrl.hostname !== '127.0.0.1') {
      throw new Error('Mock vendor webhook URL must use HTTPS or loopback HTTP.');
    }
    if (webhook.signingSecret.length < 32) {
      throw new Error('Mock vendor webhook signing secret must contain at least 32 characters.');
    }
  }

  const emit = (activity: MockVendorActivity): void => {
    options.onActivity?.(activity);
  };

  const deliverWebhook = async (
    accepted: MockDeliveryAcceptance,
    eventType: 'DELIVERY_PICKED_UP' | 'DELIVERY_DELIVERED',
    correlationId: string | undefined,
  ): Promise<boolean> => {
    if (webhook === undefined || isShuttingDown()) {
      return false;
    }

    const eventId = stableWebhookEventId(accepted.deliveryProviderOrderId, eventType);
    const occurredAt = now();
    const body = JSON.stringify({
      eventId,
      eventType,
      occurredAt,
      deliveryProviderOrderId: accepted.deliveryProviderOrderId,
    });
    let lastStatusCode: number | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= webhookMaximumAttempts; attempt += 1) {
      attempts = attempt;
      if (isShuttingDown()) {
        return false;
      }
      const timestamp = String(Math.floor(new Date(now()).getTime() / 1_000));
      emit({
        kind: 'webhook.request.sent',
        timestamp: now(),
        attempt,
        eventId,
        eventType,
        deliveryProviderOrderId: accepted.deliveryProviderOrderId,
        ...(correlationId === undefined ? {} : { correlationId }),
      });

      try {
        const response = await webhookFetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Timestamp': timestamp,
            'X-Webhook-Signature': signWebhook(webhook.signingSecret, timestamp, body),
            ...(correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId }),
          },
          body,
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(webhookTimeoutMs)]),
        });
        lastStatusCode = response.status;
        emit({
          kind: 'webhook.response.received',
          timestamp: now(),
          attempt,
          eventId,
          eventType,
          deliveryProviderOrderId: accepted.deliveryProviderOrderId,
          statusCode: response.status,
          ...(correlationId === undefined ? {} : { correlationId }),
        });
        if (response.status >= 200 && response.status < 300) {
          return true;
        }
        if (!retryableWebhookStatus(response.status)) {
          break;
        }
      } catch {
        if (isShuttingDown()) {
          return false;
        }
      }

      if (attempt < webhookMaximumAttempts) {
        await wait(webhookRetryDelayMs, shutdown.signal);
      }
    }

    emit({
      kind: 'webhook.delivery.exhausted',
      timestamp: now(),
      attempts,
      eventId,
      eventType,
      deliveryProviderOrderId: accepted.deliveryProviderOrderId,
      ...(lastStatusCode === undefined ? {} : { lastStatusCode }),
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    return false;
  };

  const scheduleWebhookJourney = (
    accepted: MockDeliveryAcceptance,
    correlationId: string | undefined,
  ): void => {
    if (webhook === undefined) {
      return;
    }
    const journey = (async () => {
      await wait(pickupDelayMs, shutdown.signal);
      const pickedUp = await deliverWebhook(accepted, 'DELIVERY_PICKED_UP', correlationId);
      if (!pickedUp || isShuttingDown()) {
        return;
      }
      await wait(deliveredDelayMs, shutdown.signal);
      await deliverWebhook(accepted, 'DELIVERY_DELIVERED', correlationId);
    })();
    pendingWebhooks.add(journey);
    void journey.finally(() => pendingWebhooks.delete(journey));
  };
  const scheduleWebhookJourneyOnce = (
    idempotencyKey: string,
    accepted: MockDeliveryAcceptance,
    correlationId: string | undefined,
  ): void => {
    if (scheduledWebhookSubmissions.has(idempotencyKey)) {
      return;
    }
    scheduledWebhookSubmissions.add(idempotencyKey);
    scheduleWebhookJourney(accepted, correlationId);
  };

  const server = createServer((request, response) => {
    void (async () => {
      let selectedScenario: MockVendorScenario | undefined;
      let attemptRecorded = false;
      let platformOrderIdValue: string | undefined;
      let deliveryProviderOrderIdValue: string | undefined;
      const correlationId = header(request, 'x-correlation-id');
      emit({
        kind: 'delivery.request.received',
        timestamp: now(),
        method: request.method ?? 'UNKNOWN',
        path: request.url ?? '',
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      const recordAttempt = (statusCode: number): void => {
        if (selectedScenario === undefined || attemptRecorded) {
          return;
        }
        attemptRecorded = true;
        const digest = idempotencyKeyDigest(header(request, 'idempotency-key'));
        options.onAttempt?.({
          timestamp: now(),
          scenario: selectedScenario,
          ...(correlationId === undefined ? {} : { correlationId }),
          ...(digest === undefined ? {} : { idempotencyKeyDigest: digest }),
          statusCode,
        });
      };
      let responseRecorded = false;
      const recordResponse = (statusCode: number): void => {
        if (responseRecorded) {
          return;
        }
        responseRecorded = true;
        emit({
          kind: 'delivery.response.sent',
          timestamp: now(),
          statusCode,
          ...(correlationId === undefined ? {} : { correlationId }),
          ...(platformOrderIdValue === undefined ? {} : { platformOrderId: platformOrderIdValue }),
          ...(deliveryProviderOrderIdValue === undefined
            ? {}
            : { deliveryProviderOrderId: deliveryProviderOrderIdValue }),
          ...(selectedScenario === undefined ? {} : { scenario: selectedScenario }),
        });
      };

      try {
        if (request.method !== 'POST' || request.url !== '/deliveries') {
          throw new RequestError(404, 'NOT_FOUND', 'Use POST /deliveries.');
        }

        if (header(request, 'authorization') !== `Bearer ${options.authToken}`) {
          throw new RequestError(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
        }

        selectedScenario = scenarioFrom(request, options.defaultScenario ?? 'success');
        if (selectedScenario === 'rate-limit') {
          recordAttempt(429);
          recordResponse(429);
          problem(response, 429, 'RATE_LIMITED', 'Mock provider rate limit exceeded.', {
            'Retry-After': '1',
          });
          return;
        }
        if (selectedScenario === 'server-error') {
          recordAttempt(500);
          recordResponse(500);
          problem(response, 500, 'PROVIDER_ERROR', 'Mock provider failed unexpectedly.');
          return;
        }
        if (selectedScenario === 'request-rejected') {
          recordAttempt(422);
          recordResponse(422);
          problem(response, 422, 'REQUEST_REJECTED', 'Mock provider rejected the delivery.');
          return;
        }

        const idempotencyKey = header(request, 'idempotency-key');
        if (idempotencyKey === undefined || idempotencyKey.length === 0) {
          throw new RequestError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.');
        }

        const requestBody = await readJsonBody(request);
        if (!isSubmission(requestBody)) {
          throw new RequestError(400, 'INVALID_DELIVERY', 'Delivery request is invalid.');
        }
        platformOrderIdValue = requestBody.platformOrderId;

        const requestFingerprint = fingerprint(requestBody);
        const existing = acceptedSubmissions.get(idempotencyKey);
        if (existing !== undefined && existing.fingerprint !== requestFingerprint) {
          recordAttempt(409);
          throw new RequestError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was already used for different delivery data.',
          );
        }

        const accepted =
          existing ??
          ({
            fingerprint: requestFingerprint,
            response: {
              deliveryProviderOrderId: deliveryProviderOrderId(idempotencyKey),
              status: 'ACCEPTED',
              acceptedAt: now(),
            },
          } satisfies AcceptedSubmission);
        acceptedSubmissions.set(idempotencyKey, accepted);
        deliveryProviderOrderIdValue = accepted.response.deliveryProviderOrderId;

        const responseHeaders =
          correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId };

        if (selectedScenario === 'timeout') {
          await wait(timeoutDelayMs);
        }
        if (selectedScenario === 'malformed-response') {
          recordAttempt(201);
          recordResponse(201);
          response.writeHead(201, {
            ...responseHeaders,
            'Content-Type': 'application/json',
          });
          response.end('{"deliveryProviderOrderId":');
          scheduleWebhookJourneyOnce(idempotencyKey, accepted.response, correlationId);
          return;
        }

        recordAttempt(201);
        recordResponse(201);
        json(response, 201, accepted.response, responseHeaders);
        scheduleWebhookJourneyOnce(idempotencyKey, accepted.response, correlationId);
      } catch (error: unknown) {
        if (error instanceof RequestError) {
          recordAttempt(error.statusCode);
          recordResponse(error.statusCode);
          problem(response, error.statusCode, error.code, error.message);
          return;
        }
        recordAttempt(500);
        recordResponse(500);
        problem(response, 500, 'PROVIDER_ERROR', 'Mock provider failed unexpectedly.');
      }
    })();
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Mock vendor did not bind to a TCP address.');
  }

  return {
    baseUrl: `http://${host}:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        shutdown.abort();
        server.close((error) => {
          void Promise.allSettled(pendingWebhooks).then(() => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        server.closeAllConnections();
      }),
  };
}
