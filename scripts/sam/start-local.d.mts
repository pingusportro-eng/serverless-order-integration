export type SamLocalEnvironment = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface CreateSamLocalEnvironmentFileOptions {
  readonly environmentPath?: string;
  readonly sourceFixturePath?: string;
  readonly outputPath?: string;
  readonly stripeWebhookSecret?: string;
}

export interface SamLocalRuntimeSecrets {
  readonly stripeWebhookSecret?: string;
}

export function buildSamLocalEnvironment(
  fixture: SamLocalEnvironment,
  localEnvironment: Readonly<Record<string, string>>,
  runtimeSecrets?: SamLocalRuntimeSecrets,
): SamLocalEnvironment;

export function createSamLocalEnvironmentFile(
  options?: CreateSamLocalEnvironmentFileOptions,
): Promise<string>;
