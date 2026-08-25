import { loadStripe } from '@stripe/stripe-js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createOrdersApiClient } from './api/orders-api-client.js';
import { App } from './App.js';
import { authenticateWithCognito } from './cognito-pkce-session.js';
import { readUiConfiguration } from './configuration.js';
import './styles.css';

function requiredRootElement(): Element {
  const element = document.querySelector('#root');
  if (element === null) {
    throw new Error('The UI root element is missing.');
  }
  return element;
}

const rootElement = requiredRootElement();

async function bootstrap(): Promise<void> {
  const configuration = readUiConfiguration(import.meta.env);
  let accessToken: string | undefined;
  if (configuration.authMode === 'cognito') {
    const authentication = await authenticateWithCognito(configuration.cognito, {
      currentUrl: () => window.location.href,
      navigate: (url) => {
        window.location.assign(url);
      },
      replaceUrl: (url) => {
        window.history.replaceState({}, '', url);
      },
      storage: window.sessionStorage,
      cryptography: window.crypto,
      fetch: window.fetch.bind(window),
    });
    if (authentication.kind === 'redirecting') {
      return;
    }
    accessToken = authentication.accessToken;
  }

  const stripe = loadStripe(configuration.stripePublishableKey);
  const ordersApiClient = createOrdersApiClient({
    baseUrl: configuration.apiBaseUrl,
    authorization:
      configuration.authMode === 'local-bypass'
        ? { mode: 'local-bypass' }
        : { mode: 'bearer', accessToken: () => accessToken },
  });
  createRoot(rootElement).render(
    <StrictMode>
      <App ordersApiClient={ordersApiClient} authMode={configuration.authMode} stripe={stripe} />
    </StrictMode>,
  );
}

void bootstrap().catch(() => {
  rootElement.textContent = 'Authentication could not be completed. Reload to try again.';
});
