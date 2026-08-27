import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';

export interface SsmParameterClient {
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

export interface SecureParameterLoader {
  load(parameterName: string): Promise<string>;
}

export class InvalidSecureParameterError extends Error {
  constructor(parameterName: string) {
    super(`The SecureString parameter ${parameterName} has no usable value.`);
    this.name = 'InvalidSecureParameterError';
  }
}

export class SsmSecureParameterLoader implements SecureParameterLoader {
  private readonly cachedValues = new Map<string, Promise<string>>();

  constructor(private readonly client: SsmParameterClient) {}

  load(parameterName: string): Promise<string> {
    const name = parameterName.trim();
    if (name.length === 0) {
      return Promise.reject(new InvalidSecureParameterError('<empty-name>'));
    }

    const cachedValue = this.cachedValues.get(name);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const pendingValue = this.read(name).catch((error: unknown) => {
      this.cachedValues.delete(name);
      throw error;
    });
    this.cachedValues.set(name, pendingValue);
    return pendingValue;
  }

  private async read(parameterName: string): Promise<string> {
    const result = await this.client.send(
      new GetParameterCommand({
        Name: parameterName,
        WithDecryption: true,
      }),
    );
    const value = result.Parameter?.Value;
    if (value === undefined || value.trim().length === 0) {
      throw new InvalidSecureParameterError(parameterName);
    }
    return value;
  }
}
