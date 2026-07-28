import process from 'node:process';
import { appendFileSync } from 'node:fs';

import {
  formatMockVendorActivity,
  parseMockVendorScenario,
  startMockDeliveryVendor,
} from '../../dist/mock-vendor/mock-delivery-vendor.js';

const portText = process.env['MOCK_VENDOR_PORT'] ?? '4000';
const port = Number(portText);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`MOCK_VENDOR_PORT must be an integer from 0 to 65535; received ${portText}.`);
}
const scenario = parseMockVendorScenario(process.env['MOCK_VENDOR_SCENARIO'] ?? 'success');
const attemptLog = process.env['MOCK_VENDOR_ATTEMPT_LOG']?.trim();
const authToken =
  process.env['MOCK_VENDOR_TOKEN']?.trim() ?? process.env['VENDOR_AUTH_TOKEN']?.trim();
if (authToken === undefined || authToken.length < 32) {
  throw new Error('MOCK_VENDOR_TOKEN or VENDOR_AUTH_TOKEN must contain at least 32 characters.');
}
const webhookUrl = process.env['MOCK_VENDOR_WEBHOOK_URL']?.trim();
const webhookSigningSecret =
  process.env['MOCK_VENDOR_WEBHOOK_SECRET']?.trim() ??
  process.env['WEBHOOK_SIGNING_SECRET']?.trim();
if ((webhookUrl === undefined) !== (webhookSigningSecret === undefined)) {
  throw new Error(
    'MOCK_VENDOR_WEBHOOK_URL and MOCK_VENDOR_WEBHOOK_SECRET/WEBHOOK_SIGNING_SECRET must be configured together.',
  );
}

const vendor = await startMockDeliveryVendor({
  authToken,
  defaultScenario: scenario,
  port,
  ...(webhookUrl === undefined || webhookSigningSecret === undefined
    ? {}
    : {
        webhook: {
          url: webhookUrl,
          signingSecret: webhookSigningSecret,
        },
      }),
  onActivity(activity) {
    process.stdout.write(`${formatMockVendorActivity(activity)}\n`);
  },
  ...(attemptLog
    ? {
        onAttempt(attempt) {
          appendFileSync(attemptLog, `${JSON.stringify(attempt)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
        },
      }
    : {}),
});

process.stdout.write(`Mock delivery vendor listening at ${vendor.baseUrl} (${scenario})\n`);

async function stop() {
  await vendor.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
