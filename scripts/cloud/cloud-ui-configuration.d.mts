export interface CloudUiConfigurationInput {
  readonly apiUrl: string;
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly stripePublishableKey: string;
}

export interface CloudUiConfiguration {
  readonly localUrl: 'http://127.0.0.1:3002';
  readonly redirectUri: 'http://127.0.0.1:3002/auth/callback';
  readonly environment: {
    readonly VITE_API_BASE_URL: string;
    readonly VITE_STRIPE_PUBLISHABLE_KEY: string;
    readonly VITE_COGNITO_DOMAIN: string;
    readonly VITE_COGNITO_CLIENT_ID: string;
    readonly VITE_COGNITO_REDIRECT_URI: string;
  };
  readonly fingerprint: string;
}

export function createCloudUiConfiguration(input: CloudUiConfigurationInput): CloudUiConfiguration;

export function createCloudUiProcessEnvironment(
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  publicEnvironment: CloudUiConfiguration['environment'],
): Record<string, string | undefined>;

export function stripePublishableKeyFromLocalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string;
