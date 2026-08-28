export interface StripeWebhookRecovery {
  readonly endpointId: string;
}

export interface PreparedStripeWebhookEndpoint {
  readonly endpointId: string;
  readonly url: string;
  readonly signingSecret: string;
  readonly replacedEndpointIds: readonly string[];
}

export interface StripeWebhookEndpointManager {
  prepare(url: string): Promise<PreparedStripeWebhookEndpoint>;
  deleteOwnedEndpoint(endpointId: string): Promise<'deleted' | 'absent'>;
}

export interface StripeWebhookParameterStore {
  putSecureString(name: string, value: string): Promise<void>;
  readSecureString(name: string): Promise<string | undefined>;
  deleteParameter(name: string): Promise<'deleted' | 'absent'>;
}

export class StripeWebhookLifecycleError extends Error {}

export function prepareStripeWebhookLifecycle(options: {
  readonly endpointManager: StripeWebhookEndpointManager;
  readonly parameterStore: StripeWebhookParameterStore;
  readonly webhookUrl: string;
  readonly webhookSecretParameterName: string;
  readonly saveRecovery: (recovery: StripeWebhookRecovery) => Promise<void>;
  readonly waitForConsistency?: (milliseconds: number) => Promise<void>;
}): Promise<{
  readonly endpointId: string;
  readonly url: string;
  readonly replacedEndpointIds: readonly string[];
}>;

export function cleanupStripeWebhookLifecycle(options: {
  readonly endpointManager: StripeWebhookEndpointManager;
  readonly parameterStore: StripeWebhookParameterStore;
  readonly recovery: StripeWebhookRecovery;
  readonly webhookSecretParameterName: string;
  readonly clearRecovery: () => Promise<void>;
  readonly waitForConsistency?: (milliseconds: number) => Promise<void>;
}): Promise<void>;
