import type { SecureParameterLoader } from './ssm-secure-parameter-loader.js';

export type RuntimeSecretProviderMode = 'environment' | 'ssm';

export interface RuntimeSecretProvider {
  optional(logicalName: string): Promise<string | undefined>;
  required(logicalName: string): Promise<string>;
}

export class InvalidSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSecretConfigurationError';
  }
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function parameterName(logicalName: string): string {
  return `${logicalName}_PARAMETER_NAME`;
}

class SelectedRuntimeSecretProvider implements RuntimeSecretProvider {
  constructor(
    private readonly mode: RuntimeSecretProviderMode,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly parameterLoader: SecureParameterLoader,
  ) {}

  async optional(logicalName: string): Promise<string | undefined> {
    const directValue = environmentValue(this.environment, logicalName);
    const referenceName = parameterName(logicalName);
    const reference = environmentValue(this.environment, referenceName);

    if (this.mode === 'environment') {
      if (reference !== undefined) {
        throw new InvalidSecretConfigurationError(
          `${referenceName} is not allowed when SECRET_PROVIDER is environment.`,
        );
      }
      return directValue;
    }

    if (directValue !== undefined) {
      throw new InvalidSecretConfigurationError(
        `${logicalName} is not allowed when SECRET_PROVIDER is ssm.`,
      );
    }
    return reference === undefined ? undefined : this.parameterLoader.load(reference);
  }

  async required(logicalName: string): Promise<string> {
    const value = await this.optional(logicalName);
    if (value === undefined) {
      const expectedName = this.mode === 'environment' ? logicalName : parameterName(logicalName);
      throw new InvalidSecretConfigurationError(
        `${expectedName} is required when SECRET_PROVIDER is ${this.mode}.`,
      );
    }
    return value;
  }
}

export function createRuntimeSecretProvider(
  environment: Readonly<Record<string, string | undefined>>,
  parameterLoader: SecureParameterLoader,
): RuntimeSecretProvider {
  const mode = environmentValue(environment, 'SECRET_PROVIDER');
  if (mode !== 'environment' && mode !== 'ssm') {
    throw new InvalidSecretConfigurationError('SECRET_PROVIDER must be either environment or ssm.');
  }
  return new SelectedRuntimeSecretProvider(mode, environment, parameterLoader);
}
