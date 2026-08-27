import type { GetParameterCommand, GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';

import {
  InvalidSecureParameterError,
  SsmSecureParameterLoader,
  type SsmParameterClient,
} from '../../src/infrastructure/ssm/ssm-secure-parameter-loader.js';

function client(
  send: (command: GetParameterCommand) => Promise<GetParameterCommandOutput>,
): SsmParameterClient {
  return { send };
}

function output(value?: string): GetParameterCommandOutput {
  return {
    $metadata: {},
    ...(value === undefined ? {} : { Parameter: { Value: value } }),
  };
}

describe('SSM SecureString parameter loader', () => {
  it('requests decryption and caches a usable value', async () => {
    const send = vi.fn((command: GetParameterCommand) => {
      void command;
      return Promise.resolve(output('sk_test_synthetic'));
    });
    const loader = new SsmSecureParameterLoader(client(send));

    await expect(loader.load('/lab/stripe/secret-key')).resolves.toBe('sk_test_synthetic');
    await expect(loader.load('/lab/stripe/secret-key')).resolves.toBe('sk_test_synthetic');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Name: '/lab/stripe/secret-key',
      WithDecryption: true,
    });
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let resolveRequest: ((output: GetParameterCommandOutput) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<GetParameterCommandOutput>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const loader = new SsmSecureParameterLoader(client(send));

    const first = loader.load('/lab/stripe/webhook-secret');
    const second = loader.load('/lab/stripe/webhook-secret');
    resolveRequest?.(output('whsec_synthetic'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      'whsec_synthetic',
      'whsec_synthetic',
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed read', async () => {
    let attempts = 0;
    const send = vi.fn((command: GetParameterCommand) => {
      void command;
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('temporary SSM failure'))
        : Promise.resolve(output('sk_test_recovered'));
    });
    const loader = new SsmSecureParameterLoader(client(send));

    await expect(loader.load('/lab/stripe/secret-key')).rejects.toThrow('temporary SSM failure');
    await expect(loader.load('/lab/stripe/secret-key')).resolves.toBe('sk_test_recovered');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    output(),
    { $metadata: {}, Parameter: {} },
    output(''),
    output('   '),
  ] satisfies readonly GetParameterCommandOutput[])(
    'rejects a missing or empty parameter value',
    async (output) => {
      const loader = new SsmSecureParameterLoader(client(() => Promise.resolve(output)));

      await expect(loader.load('/lab/stripe/secret-key')).rejects.toBeInstanceOf(
        InvalidSecureParameterError,
      );
    },
  );

  it('rejects an empty parameter name without calling SSM', async () => {
    const send = vi.fn((command: GetParameterCommand) => {
      void command;
      return Promise.resolve(output('not-read'));
    });
    const loader = new SsmSecureParameterLoader(client(send));

    await expect(loader.load('   ')).rejects.toBeInstanceOf(InvalidSecureParameterError);
    expect(send).not.toHaveBeenCalled();
  });
});
