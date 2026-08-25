export interface CognitoPkceConfiguration {
  readonly domain: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface CognitoPkceBrowser {
  readonly currentUrl: () => string;
  readonly navigate: (url: string) => void;
  readonly replaceUrl: (url: string) => void;
  readonly storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;
  readonly cryptography: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

export type CognitoAuthenticationResult =
  | { readonly kind: 'authenticated'; readonly accessToken: string }
  | { readonly kind: 'redirecting' };

interface PkceTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAtMs: number;
}

const TRANSACTION_STORAGE_KEY = 'serverless-order-integration:cognito-pkce';
const MAX_TRANSACTION_AGE_MS = 10 * 60 * 1000;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export class CognitoAuthenticationError extends Error {
  override readonly name = 'CognitoAuthenticationError';
}

function base64Url(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET.charAt((packed >>> 18) & 63);
    encoded += BASE64_ALPHABET.charAt((packed >>> 12) & 63);
    encoded += second === undefined ? '=' : BASE64_ALPHABET.charAt((packed >>> 6) & 63);
    encoded += third === undefined ? '=' : BASE64_ALPHABET.charAt(packed & 63);
  }
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomValue(cryptography: CognitoPkceBrowser['cryptography']): string {
  const bytes = new Uint8Array(32);
  cryptography.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallenge(
  cryptography: CognitoPkceBrowser['cryptography'],
  verifier: string,
): Promise<string> {
  const digest = await cryptography.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function transactionFromStorage(storage: CognitoPkceBrowser['storage']): PkceTransaction {
  const serialized = storage.getItem(TRANSACTION_STORAGE_KEY);
  if (serialized === null) {
    throw new CognitoAuthenticationError('The Cognito sign-in transaction is missing.');
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('state' in value) ||
      typeof value.state !== 'string' ||
      !('codeVerifier' in value) ||
      typeof value.codeVerifier !== 'string' ||
      !('redirectUri' in value) ||
      typeof value.redirectUri !== 'string' ||
      !('createdAtMs' in value) ||
      typeof value.createdAtMs !== 'number'
    ) {
      throw new Error('invalid transaction');
    }
    return value as PkceTransaction;
  } catch {
    throw new CognitoAuthenticationError('The Cognito sign-in transaction is invalid.');
  }
}

function isCallback(currentUrl: URL, redirectUri: URL): boolean {
  return (
    currentUrl.origin === redirectUri.origin &&
    currentUrl.pathname === redirectUri.pathname &&
    (currentUrl.searchParams.has('code') || currentUrl.searchParams.has('error'))
  );
}

async function beginAuthorization(
  configuration: CognitoPkceConfiguration,
  browser: CognitoPkceBrowser,
): Promise<CognitoAuthenticationResult> {
  const transaction: PkceTransaction = {
    state: randomValue(browser.cryptography),
    codeVerifier: randomValue(browser.cryptography),
    redirectUri: configuration.redirectUri,
    createdAtMs: (browser.now ?? Date.now)(),
  };
  browser.storage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify(transaction));

  const authorizationUrl = new URL('/oauth2/authorize', configuration.domain);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', configuration.clientId);
  authorizationUrl.searchParams.set('redirect_uri', configuration.redirectUri);
  authorizationUrl.searchParams.set('scope', 'openid');
  authorizationUrl.searchParams.set('state', transaction.state);
  authorizationUrl.searchParams.set(
    'code_challenge',
    await codeChallenge(browser.cryptography, transaction.codeVerifier),
  );
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  browser.navigate(authorizationUrl.href);
  return { kind: 'redirecting' };
}

async function exchangeAuthorizationCode(
  configuration: CognitoPkceConfiguration,
  browser: CognitoPkceBrowser,
  callbackUrl: URL,
): Promise<CognitoAuthenticationResult> {
  const transaction = transactionFromStorage(browser.storage);
  const callbackState = callbackUrl.searchParams.get('state');
  if (callbackState === null || callbackState !== transaction.state) {
    browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
    throw new CognitoAuthenticationError('The Cognito callback state does not match.');
  }
  const now = (browser.now ?? Date.now)();
  if (now < transaction.createdAtMs || now - transaction.createdAtMs > MAX_TRANSACTION_AGE_MS) {
    browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
    throw new CognitoAuthenticationError('The Cognito sign-in transaction has expired.');
  }
  if (transaction.redirectUri !== configuration.redirectUri) {
    browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
    throw new CognitoAuthenticationError('The Cognito callback URI does not match.');
  }
  const authorizationError = callbackUrl.searchParams.get('error');
  if (authorizationError !== null) {
    browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
    throw new CognitoAuthenticationError(`Cognito rejected sign-in: ${authorizationError}.`);
  }
  const code = callbackUrl.searchParams.get('code');
  if (code === null || code.length === 0) {
    browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
    throw new CognitoAuthenticationError('The Cognito callback contains no authorization code.');
  }

  browser.storage.removeItem(TRANSACTION_STORAGE_KEY);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: configuration.clientId,
    code,
    redirect_uri: configuration.redirectUri,
    code_verifier: transaction.codeVerifier,
  });
  const response = await browser.fetch(new URL('/oauth2/token', configuration.domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new CognitoAuthenticationError('Cognito could not exchange the authorization code.');
  }
  const payload: unknown = await response.json();
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('access_token' in payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0 ||
    !('token_type' in payload) ||
    payload.token_type !== 'Bearer'
  ) {
    throw new CognitoAuthenticationError('Cognito returned an invalid token response.');
  }
  browser.replaceUrl(configuration.redirectUri);
  return { kind: 'authenticated', accessToken: payload.access_token };
}

export async function authenticateWithCognito(
  configuration: CognitoPkceConfiguration,
  browser: CognitoPkceBrowser,
): Promise<CognitoAuthenticationResult> {
  const currentUrl = new URL(browser.currentUrl());
  const redirectUri = new URL(configuration.redirectUri);
  if (!isCallback(currentUrl, redirectUri)) {
    return beginAuthorization(configuration, browser);
  }
  return exchangeAuthorizationCode(configuration, browser, currentUrl);
}
