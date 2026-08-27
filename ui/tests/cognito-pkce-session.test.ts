import { webcrypto } from 'node:crypto';

import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  authenticateWithCognito,
  CognitoAuthenticationError,
  type CognitoPkceBrowser,
} from '../src/cognito-pkce-session.js';

const CONFIGURATION = {
  domain: 'https://example.auth.eu-central-1.amazoncognito.com',
  clientId: 'client-123',
  redirectUri: 'http://127.0.0.1:3002/auth/callback',
};
const NOW = Date.parse('2026-08-25T10:00:00.000Z');

class MemoryStorage implements Pick<Storage, 'getItem' | 'removeItem' | 'setItem'> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function browserFixture(
  currentUrl: string,
  storage = new MemoryStorage(),
): Omit<CognitoPkceBrowser, 'fetch' | 'navigate' | 'replaceUrl' | 'storage'> & {
  readonly navigate: Mock<(url: string) => void>;
  readonly replaceUrl: Mock<(url: string) => void>;
  readonly storage: MemoryStorage;
  readonly fetch: Mock<typeof fetch>;
} {
  return {
    currentUrl: () => currentUrl,
    navigate: vi.fn<(url: string) => void>(),
    replaceUrl: vi.fn<(url: string) => void>(),
    storage,
    cryptography: webcrypto as Crypto,
    fetch: vi.fn<typeof fetch>(),
    now: () => NOW,
  };
}

async function startedTransaction(): Promise<{
  readonly storage: MemoryStorage;
  readonly state: string;
}> {
  const browser = browserFixture('http://127.0.0.1:3002/');
  await authenticateWithCognito(CONFIGURATION, browser);
  const authorizationUrl = new URL(String(browser.navigate.mock.calls[0]?.[0]));
  return { storage: browser.storage, state: authorizationUrl.searchParams.get('state') ?? '' };
}

describe('Cognito Authorization Code + PKCE session', () => {
  it('stores a temporary verifier and redirects with an S256 challenge', async () => {
    const browser = browserFixture('http://127.0.0.1:3002/');

    await expect(authenticateWithCognito(CONFIGURATION, browser)).resolves.toEqual({
      kind: 'redirecting',
    });

    expect(browser.navigate).toHaveBeenCalledOnce();
    const authorizationUrl = new URL(String(browser.navigate.mock.calls[0]?.[0]));
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${CONFIGURATION.domain}/oauth2/authorize`,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CONFIGURATION.clientId,
      redirect_uri: CONFIGURATION.redirectUri,
      scope: 'openid',
      code_challenge_method: 'S256',
    });
    expect(authorizationUrl.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const transaction = [...browser.storage.values.values()].join('');
    expect(transaction).not.toContain(String(authorizationUrl.searchParams.get('code_challenge')));
  });

  it('validates the callback and exchanges the code without persisting tokens', async () => {
    const started = await startedTransaction();
    const browser = browserFixture(
      `${CONFIGURATION.redirectUri}?code=authorization-code&state=${started.state}`,
      started.storage,
    );
    browser.fetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(authenticateWithCognito(CONFIGURATION, browser)).resolves.toEqual({
      kind: 'authenticated',
      accessToken: 'access-token',
    });

    expect(browser.fetch).toHaveBeenCalledOnce();
    const [endpoint, request] = browser.fetch.mock.calls[0] as [URL, RequestInit];
    expect(endpoint.href).toBe(`${CONFIGURATION.domain}/oauth2/token`);
    expect(request.method).toBe('POST');
    expect(request.credentials).toBe('omit');
    const body = request.body as URLSearchParams;
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: CONFIGURATION.clientId,
      code: 'authorization-code',
      redirect_uri: CONFIGURATION.redirectUri,
    });
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser.storage.values.size).toBe(0);
    expect(browser.replaceUrl).toHaveBeenCalledWith(CONFIGURATION.redirectUri);
  });

  it('rejects a callback whose state does not match without calling the token endpoint', async () => {
    const started = await startedTransaction();
    const browser = browserFixture(
      `${CONFIGURATION.redirectUri}?code=authorization-code&state=attacker-state`,
      started.storage,
    );

    await expect(authenticateWithCognito(CONFIGURATION, browser)).rejects.toThrow(
      CognitoAuthenticationError,
    );
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(browser.storage.values.size).toBe(0);
  });

  it('rejects an expired transaction before exchanging the code', async () => {
    const started = await startedTransaction();
    const browser = browserFixture(
      `${CONFIGURATION.redirectUri}?code=authorization-code&state=${started.state}`,
      started.storage,
    );
    Object.defineProperty(browser, 'now', { value: () => NOW + 10 * 60 * 1000 + 1 });

    await expect(authenticateWithCognito(CONFIGURATION, browser)).rejects.toThrow(/expired/);
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(browser.storage.values.size).toBe(0);
  });

  it('rejects an invalid token response without storing its contents', async () => {
    const started = await startedTransaction();
    const browser = browserFixture(
      `${CONFIGURATION.redirectUri}?code=authorization-code&state=${started.state}`,
      started.storage,
    );
    browser.fetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'unexpected-token', token_type: 'NotBearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(authenticateWithCognito(CONFIGURATION, browser)).rejects.toThrow(
      /invalid token response/,
    );
    expect(browser.storage.values.size).toBe(0);
    expect(browser.replaceUrl).not.toHaveBeenCalled();
  });
});
