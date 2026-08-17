export interface UiConfiguration {
  readonly apiBaseUrl: string;
  readonly authMode: 'local-bypass' | 'cognito';
  readonly stripePublishableKey: string;
}

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

export function readUiConfiguration(
  environment: Readonly<Record<string, unknown>>,
): UiConfiguration {
  const cognitoDomain = optionalString(environment, 'VITE_COGNITO_DOMAIN');
  const cognitoClientId = optionalString(environment, 'VITE_COGNITO_CLIENT_ID');
  if ((cognitoDomain === undefined) !== (cognitoClientId === undefined)) {
    throw new InvalidUiConfigurationError(
      'VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID must be configured together.',
    );
  }
  return {
    apiBaseUrl: apiBaseUrl(environment),
    authMode: cognitoDomain === undefined ? 'local-bypass' : 'cognito',
    stripePublishableKey: stripePublishableKey(environment),
  };
}
