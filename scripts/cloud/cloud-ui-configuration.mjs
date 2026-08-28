import { createHash } from 'node:crypto';
import { URL } from 'node:url';

const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:3002/auth/callback';
const PUBLIC_UI_VARIABLES = new Set([
  'VITE_API_BASE_URL',
  'VITE_STRIPE_PUBLISHABLE_KEY',
  'VITE_COGNITO_DOMAIN',
  'VITE_COGNITO_CLIENT_ID',
  'VITE_COGNITO_REDIRECT_URI',
]);

function httpsOrigin(value, description) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${description} must be an absolute URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (parsed.pathname !== '/' && parsed.pathname.length > 0)
  ) {
    throw new TypeError(`${description} must be an HTTPS origin.`);
  }
  return parsed.origin;
}

export function createCloudUiConfiguration({
  apiUrl,
  cognitoDomain,
  cognitoClientId,
  stripePublishableKey,
}) {
  const normalizedApiUrl = httpsOrigin(apiUrl, 'Cloud UI API URL');
  const normalizedCognitoDomain = httpsOrigin(cognitoDomain, 'Cloud UI Cognito domain');
  if (typeof cognitoClientId !== 'string' || !/^[A-Za-z0-9]+$/.test(cognitoClientId)) {
    throw new TypeError('Cloud UI Cognito client ID is invalid.');
  }
  if (
    typeof stripePublishableKey !== 'string' ||
    !stripePublishableKey.startsWith('pk_test_') ||
    stripePublishableKey.length === 'pk_test_'.length
  ) {
    throw new TypeError('Cloud UI requires a Stripe Sandbox publishable key.');
  }

  const environment = {
    VITE_API_BASE_URL: normalizedApiUrl,
    VITE_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
    VITE_COGNITO_DOMAIN: normalizedCognitoDomain,
    VITE_COGNITO_CLIENT_ID: cognitoClientId,
    VITE_COGNITO_REDIRECT_URI: LOOPBACK_REDIRECT_URI,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(environment)).digest('hex');
  return {
    localUrl: 'http://127.0.0.1:3002',
    redirectUri: LOOPBACK_REDIRECT_URI,
    environment,
    fingerprint,
  };
}

export function createCloudUiProcessEnvironment(baseEnvironment, publicEnvironment) {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([name]) => !name.startsWith('VITE_')),
  );
  return { ...environment, ...publicEnvironment };
}

export function stripePublishableKeyFromLocalEnvironment(environment) {
  const unexpected = Object.keys(environment).filter(
    (name) => name.startsWith('VITE_') && !PUBLIC_UI_VARIABLES.has(name),
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `Cloud UI environment contains unreviewed variables: ${unexpected.join(', ')}`,
    );
  }
  const stripePublishableKey = environment.VITE_STRIPE_PUBLISHABLE_KEY?.trim();
  if (
    stripePublishableKey === undefined ||
    !stripePublishableKey.startsWith('pk_test_') ||
    stripePublishableKey.length === 'pk_test_'.length
  ) {
    throw new TypeError('Cloud UI requires a Stripe Sandbox publishable key.');
  }
  return stripePublishableKey;
}
