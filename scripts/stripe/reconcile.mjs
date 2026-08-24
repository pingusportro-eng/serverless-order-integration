import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { executeStripeReconciliation } from '../../dist/application/execute-stripe-reconciliation.js';
import { previewStripeReconciliation } from '../../dist/application/preview-stripe-reconciliation.js';
import { DynamoDbOrderRepository } from '../../dist/infrastructure/dynamodb/dynamodb-order-repository.js';
import { createStripePaymentClient } from '../../dist/integrations/stripe-payment-client.js';
import { createStripeReconciliationEventSource } from '../../dist/integrations/stripe-reconciliation-event-source.js';
import { runStripeReconciliationCli, stripeReconciliationUsage } from './reconcile-preview.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';

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

async function executeCampaign({ manifest, configuration, now }) {
  const clientOptions = {
    apiKey: configuration.apiKey,
    timeoutMs: configuration.timeoutMs,
  };
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: 'eu-central-1',
      endpoint: configuration.dynamoDbEndpoint,
      credentials: {
        accessKeyId: LOCAL_ACCESS_KEY_ID,
        secretAccessKey: LOCAL_SECRET_ACCESS_KEY,
      },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  try {
    return await executeStripeReconciliation(
      {
        eventSource: createStripeReconciliationEventSource(clientOptions),
        stripeClient: createStripePaymentClient(clientOptions),
        repository: new DynamoDbOrderRepository(client, configuration.tableName),
        expectedStripeAccountId: configuration.expectedStripeAccountId,
        now,
      },
      { campaignId: manifest.campaignId, entries: manifest.entries },
    );
  } finally {
    client.destroy();
  }
}

runStripeReconciliationCli({
  arguments_: process.argv.slice(2),
  projectRoot,
  previewCampaign,
  executeCampaign,
  output: process.stdout,
})
  .then((result) => {
    if (result !== undefined && 'execution' in result && !result.execution.successful) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Stripe reconciliation failed unexpectedly.'}\n`,
    );
    process.stderr.write(`${stripeReconciliationUsage()}\n`);
    process.exitCode = 1;
  });
