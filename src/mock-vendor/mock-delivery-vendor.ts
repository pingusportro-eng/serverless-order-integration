import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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
}

export interface RunningMockDeliveryVendor {
  readonly baseUrl: string;
  close(): Promise<void>;
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
    typeof candidate['merchantOrderReference'] === 'string' &&
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

function providerOrderId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('base64url').slice(0, 24);
  return `delivery_${digest}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startMockDeliveryVendor(
  options: StartMockDeliveryVendorOptions,
): Promise<RunningMockDeliveryVendor> {
  if (options.authToken.length === 0) {
    throw new Error('Mock vendor auth token must not be empty.');
  }

  const acceptedSubmissions = new Map<string, AcceptedSubmission>();
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutDelayMs = options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST' || request.url !== '/deliveries') {
          throw new RequestError(404, 'NOT_FOUND', 'Use POST /deliveries.');
        }

        if (header(request, 'authorization') !== `Bearer ${options.authToken}`) {
          throw new RequestError(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
        }

        const selectedScenario = scenarioFrom(request, options.defaultScenario ?? 'success');
        if (selectedScenario === 'rate-limit') {
          problem(response, 429, 'RATE_LIMITED', 'Mock provider rate limit exceeded.', {
            'Retry-After': '1',
          });
          return;
        }
        if (selectedScenario === 'server-error') {
          problem(response, 500, 'PROVIDER_ERROR', 'Mock provider failed unexpectedly.');
          return;
        }
        if (selectedScenario === 'request-rejected') {
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

        const requestFingerprint = fingerprint(requestBody);
        const existing = acceptedSubmissions.get(idempotencyKey);
        if (existing !== undefined && existing.fingerprint !== requestFingerprint) {
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
              providerOrderId: providerOrderId(idempotencyKey),
              status: 'ACCEPTED',
              acceptedAt: now(),
            },
          } satisfies AcceptedSubmission);
        acceptedSubmissions.set(idempotencyKey, accepted);

        const correlationId = header(request, 'x-correlation-id');
        const responseHeaders =
          correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId };

        if (selectedScenario === 'timeout') {
          await wait(timeoutDelayMs);
        }
        if (selectedScenario === 'malformed-response') {
          response.writeHead(201, {
            ...responseHeaders,
            'Content-Type': 'application/json',
          });
          response.end('{"providerOrderId":');
          return;
        }

        json(response, 201, accepted.response, responseHeaders);
      } catch (error: unknown) {
        if (error instanceof RequestError) {
          problem(response, error.statusCode, error.code, error.message);
          return;
        }
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
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      }),
  };
}
