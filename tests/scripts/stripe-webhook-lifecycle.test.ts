import { describe, expect, it, vi } from 'vitest';

import {
  cleanupStripeWebhookLifecycle,
  prepareStripeWebhookLifecycle,
  type StripeWebhookEndpointManager,
  type StripeWebhookParameterStore,
  type StripeWebhookRecovery,
} from '../../scripts/cloud/stripe-webhook-lifecycle.mjs';

const WEBHOOK_URL = 'https://api.example.com/webhooks/stripe';
const PARAMETER_NAME = '/serverless-order-integration/dev/stripe/webhook-secret';

function fixture() {
  const parameters = new Map<string, string>();
  let endpointExists = false;
  const endpointManager = {
    prepare: vi.fn((url: string) => {
      expect(url).toBe(WEBHOOK_URL);
      endpointExists = true;
      return Promise.resolve({
        endpointId: 'we_cloudLab',
        url: WEBHOOK_URL,
        signingSecret: 'whsec_synthetic_signing_secret',
        replacedEndpointIds: ['we_stale'],
      });
    }),
    deleteOwnedEndpoint: vi.fn((endpointId: string) => {
      expect(endpointId).toBe('we_cloudLab');
      if (!endpointExists) {
        return Promise.resolve<'absent'>('absent');
      }
      endpointExists = false;
      return Promise.resolve<'deleted'>('deleted');
    }),
  } satisfies StripeWebhookEndpointManager;
  const parameterStore = {
    putSecureString: vi.fn((name: string, value: string) => {
      parameters.set(name, value);
      return Promise.resolve();
    }),
    readSecureString: vi.fn((name: string) => Promise.resolve(parameters.get(name))),
    deleteParameter: vi.fn((name: string) => {
      const result: 'deleted' | 'absent' = parameters.delete(name) ? 'deleted' : 'absent';
      return Promise.resolve(result);
    }),
  } satisfies StripeWebhookParameterStore;

  return {
    endpointManager,
    parameterStore,
    parameters,
    endpointExists: () => endpointExists,
  };
}

