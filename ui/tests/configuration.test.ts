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
