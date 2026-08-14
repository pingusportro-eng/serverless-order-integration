import { describe, expect, it } from 'vitest';

import { InvalidUiConfigurationError, readUiConfiguration } from '../src/configuration.js';

describe('UI configuration', () => {
  it('uses the local API automatically during Vite development', () => {
    expect(readUiConfiguration({ DEV: true })).toEqual({
      apiBaseUrl: 'http://127.0.0.1:3000',
      authMode: 'local-bypass',
    });
  });

  it('uses the explicit local bypass only when Cognito settings are absent', () => {
    expect(readUiConfiguration({ VITE_API_BASE_URL: 'http://127.0.0.1:3000/' })).toEqual({
      apiBaseUrl: 'http://127.0.0.1:3000',
      authMode: 'local-bypass',
    });
  });

  it('recognizes Cognito only when its public settings are complete', () => {
    expect(
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_COGNITO_DOMAIN: 'https://example.auth.eu-central-1.amazoncognito.com',
        VITE_COGNITO_CLIENT_ID: 'client-123',
      }),
    ).toEqual({ apiBaseUrl: 'https://api.example.test', authMode: 'cognito' });

    expect(() =>
      readUiConfiguration({
        VITE_API_BASE_URL: 'https://api.example.test',
        VITE_COGNITO_DOMAIN: 'https://example.auth.eu-central-1.amazoncognito.com',
      }),
    ).toThrow(InvalidUiConfigurationError);
  });

  it.each([undefined, 'relative/orders', 'file:///tmp/orders'])(
    'rejects an unsafe API base URL: %s',
    (apiBaseUrl) => {
      expect(() => readUiConfiguration({ VITE_API_BASE_URL: apiBaseUrl })).toThrow(
        InvalidUiConfigurationError,
      );
    },
  );
});
