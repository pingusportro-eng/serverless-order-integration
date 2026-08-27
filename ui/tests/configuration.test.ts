import { describe, expect, it } from 'vitest';

import { InvalidUiConfigurationError, readUiConfiguration } from '../src/configuration.js';

const STRIPE_PUBLISHABLE_KEY = 'pk_test_example';

describe('UI configuration', () => {
  it('uses the local API automatically during Vite development', () => {
    expect(
      readUiConfiguration({ DEV: true, VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY }),
    ).toEqual({
      apiBaseUrl: 'http://127.0.0.1:3000',
      authMode: 'local-bypass',
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY,
    });
  });

  it('uses the explicit local bypass only when Cognito settings are absent', () => {
    expect(
      readUiConfiguration({
        VITE_API_BASE_URL: 'http://127.0.0.1:3000/',
        VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
      }),
    ).toEqual({
      apiBaseUrl: 'http://127.0.0.1:3000',
      authMode: 'local-bypass',
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY,
    });
  });

  it('recognizes Cognito only when its public settings are complete', () => {
    expect(
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
        VITE_COGNITO_DOMAIN: 'https://example.auth.eu-central-1.amazoncognito.com',
        VITE_COGNITO_CLIENT_ID: 'client-123',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      authMode: 'cognito',
      cognito: {
        clientId: 'client-123',
        domain: 'https://example.auth.eu-central-1.amazoncognito.com',
        redirectUri: 'http://127.0.0.1:3002/auth/callback',
      },
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY,
    });

    expect(() =>
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
        VITE_COGNITO_DOMAIN: 'https://example.auth.eu-central-1.amazoncognito.com',
      }),
    ).toThrow(InvalidUiConfigurationError);
  });

  it('normalizes reviewed Cognito endpoints', () => {
    expect(
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
        VITE_COGNITO_DOMAIN: 'https://login.example.test/',
        VITE_COGNITO_CLIENT_ID: 'client-123',
        VITE_COGNITO_REDIRECT_URI: 'https://ui.example.test/auth/callback',
      }),
    ).toMatchObject({
      authMode: 'cognito',
      cognito: {
        domain: 'https://login.example.test',
        redirectUri: 'https://ui.example.test/auth/callback',
      },
    });
  });

  it.each([
    { VITE_COGNITO_DOMAIN: 'http://login.example.test' },
    { VITE_COGNITO_DOMAIN: 'https://login.example.test/oauth2' },
    { VITE_COGNITO_REDIRECT_URI: 'http://ui.example.test/auth/callback' },
    { VITE_COGNITO_REDIRECT_URI: 'javascript:alert(1)' },
  ])('rejects unsafe Cognito endpoint configuration: %s', (override) => {
    expect(() =>
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
        VITE_COGNITO_DOMAIN: 'https://login.example.test',
        VITE_COGNITO_CLIENT_ID: 'client-123',
        ...override,
      }),
    ).toThrow(InvalidUiConfigurationError);
  });

  it.each([undefined, 'relative/orders', 'file:///tmp/orders'])(
    'rejects an unsafe API base URL: %s',
    (apiBaseUrl) => {
      expect(() =>
        readUiConfiguration({
          VITE_API_BASE_URL: apiBaseUrl,
          VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
        }),
      ).toThrow(InvalidUiConfigurationError);
    },
  );

  it.each([undefined, '', 'pk_test_', 'pk_live_example', 'sk_test_example'])(
    'rejects a missing or unsafe Stripe publishable key: %s',
    (publishableKey) => {
      expect(() =>
        readUiConfiguration({
          DEV: true,
          VITE_STRIPE_PUBLISHABLE_KEY: publishableKey,
        }),
      ).toThrow(InvalidUiConfigurationError);
    },
  );
});
