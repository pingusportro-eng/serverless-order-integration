import Stripe from 'stripe';

import { SUPPORTED_STRIPE_WEBHOOK_EVENTS } from '../application/process-stripe-webhook.js';

const APPLICATION = 'serverless-order-integration';
const MANAGED_BY = 'cloud-lab';
const PAGE_LIMIT = 100;

interface StripeWebhookEndpointPage {
  readonly data: readonly Stripe.WebhookEndpoint[];
  readonly has_more: boolean;
}

interface StripeWebhookEndpointsApi {
  list(params: Stripe.WebhookEndpointListParams): PromiseLike<StripeWebhookEndpointPage>;
  retrieve(endpointId: string): PromiseLike<Stripe.WebhookEndpoint>;
  create(params: Stripe.WebhookEndpointCreateParams): PromiseLike<Stripe.WebhookEndpoint>;
  del(endpointId: string): PromiseLike<Stripe.DeletedWebhookEndpoint>;
}

export interface StripeWebhookEndpointSdkClient {
  readonly webhookEndpoints: StripeWebhookEndpointsApi;
}

export interface CreateStripeWebhookEndpointManagerOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly environmentName: string;
  readonly sdkClient?: StripeWebhookEndpointSdkClient;
}

export interface PreparedStripeWebhookEndpoint {
  readonly endpointId: string;
  readonly url: string;
  readonly signingSecret: string;
  readonly replacedEndpointIds: readonly string[];
}

export type DeleteStripeWebhookEndpointResult = 'deleted' | 'absent';

export type StripeWebhookEndpointManagerErrorCode =
  'INVALID_RESPONSE' | 'NOT_FOUND' | 'NOT_OWNED' | 'REQUEST_REJECTED' | 'STRIPE_UNAVAILABLE';

export class StripeWebhookEndpointManagerError extends Error {
  readonly code: StripeWebhookEndpointManagerErrorCode;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: StripeWebhookEndpointManagerErrorCode;
    readonly retryable: boolean;
    readonly message: string;
  }) {
    super(options.message);
    this.name = 'StripeWebhookEndpointManagerError';
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export interface StripeWebhookEndpointManager {
  prepare(url: string): Promise<PreparedStripeWebhookEndpoint>;
  deleteOwnedEndpoint(endpointId: string): Promise<DeleteStripeWebhookEndpointResult>;
  deleteAllOwnedEndpoints(): Promise<readonly string[]>;
}

function managerError(
  code: StripeWebhookEndpointManagerErrorCode,
  retryable: boolean,
  message: string,
): StripeWebhookEndpointManagerError {
  return new StripeWebhookEndpointManagerError({ code, retryable, message });
}

function mapStripeError(error: unknown): StripeWebhookEndpointManagerError {
  if (error instanceof StripeWebhookEndpointManagerError) {
    return error;
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) {
    return managerError('NOT_FOUND', false, 'The Stripe webhook endpoint does not exist.');
  }
  if (
    error instanceof Stripe.errors.StripeRateLimitError ||
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError
  ) {
    return managerError(
      'STRIPE_UNAVAILABLE',
      true,
      'Stripe could not complete the webhook endpoint operation.',
    );
  }
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    error instanceof Stripe.errors.StripeInvalidRequestError
  ) {
    return managerError(
      'REQUEST_REJECTED',
      false,
      'Stripe rejected the webhook endpoint operation.',
    );
  }
  return managerError(
    'INVALID_RESPONSE',
    true,
    'Stripe returned an unexpected webhook endpoint error.',
  );
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Stripe webhook URL must be a valid URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== '/webhooks/stripe'
  ) {
    throw new TypeError('Stripe webhook URL must be an HTTPS /webhooks/stripe endpoint.');
  }
  return url.toString();
}

function validEndpointId(value: string): boolean {
  return /^we_[A-Za-z0-9]+$/.test(value);
}

function equalEvents(actual: readonly string[]): boolean {
  const expected = [...SUPPORTED_STRIPE_WEBHOOK_EVENTS].sort();
  return (
    actual.length === expected.length &&
    [...actual].sort().every((eventType, index) => eventType === expected[index])
  );
}

function isEndpointPage(value: unknown): value is StripeWebhookEndpointPage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate['data']) && typeof candidate['has_more'] === 'boolean';
}

function isDeletionConfirmation(value: unknown, endpointId: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate['id'] === endpointId && candidate['deleted'] === true;
}

