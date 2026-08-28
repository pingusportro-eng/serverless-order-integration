import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { SUPPORTED_STRIPE_WEBHOOK_EVENTS } from '../../src/application/process-stripe-webhook.js';
import {
  createStripeWebhookEndpointManager,
  StripeWebhookEndpointManagerError,
  type StripeWebhookEndpointSdkClient,
} from '../../src/integrations/stripe-webhook-endpoint-manager.js';

const URL = 'https://api.example.com/webhooks/stripe';
const OWNERSHIP = {
  application: 'serverless-order-integration',
  environment: 'dev',
  managedBy: 'cloud-lab',
};

function responseMetadata(
  metadata: Stripe.WebhookEndpointCreateParams['metadata'],
): Stripe.Metadata {
  if (metadata === undefined || metadata === null || metadata === '') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) =>
      value === null ? [] : [[key, String(value)]],
    ),
  );
}

function endpoint(
  endpointId: string,
  overrides: Partial<Stripe.WebhookEndpoint> = {},
): Stripe.WebhookEndpoint {
  return {
    id: endpointId,
    object: 'webhook_endpoint',
    api_version: null,
    application: null,
    created: 1_785_312_000,
    description: 'synthetic endpoint',
    enabled_events: [...SUPPORTED_STRIPE_WEBHOOK_EVENTS],
    livemode: false,
    metadata: OWNERSHIP,
    secret: `whsec_${endpointId}_synthetic_secret`,
    status: 'enabled',
    url: URL,
    ...overrides,
  };
}

function fakeSdk(initialEndpoints: readonly Stripe.WebhookEndpoint[] = []) {
  const stored = new Map(initialEndpoints.map((entry) => [entry.id, entry]));
  let sequence = 0;
  let createImplementation: (
    params: Stripe.WebhookEndpointCreateParams,
  ) => Promise<Stripe.WebhookEndpoint> = (params) => {
    sequence += 1;
    const created = endpoint(`we_created${String(sequence)}`, {
      description: params.description ?? null,
      enabled_events: params.enabled_events,
      metadata: responseMetadata(params.metadata),
      url: params.url,
    });
    stored.set(created.id, created);
    return Promise.resolve(created);
  };

  const list = vi.fn(
    (
      params: Stripe.WebhookEndpointListParams,
    ): Promise<{
      data: readonly Stripe.WebhookEndpoint[];
      has_more: boolean;
    }> => {
      const values = [...stored.values()];
      const start =
        params.starting_after === undefined
          ? 0
          : Math.max(values.findIndex((entry) => entry.id === params.starting_after) + 1, 0);
      const limit = params.limit ?? 10;
      return Promise.resolve({ data: values.slice(start, start + limit), has_more: false });
    },
  );
  const retrieve = vi.fn((endpointId: string): Promise<Stripe.WebhookEndpoint> => {
    const found = stored.get(endpointId);
    if (found === undefined) {
      return Promise.reject(
        new StripeWebhookEndpointManagerError({
          code: 'NOT_FOUND',
          retryable: false,
          message: 'synthetic missing endpoint',
        }),
      );
    }
    return Promise.resolve(found);
  });
  const create = vi.fn((params: Stripe.WebhookEndpointCreateParams) =>
    createImplementation(params),
  );
  const del = vi.fn((endpointId: string): Promise<Stripe.DeletedWebhookEndpoint> => {
    stored.delete(endpointId);
    return Promise.resolve({
      id: endpointId,
      object: 'webhook_endpoint',
      deleted: true,
    } as Stripe.DeletedWebhookEndpoint);
  });

  return {
    client: {
      webhookEndpoints: { list, retrieve, create, del },
    } satisfies StripeWebhookEndpointSdkClient,
    stored,
    list,
    retrieve,
    create,
    del,
    setCreateImplementation(
      implementation: (
        params: Stripe.WebhookEndpointCreateParams,
      ) => Promise<Stripe.WebhookEndpoint>,
    ) {
      createImplementation = implementation;
    },
  };
}

function manager(sdkClient: StripeWebhookEndpointSdkClient) {
  return createStripeWebhookEndpointManager({
    apiKey: 'sk_test_synthetic_webhook_manager',
    timeoutMs: 5000,
    environmentName: 'dev',
    sdkClient,
  });
}

