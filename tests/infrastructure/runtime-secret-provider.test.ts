import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeSecretProvider,
  InvalidSecretConfigurationError,
} from '../../src/infrastructure/ssm/runtime-secret-provider.js';
import type { SecureParameterLoader } from '../../src/infrastructure/ssm/ssm-secure-parameter-loader.js';

function loader(load: (parameterName: string) => Promise<string>): SecureParameterLoader {
  return { load };
}

describe('runtime secret provider', () => {
  it('resolves a logical name from the local environment without reading SSM', async () => {
    const load = vi.fn((name: string) => {
      void name;
      return Promise.resolve('not-used');
    });
    const secrets = createRuntimeSecretProvider(
      {
        SECRET_PROVIDER: 'environment',
        STRIPE_SECRET_KEY: ' sk_test_local ',
      },
      loader(load),
    );

    await expect(secrets.required('STRIPE_SECRET_KEY')).resolves.toBe('sk_test_local');
    expect(load).not.toHaveBeenCalled();
  });

  it('resolves the same logical name through SSM in AWS', async () => {
    const load = vi.fn((name: string) => {
      void name;
      return Promise.resolve('sk_test_cloud');
    });
    const secrets = createRuntimeSecretProvider(
      {
        SECRET_PROVIDER: 'ssm',
        STRIPE_SECRET_KEY_PARAMETER_NAME: '/lab/stripe/secret-key',
      },
      loader(load),
    );

    await expect(secrets.required('STRIPE_SECRET_KEY')).resolves.toBe('sk_test_cloud');
    expect(load).toHaveBeenCalledWith('/lab/stripe/secret-key');
  });

  it('allows an optional logical secret to remain unconfigured', async () => {
    const secrets = createRuntimeSecretProvider(
      { SECRET_PROVIDER: 'ssm' },
      loader(() => Promise.resolve('not-used')),
    );

    await expect(secrets.optional('STRIPE_SECRET_KEY')).resolves.toBeUndefined();
  });

  it.each([undefined, '', 'automatic', 'SSM'])('rejects unsupported provider mode %s', (mode) => {
    expect(() =>
      createRuntimeSecretProvider(
        { ...(mode === undefined ? {} : { SECRET_PROVIDER: mode }) },
        loader(() => Promise.resolve('not-used')),
      ),
    ).toThrow(InvalidSecretConfigurationError);
  });

  it('rejects a parameter reference in environment mode', async () => {
    const secrets = createRuntimeSecretProvider(
      {
        SECRET_PROVIDER: 'environment',
        STRIPE_SECRET_KEY_PARAMETER_NAME: '/lab/stripe/secret-key',
      },
      loader(() => Promise.resolve('not-used')),
    );

    await expect(secrets.optional('STRIPE_SECRET_KEY')).rejects.toThrow(
      'is not allowed when SECRET_PROVIDER is environment',
    );
  });

  it('rejects a direct secret in SSM mode', async () => {
    const secrets = createRuntimeSecretProvider(
      {
        SECRET_PROVIDER: 'ssm',
        STRIPE_SECRET_KEY: 'sk_test_must_not_be_in_lambda_configuration',
      },
      loader(() => Promise.resolve('not-used')),
    );

    await expect(secrets.optional('STRIPE_SECRET_KEY')).rejects.toThrow(
      'is not allowed when SECRET_PROVIDER is ssm',
    );
  });

  it('reports the source-specific name when a required secret is missing', async () => {
    const parameterLoader = loader(() => Promise.resolve('not-used'));

    await expect(
      createRuntimeSecretProvider({ SECRET_PROVIDER: 'environment' }, parameterLoader).required(
        'STRIPE_SECRET_KEY',
      ),
    ).rejects.toThrow('STRIPE_SECRET_KEY is required');
    await expect(
      createRuntimeSecretProvider({ SECRET_PROVIDER: 'ssm' }, parameterLoader).required(
        'STRIPE_SECRET_KEY',
      ),
    ).rejects.toThrow('STRIPE_SECRET_KEY_PARAMETER_NAME is required');
  });
});