export function createStripeWebhookEndpointManager(
  options: CreateStripeWebhookEndpointManagerOptions,
): StripeWebhookEndpointManager {
  if (!options.apiKey.startsWith('sk_test_')) {
    throw new Error(
      'Stripe webhook management requires a Sandbox secret key beginning with sk_test_.',
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Stripe webhook management timeout must be a positive integer.');
  }
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(options.environmentName)) {
    throw new Error('Stripe webhook management requires a valid environment name.');
  }

  const stripe =
    options.sdkClient ??
    new Stripe(options.apiKey, {
      timeout: options.timeoutMs,
      maxNetworkRetries: 0,
    });
  const ownership = {
    application: APPLICATION,
    environment: options.environmentName,
    managedBy: MANAGED_BY,
  } as const;

  function isOwned(endpoint: Stripe.WebhookEndpoint): boolean {
    return (
      endpoint.metadata['application'] === ownership.application &&
      endpoint.metadata['environment'] === ownership.environment &&
      endpoint.metadata['managedBy'] === ownership.managedBy
    );
  }

  function validateOwnedEndpoint(endpoint: Stripe.WebhookEndpoint): void {
    if (!validEndpointId(endpoint.id)) {
      throw managerError(
        'INVALID_RESPONSE',
        true,
        'Stripe returned an invalid webhook endpoint ID.',
      );
    }
    if (endpoint.livemode) {
      throw managerError(
        'INVALID_RESPONSE',
        false,
        'A live-mode Stripe webhook endpoint is forbidden.',
      );
    }
  }

  async function request<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      throw mapStripeError(error);
    }
  }

  async function ownedEndpointIds(): Promise<readonly string[]> {
    const endpointIds: string[] = [];

    async function collectPage(startingAfter?: string): Promise<void> {
      const response: unknown = await request(() =>
        stripe.webhookEndpoints.list({
          limit: PAGE_LIMIT,
          ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
        }),
      );
      if (!isEndpointPage(response)) {
        throw managerError('INVALID_RESPONSE', true, 'Stripe returned an invalid endpoint page.');
      }
      const page = response;
      for (const endpoint of page.data) {
        if (isOwned(endpoint)) {
          validateOwnedEndpoint(endpoint);
          endpointIds.push(endpoint.id);
        }
      }
      if (!page.has_more) {
        return;
      }
      const lastEndpoint = page.data.at(-1);
      if (
        lastEndpoint === undefined ||
        !validEndpointId(lastEndpoint.id) ||
        lastEndpoint.id === startingAfter
      ) {
        throw managerError('INVALID_RESPONSE', true, 'Stripe endpoint pagination did not advance.');
      }
      await collectPage(lastEndpoint.id);
    }

    await collectPage();

    return endpointIds;
  }

  async function deleteOwnedEndpoint(
    endpointId: string,
  ): Promise<DeleteStripeWebhookEndpointResult> {
    if (!validEndpointId(endpointId)) {
      throw new TypeError('Stripe webhook endpoint ID is invalid.');
    }

    let endpoint: Stripe.WebhookEndpoint;
    try {
      endpoint = await request(() => stripe.webhookEndpoints.retrieve(endpointId));
    } catch (error: unknown) {
      if (error instanceof StripeWebhookEndpointManagerError && error.code === 'NOT_FOUND') {
        return 'absent';
      }
      throw error;
    }
    validateOwnedEndpoint(endpoint);
    if (endpoint.id !== endpointId) {
      throw managerError('INVALID_RESPONSE', true, 'Stripe returned a different webhook endpoint.');
    }
    if (!isOwned(endpoint)) {
      throw managerError(
        'NOT_OWNED',
        false,
        'Refusing to delete a webhook endpoint not owned by this lab.',
      );
    }

    const deleted: unknown = await request(() => stripe.webhookEndpoints.del(endpointId));
    if (!isDeletionConfirmation(deleted, endpointId)) {
      throw managerError(
        'INVALID_RESPONSE',
        true,
        'Stripe did not confirm webhook endpoint deletion.',
      );
    }
    return 'deleted';
  }

  async function deleteAllOwnedEndpoints(): Promise<readonly string[]> {
    const deletedEndpointIds: string[] = [];
    for (const endpointId of await ownedEndpointIds()) {
      if ((await deleteOwnedEndpoint(endpointId)) === 'deleted') {
        deletedEndpointIds.push(endpointId);
      }
    }
    return deletedEndpointIds;
  }

  return {
    async prepare(rawUrl: string): Promise<PreparedStripeWebhookEndpoint> {
      const url = validateUrl(rawUrl);
      const replacedEndpointIds = await deleteAllOwnedEndpoints();
      const endpoint = await request(() =>
        stripe.webhookEndpoints.create({
          url,
          enabled_events: [...SUPPORTED_STRIPE_WEBHOOK_EVENTS],
          connect: false,
          description: `Temporary ${APPLICATION} ${options.environmentName} cloud lab endpoint`,
          metadata: ownership,
        }),
      );
      validateOwnedEndpoint(endpoint);
      if (
        endpoint.url !== url ||
        !isOwned(endpoint) ||
        !equalEvents(endpoint.enabled_events) ||
        endpoint.status !== 'enabled' ||
        typeof endpoint.secret !== 'string' ||
        !endpoint.secret.startsWith('whsec_')
      ) {
        throw managerError(
          'INVALID_RESPONSE',
          true,
          'Stripe returned an invalid created endpoint.',
        );
      }
      return {
        endpointId: endpoint.id,
        url: endpoint.url,
        signingSecret: endpoint.secret,
        replacedEndpointIds,
      };
    },
    deleteOwnedEndpoint,
    deleteAllOwnedEndpoints,
  };
}
