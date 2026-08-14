import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createOrdersApiClient } from './api/orders-api-client.js';
import { App } from './App.js';
import { readUiConfiguration } from './configuration.js';
import './styles.css';

const rootElement = document.querySelector('#root');
if (rootElement === null) {
  throw new Error('The UI root element is missing.');
}

const configuration = readUiConfiguration(import.meta.env);
const ordersApiClient = createOrdersApiClient({
  baseUrl: configuration.apiBaseUrl,
  authorization:
    configuration.authMode === 'local-bypass'
      ? { mode: 'local-bypass' }
      : { mode: 'bearer', accessToken: () => undefined },
});

createRoot(rootElement).render(
  <StrictMode>
    <App ordersApiClient={ordersApiClient} authMode={configuration.authMode} />
  </StrictMode>,
);
