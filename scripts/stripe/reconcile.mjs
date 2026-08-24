import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { previewStripeReconciliation } from '../../dist/application/preview-stripe-reconciliation.js';
import { createStripePaymentClient } from '../../dist/integrations/stripe-payment-client.js';
import { createStripeReconciliationEventSource } from '../../dist/integrations/stripe-reconciliation-event-source.js';
import { runStripeReconciliationCli, stripeReconciliationUsage } from './reconcile-preview.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function previewCampaign({ command, configuration, now }) {
  const clientOptions = {
    apiKey: configuration.apiKey,
    timeoutMs: configuration.timeoutMs,
  };
  return previewStripeReconciliation(
    {
      eventSource: createStripeReconciliationEventSource(clientOptions),
      stripeClient: createStripePaymentClient(clientOptions),
      expectedStripeAccountId: configuration.expectedStripeAccountId,
      now,
    },
    command,
  );
}

runStripeReconciliationCli({
  arguments_: process.argv.slice(2),
  projectRoot,
  previewCampaign,
  output: process.stdout,
}).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Stripe reconciliation failed unexpectedly.'}\n`,
  );
  process.stderr.write(`${stripeReconciliationUsage()}\n`);
  process.exitCode = 1;
});
