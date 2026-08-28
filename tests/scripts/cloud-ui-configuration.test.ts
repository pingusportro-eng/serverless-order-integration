import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createCloudUiConfiguration,
  createCloudUiProcessEnvironment,
  stripePublishableKeyFromLocalEnvironment,
} from '../../scripts/cloud/cloud-ui-configuration.mjs';

const INPUT = {
  apiUrl: 'https://api-id.execute-api.eu-central-1.amazonaws.com',
  cognitoDomain:
    'https://serverless-order-integration-454921778743-dev.auth.eu-central-1.amazoncognito.com',
  cognitoClientId: 'client123ABC',
  stripePublishableKey: 'pk_test_synthetic_publishable_key',
};

describe('cloud UI configuration', () => {
  it('creates stable public-only Vite configuration for Cognito PKCE', () => {
    const first = createCloudUiConfiguration(INPUT);
    const second = createCloudUiConfiguration(INPUT);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      localUrl: 'http://127.0.0.1:3002',
      redirectUri: 'http://127.0.0.1:3002/auth/callback',
      environment: {
        VITE_API_BASE_URL: INPUT.apiUrl,
        VITE_STRIPE_PUBLISHABLE_KEY: INPUT.stripePublishableKey,
        VITE_COGNITO_DOMAIN: INPUT.cognitoDomain,
        VITE_COGNITO_CLIENT_ID: INPUT.cognitoClientId,
        VITE_COGNITO_REDIRECT_URI: 'http://127.0.0.1:3002/auth/callback',
      },
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(first.environment).every((name) => name.startsWith('VITE_'))).toBe(true);
    expect(JSON.stringify(first.environment)).not.toMatch(/(?:sk_test_|whsec_|client_secret)/);
  });

  it('removes inherited Vite variables before adding the reviewed allowlist', () => {
    const configuration = createCloudUiConfiguration(INPUT);
    const environment = createCloudUiProcessEnvironment(
      {
        PATH: '/usr/bin',
        VITE_UNREVIEWED_VALUE: 'must-not-reach-browser',
        VITE_STRIPE_PUBLISHABLE_KEY: 'pk_live_inherited',
      },
      configuration.environment,
    );

    expect(environment['PATH']).toBe('/usr/bin');
    expect(environment['VITE_UNREVIEWED_VALUE']).toBeUndefined();
    expect(environment['VITE_STRIPE_PUBLISHABLE_KEY']).toBe(INPUT.stripePublishableKey);
    expect(
      Object.keys(environment)
        .filter((name) => name.startsWith('VITE_'))
        .sort(),
    ).toEqual(Object.keys(configuration.environment).sort());
  });

  it('changes the process fingerprint when public deployment identity changes', () => {
    const current = createCloudUiConfiguration(INPUT);
    const changed = createCloudUiConfiguration({ ...INPUT, cognitoClientId: 'replacement456' });

    expect(changed.fingerprint).not.toBe(current.fingerprint);
  });

  it('accepts only reviewed browser-variable names from the ignored UI file', () => {
    expect(
      stripePublishableKeyFromLocalEnvironment({
        VITE_API_BASE_URL: 'http://127.0.0.1:3000',
        VITE_STRIPE_PUBLISHABLE_KEY: INPUT.stripePublishableKey,
      }),
    ).toBe(INPUT.stripePublishableKey);

    expect(() =>
      stripePublishableKeyFromLocalEnvironment({
        VITE_STRIPE_PUBLISHABLE_KEY: INPUT.stripePublishableKey,
        VITE_UNREVIEWED_SECRET: 'must-not-reach-browser',
      }),
    ).toThrow(/VITE_UNREVIEWED_SECRET/);
  });

  it.each([
    { ...INPUT, apiUrl: 'http://api.example.test' },
    { ...INPUT, apiUrl: 'https://api.example.test/orders' },
    { ...INPUT, cognitoDomain: 'https://user:password@auth.example.test' },
    { ...INPUT, cognitoClientId: 'invalid client' },
    { ...INPUT, stripePublishableKey: 'pk_live_forbidden' },
    { ...INPUT, stripePublishableKey: 'sk_test_secret_is_not_browser_configuration' },
  ])('rejects unsafe or non-Sandbox public configuration', (input) => {
    expect(() => createCloudUiConfiguration(input)).toThrow();
  });

  it('wires UI activation before readiness and UI shutdown before cloud cleanup', async () => {
    const source = await readFile('scripts/cloud/development-lab.mjs', 'utf8');
    const deploy = source.slice(source.indexOf('async function deploy()'));
    const teardown = source.slice(
      source.indexOf('async function destroyCloudAndLocal'),
      source.indexOf('async function deploy()'),
    );

    expect(
      deploy.indexOf('state = await prepareCloudUi(stack, state, uiEnvironment);'),
    ).toBeLessThan(deploy.indexOf('printReady(state);'));
    expect(teardown.indexOf('state = await cleanupCloudUi(state);')).toBeLessThan(
      teardown.indexOf('state = await cleanupStripeWebhook(state);'),
    );
    expect(source).toContain("['Mock vendor', state.vendor]");
    expect(source).toContain("['Cloud UI', state.ui]");
  });
});