describe('cloud Stripe webhook lifecycle', () => {
  it('records only safe recovery data before activating and verifying the SSM secret', async () => {
    const test = fixture();
    const saved: StripeWebhookRecovery[] = [];

    const result = await prepareStripeWebhookLifecycle({
      endpointManager: test.endpointManager,
      parameterStore: test.parameterStore,
      webhookUrl: WEBHOOK_URL,
      webhookSecretParameterName: PARAMETER_NAME,
      saveRecovery: (recovery) => {
        saved.push(recovery);
        expect(test.parameterStore.putSecureString).not.toHaveBeenCalled();
        return Promise.resolve();
      },
    });

    expect(saved).toEqual([{ endpointId: 'we_cloudLab' }]);
    expect(JSON.stringify(saved)).not.toContain('whsec_');
    expect(test.parameters.get(PARAMETER_NAME)).toBe('whsec_synthetic_signing_secret');
    expect(result).toEqual({
      endpointId: 'we_cloudLab',
      url: WEBHOOK_URL,
      replacedEndpointIds: ['we_stale'],
    });
  });

  it('preserves recovery state when secret activation is interrupted', async () => {
    const test = fixture();
    const saved: StripeWebhookRecovery[] = [];
    test.parameterStore.putSecureString.mockRejectedValueOnce(new Error('synthetic SSM outage'));

    await expect(
      prepareStripeWebhookLifecycle({
        endpointManager: test.endpointManager,
        parameterStore: test.parameterStore,
        webhookUrl: WEBHOOK_URL,
        webhookSecretParameterName: PARAMETER_NAME,
        saveRecovery: (recovery) => {
          saved.push(recovery);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('signing-secret activation failed');

    expect(saved).toEqual([{ endpointId: 'we_cloudLab' }]);
    expect(test.endpointExists()).toBe(true);
  });

  it('waits for an overwritten SSM value to become visible', async () => {
    const test = fixture();
    const readSecureString = test.parameterStore.readSecureString;
    readSecureString.mockResolvedValueOnce('whsec_previous_endpoint_secret');
    const waitForConsistency = vi.fn(() => Promise.resolve());

    await prepareStripeWebhookLifecycle({
      endpointManager: test.endpointManager,
      parameterStore: test.parameterStore,
      webhookUrl: WEBHOOK_URL,
      webhookSecretParameterName: PARAMETER_NAME,
      saveRecovery: () => Promise.resolve(),
      waitForConsistency,
    });

    expect(readSecureString).toHaveBeenCalledTimes(2);
    expect(waitForConsistency).toHaveBeenCalledWith(250);
  });

  it('keeps recovery state after retryable cleanup failure and clears it after retry', async () => {
    const test = fixture();
    const recovery = { endpointId: 'we_cloudLab' };
    await test.endpointManager.prepare(WEBHOOK_URL);
    test.parameters.set(PARAMETER_NAME, 'whsec_synthetic_signing_secret');
    test.endpointManager.deleteOwnedEndpoint.mockRejectedValueOnce(
      new Error('synthetic Stripe outage'),
    );
    const clearRecovery = vi.fn(() => Promise.resolve());

    await expect(
      cleanupStripeWebhookLifecycle({
        endpointManager: test.endpointManager,
        parameterStore: test.parameterStore,
        recovery,
        webhookSecretParameterName: PARAMETER_NAME,
        clearRecovery,
      }),
    ).rejects.toThrow('endpoint cleanup failed');
    expect(clearRecovery).not.toHaveBeenCalled();
    expect(test.parameters.has(PARAMETER_NAME)).toBe(true);

    await cleanupStripeWebhookLifecycle({
      endpointManager: test.endpointManager,
      parameterStore: test.parameterStore,
      recovery,
      webhookSecretParameterName: PARAMETER_NAME,
      clearRecovery,
    });
    expect(test.endpointManager.deleteOwnedEndpoint).toHaveBeenLastCalledWith('we_cloudLab');
    expect(test.parameters.has(PARAMETER_NAME)).toBe(false);
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it('keeps recovery state when secret deletion fails after the endpoint is absent', async () => {
    const test = fixture();
    const recovery = { endpointId: 'we_cloudLab' };
    await test.endpointManager.prepare(WEBHOOK_URL);
    test.parameters.set(PARAMETER_NAME, 'whsec_synthetic_signing_secret');
    test.parameterStore.deleteParameter.mockRejectedValueOnce(new Error('synthetic SSM outage'));
    const clearRecovery = vi.fn(() => Promise.resolve());

    await expect(
      cleanupStripeWebhookLifecycle({
        endpointManager: test.endpointManager,
        parameterStore: test.parameterStore,
        recovery,
        webhookSecretParameterName: PARAMETER_NAME,
        clearRecovery,
      }),
    ).rejects.toThrow('signing-secret cleanup failed');
    expect(test.endpointExists()).toBe(false);
    expect(test.parameters.has(PARAMETER_NAME)).toBe(true);
    expect(clearRecovery).not.toHaveBeenCalled();

    await cleanupStripeWebhookLifecycle({
      endpointManager: test.endpointManager,
      parameterStore: test.parameterStore,
      recovery,
      webhookSecretParameterName: PARAMETER_NAME,
      clearRecovery,
    });
    expect(test.parameters.has(PARAMETER_NAME)).toBe(false);
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it('removes a newly created endpoint if local recovery state cannot be persisted', async () => {
    const test = fixture();

    await expect(
      prepareStripeWebhookLifecycle({
        endpointManager: test.endpointManager,
        parameterStore: test.parameterStore,
        webhookUrl: WEBHOOK_URL,
        webhookSecretParameterName: PARAMETER_NAME,
        saveRecovery: () => Promise.reject(new Error('synthetic disk failure')),
      }),
    ).rejects.toThrow('recovery state could not be recorded');

    expect(test.endpointExists()).toBe(false);
    expect(test.parameterStore.putSecureString).not.toHaveBeenCalled();
  });
});
