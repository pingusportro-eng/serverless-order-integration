import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSamLocalEnvironment,
  createSamLocalEnvironmentFile,
} from '../../scripts/sam/start-local.mjs';

const temporaryDirectories: string[] = [];

describe('SAM local Stripe environment', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('adds only the Sandbox key and bounded timeout to the Orders API environment', () => {
    const fixture = {
      OrdersApiFunction: { DYNAMODB_ENDPOINT: 'http://dynamodb-local:8000' },
      VendorWebhookFunction: { WEBHOOK_SIGNING_SECRET: 'known-local-fixture' },
      StripeWebhookFunction: {
        DYNAMODB_ENDPOINT: 'http://dynamodb-local:8000',
        STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
      },
    };

    const result = buildSamLocalEnvironment(fixture, {
      VENDOR_AUTH_TOKEN: 'unrelated-secret',
      STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
      STRIPE_TIMEOUT_MS: '4200',
    });

    expect(result).toEqual({
      OrdersApiFunction: {
        DYNAMODB_ENDPOINT: 'http://dynamodb-local:8000',
        STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
        STRIPE_TIMEOUT_MS: '4200',
      },
      VendorWebhookFunction: { WEBHOOK_SIGNING_SECRET: 'known-local-fixture' },
      StripeWebhookFunction: {
        DYNAMODB_ENDPOINT: 'http://dynamodb-local:8000',
        STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
        STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
        STRIPE_TIMEOUT_MS: '4200',
      },
    });
    expect(JSON.stringify(result)).not.toContain('unrelated-secret');
    expect(fixture['OrdersApiFunction']).not.toHaveProperty('STRIPE_SECRET_KEY');
  });

  it('injects the ephemeral Stripe CLI webhook secret only into its webhook function', () => {
    const result = buildSamLocalEnvironment(
      {
        OrdersApiFunction: {},
        StripeWebhookFunction: { DYNAMODB_ENDPOINT: 'local' },
      },
      { STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key' },
      { stripeWebhookSecret: 'whsec_synthetic_cli_secret' },
    );

    expect(result).toMatchObject({
      OrdersApiFunction: {
        STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
      },
      StripeWebhookFunction: {
        DYNAMODB_ENDPOINT: 'local',
        STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
        STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_cli_secret',
      },
    });
    expect(result['OrdersApiFunction']).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
  });

  it.each([
    [{}, 'STRIPE_SECRET_KEY is missing'],
    [{ STRIPE_SECRET_KEY: 'sk_live_forbidden' }, 'must be a Stripe Sandbox key'],
    [
      { STRIPE_SECRET_KEY: 'sk_test_replace-with-your-stripe-sandbox-secret-key' },
      'still contains the example placeholder',
    ],
    [
      { STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key', STRIPE_TIMEOUT_MS: '0' },
      'STRIPE_TIMEOUT_MS must be a positive integer',
    ],
  ])('rejects unsafe local Stripe configuration', (environment, expectedMessage) => {
    expect(() => buildSamLocalEnvironment({ OrdersApiFunction: {} }, environment)).toThrow(
      expectedMessage,
    );
  });

  it('rejects a malformed ephemeral Stripe CLI webhook secret', () => {
    expect(() =>
      buildSamLocalEnvironment(
        { OrdersApiFunction: {}, StripeWebhookFunction: {} },
        { STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key' },
        { stripeWebhookSecret: 'not-a-webhook-secret' },
      ),
    ).toThrow('must begin with whsec_');
  });

  it('writes a mode-0600 runtime file without copying unrelated local secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sam-local-environment-'));
    temporaryDirectories.push(directory);
    const environmentPath = join(directory, '.env.development.local');
    const sourceFixturePath = join(directory, 'fixture.json');
    const outputPath = join(directory, 'runtime/environment.json');
    await Promise.all([
      writeFile(
        environmentPath,
        [
          'VENDOR_AUTH_TOKEN=must-not-be-copied',
          'STRIPE_SECRET_KEY=sk_test_synthetic_local_key',
          'STRIPE_TIMEOUT_MS=5000',
          '',
        ].join('\n'),
        { mode: 0o600 },
      ),
      writeFile(
        sourceFixturePath,
        JSON.stringify({ OrdersApiFunction: { DYNAMODB_ENDPOINT: 'local' } }),
      ),
    ]);

    await createSamLocalEnvironmentFile({ environmentPath, sourceFixturePath, outputPath });

    const output = await readFile(outputPath, 'utf8');
    expect(JSON.parse(output)).toMatchObject({
      OrdersApiFunction: {
        STRIPE_SECRET_KEY: 'sk_test_synthetic_local_key',
        STRIPE_TIMEOUT_MS: '5000',
      },
    });
    expect(output).not.toContain('must-not-be-copied');
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it('refuses a local environment file with broad permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sam-local-environment-'));
    temporaryDirectories.push(directory);
    const environmentPath = join(directory, '.env.development.local');
    const sourceFixturePath = join(directory, 'fixture.json');
    const outputPath = join(directory, 'runtime/environment.json');
    await Promise.all([
      writeFile(environmentPath, 'STRIPE_SECRET_KEY=sk_test_synthetic_local_key\n', {
        mode: 0o644,
      }),
      writeFile(sourceFixturePath, JSON.stringify({ OrdersApiFunction: {} })),
    ]);

    await expect(
      createSamLocalEnvironmentFile({ environmentPath, sourceFixturePath, outputPath }),
    ).rejects.toThrow('must use mode 0600');
  });
});
