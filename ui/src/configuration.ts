interface UiConfigurationBase {
  readonly apiBaseUrl: string;
  readonly stripePublishableKey: string;
}

export interface LocalUiConfiguration extends UiConfigurationBase {
  readonly authMode: 'local-bypass';
}

export interface CognitoUiConfiguration extends UiConfigurationBase {
  readonly authMode: 'cognito';
  readonly cognito: {
    readonly domain: string;
    readonly clientId: string;
    readonly redirectUri: string;
  };
}

export type UiConfiguration = LocalUiConfiguration | CognitoUiConfiguration;

const DEFAULT_COGNITO_REDIRECT_URI = 'http://127.0.0.1:3002/auth/callback';

function stripePublishableKey(environment: Readonly<Record<string, unknown>>): string {
  const value = optionalString(environment, 'VITE_STRIPE_PUBLISHABLE_KEY');
  if (value === undefined) {
    throw new InvalidUiConfigurationError('VITE_STRIPE_PUBLISHABLE_KEY is required.');
  }
  if (!value.startsWith('pk_test_') || value.length === 'pk_test_'.length) {
    throw new InvalidUiConfigurationError(
      'VITE_STRIPE_PUBLISHABLE_KEY must be a Stripe Sandbox publishable key beginning with pk_test_.',
    );
  }
  return value;
}

export class InvalidUiConfigurationError extends Error {
  override readonly name = 'InvalidUiConfigurationError';
}

function optionalString(
  environment: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = environment[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function apiBaseUrl(environment: Readonly<Record<string, unknown>>): string {
  const configured =
    optionalString(environment, 'VITE_API_BASE_URL') ??
    (environment['DEV'] === true ? 'http://127.0.0.1:3000' : undefined);
  if (configured === undefined) {
    throw new InvalidUiConfigurationError('VITE_API_BASE_URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new InvalidUiConfigurationError('VITE_API_BASE_URL must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUiConfigurationError('VITE_API_BASE_URL must use HTTP or HTTPS.');
  }
  return parsed.href.replace(/\/$/, '');
}

function cognitoDomain(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidUiConfigurationError('VITE_COGNITO_DOMAIN must be an absolute URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '/' && parsed.pathname.length > 0)
  ) {
    throw new InvalidUiConfigurationError(
      'VITE_COGNITO_DOMAIN must be an HTTPS origin without credentials, a path, a query, or a fragment.',
    );
  }
  return parsed.origin;
}

function cognitoRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidUiConfigurationError('VITE_COGNITO_REDIRECT_URI must be an absolute URL.');
  }
  const isSecure = parsed.protocol === 'https:';
  const isLocalHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (
    (!isSecure && !isLocalHttp) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new InvalidUiConfigurationError(
      'VITE_COGNITO_REDIRECT_URI must use HTTPS, or HTTP on a local loopback host, and must not contain credentials, a query, or a fragment.',
    );
  }
  return parsed.href;
}

export function readUiConfiguration(
  environment: Readonly<Record<string, unknown>>,
): UiConfiguration {
  const configuredCognitoDomain = optionalString(environment, 'VITE_COGNITO_DOMAIN');
  const cognitoClientId = optionalString(environment, 'VITE_COGNITO_CLIENT_ID');
  if ((configuredCognitoDomain === undefined) !== (cognitoClientId === undefined)) {
    throw new InvalidUiConfigurationError(
      'VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID must be configured together.',
    );
  }
  const common = {
    apiBaseUrl: apiBaseUrl(environment),
    stripePublishableKey: stripePublishableKey(environment),
  };
  if (configuredCognitoDomain === undefined || cognitoClientId === undefined) {
    return { ...common, authMode: 'local-bypass' };
  }
  return {
    ...common,
    authMode: 'cognito',
    cognito: {
      domain: cognitoDomain(configuredCognitoDomain),
      clientId: cognitoClientId,
      redirectUri: cognitoRedirectUri(
        optionalString(environment, 'VITE_COGNITO_REDIRECT_URI') ?? DEFAULT_COGNITO_REDIRECT_URI,
      ),
    },
  };
}