describe('Stripe webhook endpoint manager', () => {
  it('replaces only lab-owned endpoints and creates the exact reviewed endpoint', async () => {
    const stale = endpoint('we_staleOwned');
    const unrelated = endpoint('we_unrelated', {
      metadata: { application: 'someone-else' },
      url: URL,
    });
    const sdk = fakeSdk([stale, unrelated]);

    const result = await manager(sdk.client).prepare(URL);

    expect(result).toEqual({
      endpointId: 'we_created1',
      url: URL,
      signingSecret: 'whsec_we_created1_synthetic_secret',
      replacedEndpointIds: ['we_staleOwned'],
    });
    expect(sdk.del).toHaveBeenCalledExactlyOnceWith('we_staleOwned');
    expect(sdk.stored.has('we_unrelated')).toBe(true);
    expect(sdk.create).toHaveBeenCalledWith({
      url: URL,
      enabled_events: [...SUPPORTED_STRIPE_WEBHOOK_EVENTS],
      connect: false,
      description: 'Temporary serverless-order-integration dev cloud lab endpoint',
      metadata: OWNERSHIP,
    });
  });

  it('recovers an uncertain create by replacing the endpoint whose secret was lost', async () => {
    const sdk = fakeSdk();
    let attempt = 0;
    sdk.setCreateImplementation((params) => {
      attempt += 1;
      const created = endpoint(`we_uncertain${String(attempt)}`, {
        enabled_events: params.enabled_events,
        metadata: responseMetadata(params.metadata),
        url: params.url,
      });
      sdk.stored.set(created.id, created);
      if (attempt === 1) {
        return Promise.reject(
          new StripeWebhookEndpointManagerError({
            code: 'STRIPE_UNAVAILABLE',
            retryable: true,
            message: 'synthetic ambiguous result',
          }),
        );
      }
      return Promise.resolve(created);
    });

    await expect(manager(sdk.client).prepare(URL)).rejects.toMatchObject({
      code: 'STRIPE_UNAVAILABLE',
      retryable: true,
    });
    await expect(manager(sdk.client).prepare(URL)).resolves.toMatchObject({
      endpointId: 'we_uncertain2',
      replacedEndpointIds: ['we_uncertain1'],
    });
    expect(sdk.stored.has('we_uncertain1')).toBe(false);
  });

  it('makes deletion idempotent but refuses to delete an endpoint without lab ownership', async () => {
    const owned = endpoint('we_owned');
    const unrelated = endpoint('we_notOwned', { metadata: { application: 'someone-else' } });
    const sdk = fakeSdk([owned, unrelated]);
    const endpointManager = manager(sdk.client);

    await expect(endpointManager.deleteOwnedEndpoint('we_owned')).resolves.toBe('deleted');
    await expect(endpointManager.deleteOwnedEndpoint('we_owned')).resolves.toBe('absent');
    await expect(endpointManager.deleteOwnedEndpoint('we_notOwned')).rejects.toMatchObject({
      code: 'NOT_OWNED',
      retryable: false,
    });
    expect(sdk.stored.has('we_notOwned')).toBe(true);
  });

  it('rejects live credentials, invalid configuration, and unsafe target URLs', async () => {
    expect(() =>
      createStripeWebhookEndpointManager({
        apiKey: 'sk_live_forbidden',
        timeoutMs: 5000,
        environmentName: 'dev',
      }),
    ).toThrow('Sandbox secret key');
    expect(() =>
      createStripeWebhookEndpointManager({
        apiKey: 'sk_test_synthetic',
        timeoutMs: 0,
        environmentName: 'dev',
      }),
    ).toThrow('positive integer');
    expect(() =>
      createStripeWebhookEndpointManager({
        apiKey: 'sk_test_synthetic',
        timeoutMs: 5000,
        environmentName: 'DEVELOPMENT',
      }),
    ).toThrow('valid environment name');

    const endpointManager = manager(fakeSdk().client);
    await expect(endpointManager.prepare('http://example.com/webhooks/stripe')).rejects.toThrow(
      'HTTPS /webhooks/stripe',
    );
    await expect(endpointManager.prepare('https://example.com/not-stripe')).rejects.toThrow(
      'HTTPS /webhooks/stripe',
    );
  });

  it('rejects a live-mode or malformed creation response', async () => {
    const sdk = fakeSdk();
    sdk.setCreateImplementation((params) =>
      Promise.resolve(
        endpoint('we_liveForbidden', {
          enabled_events: params.enabled_events,
          livemode: true,
          metadata: responseMetadata(params.metadata),
          url: params.url,
        }),
      ),
    );
    await expect(manager(sdk.client).prepare(URL)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });
});
