import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { parseEnv } from 'node:util';

export const LOCAL_RECONCILIATION_TABLE = 'serverless-order-integration-local';
export const LOCAL_RECONCILIATION_ENDPOINT = 'http://127.0.0.1:8000';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MANIFEST_DIRECTORY = '.aws-sam/stripe-reconcile';

function fail(message) {
  throw new Error(`Stripe reconciliation: ${message}`);
}

function optionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${option} requires a value`);
  }
  return value;
}

function setOnce(target, key, value, option) {
  if (target[key] !== undefined) {
    fail(`${option} may be supplied only once`);
  }
  target[key] = value;
}

export function stripeReconciliationUsage() {
  return [
    'Usage:',
    '  npm run stripe:reconcile -- preview --since <RFC3339> [--until <RFC3339>] [--limit <1-100>]',
    '  npm run stripe:reconcile -- preview --event-id <evt_...> [--event-id <evt_...>] [--limit <1-100>]',
  ].join('\n');
}

export function parseStripeReconciliationArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    return { kind: 'help' };
  }
  if (arguments_[0] !== 'preview') {
    fail('only the read-only preview operation is currently implemented');
  }

  const options = { eventIds: [] };
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--event-id') {
      options.eventIds.push(optionValue(arguments_, index, option));
      index += 1;
      continue;
    }
    if (option === '--since' || option === '--until' || option === '--limit') {
      setOnce(options, option.slice(2), optionValue(arguments_, index, option), option);
      index += 1;
      continue;
    }
    fail(`unknown option ${option ?? '<missing>'}`);
  }

  const hasEventIds = options.eventIds.length > 0;
  if (hasEventIds && (options.since !== undefined || options.until !== undefined)) {
    fail('exact event IDs cannot be combined with a time range');
  }
  if (!hasEventIds && options.since === undefined) {
    fail('preview requires --since or at least one --event-id');
  }

  let limit;
  if (options.limit !== undefined) {
    limit = Number(options.limit);
    if (!Number.isSafeInteger(limit)) {
      fail('--limit must be an integer');
    }
  }

  if (hasEventIds) {
    return {
      kind: 'preview',
      command: {
        kind: 'event_ids',
        eventIds: options.eventIds,
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  return {
    kind: 'preview',
    command: {
      kind: 'time_range',
      since: options.since,
      ...(options.until === undefined ? {} : { until: options.until }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function localEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail('DYNAMODB_ENDPOINT must identify DynamoDB Local on port 8000');
  }
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
    endpoint.port !== '8000' ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.pathname !== '/' ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    fail('DYNAMODB_ENDPOINT must identify DynamoDB Local on port 8000');
  }
  return LOCAL_RECONCILIATION_ENDPOINT;
}

export async function loadStripeReconciliationConfiguration({ environmentPath }) {
  let environmentStat;
  try {
    environmentStat = await stat(environmentPath);
  } catch {
    fail('.env.development.local is missing');
  }
  if ((environmentStat.mode & 0o777) !== 0o600) {
    fail('.env.development.local must use mode 0600');
  }

  const environment = parseEnv(await readFile(environmentPath, 'utf8'));
  const apiKey = environment.STRIPE_SECRET_KEY?.trim();
  if (apiKey === undefined || !apiKey.startsWith('sk_test_') || apiKey.includes('replace-with')) {
    fail('STRIPE_SECRET_KEY must be a configured Stripe Sandbox key beginning with sk_test_');
  }
  const expectedStripeAccountId = environment.STRIPE_ACCOUNT_ID?.trim();
  if (
    expectedStripeAccountId === undefined ||
    !/^acct_[A-Za-z0-9]+$/.test(expectedStripeAccountId)
  ) {
    fail('STRIPE_ACCOUNT_ID must be the reviewed Sandbox account ID beginning with acct_');
  }

  const timeoutMs = Number(environment.STRIPE_TIMEOUT_MS?.trim() || DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('STRIPE_TIMEOUT_MS must be a positive integer');
  }
  const dynamoDbEndpoint = localEndpoint(
    environment.DYNAMODB_ENDPOINT?.trim() || LOCAL_RECONCILIATION_ENDPOINT,
  );
  const tableName = environment.ORDERS_TABLE_NAME?.trim() || LOCAL_RECONCILIATION_TABLE;
  if (tableName !== LOCAL_RECONCILIATION_TABLE) {
    fail(`ORDERS_TABLE_NAME must be ${LOCAL_RECONCILIATION_TABLE}`);
  }

  return { apiKey, expectedStripeAccountId, timeoutMs, dynamoDbEndpoint, tableName };
}

function campaignId(now, uuid) {
  const timestamp = now.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.000', '');
  return `${timestamp}-${uuid}`;
}

function safeEntry(entry) {
  return {
    eventId: entry.eventId,
    eventType: entry.eventType,
    eventCreatedAt: entry.eventCreatedAt,
    eventFingerprint: entry.eventFingerprint,
    stripePaymentIntentId: entry.stripePaymentIntentId,
    merchantId: entry.merchantId,
    orderId: entry.orderId,
  };
}

export function createStripeReconciliationManifest({ preview, configuration, now, uuid }) {
  if (preview.stripeAccountId !== configuration.expectedStripeAccountId) {
    fail('preview account does not match the reviewed configuration');
  }
  return {
    schemaVersion: 1,
    campaignId: campaignId(now, uuid),
    operation: 'STRIPE_RECONCILIATION',
    createdAt: now.toISOString(),
    previewedAt: preview.previewedAt,
    targetStripeAccountId: preview.stripeAccountId,
    localTable: {
      endpoint: configuration.dynamoDbEndpoint,
      tableName: configuration.tableName,
    },
    selection: preview.selection,
    entries: preview.entries.map(safeEntry),
  };
}

export async function writeStripeReconciliationManifest({ manifest, directory }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const manifestPath = join(directory, `${manifest.campaignId}.json`);
  const temporaryPath = join(directory, `.${manifest.campaignId}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, manifestPath);
    await chmod(manifestPath, 0o600);
    return manifestPath;
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function printPreview(output, manifestPath, preview, manifest) {
  output.write('\nSTRIPE RECONCILIATION PREVIEW\n\n');
  output.write(`Campaign: ${manifest.campaignId}\n`);
  output.write(`Stripe account: ${manifest.targetStripeAccountId}\n`);
  output.write(
    `Local table: ${manifest.localTable.tableName} at ${manifest.localTable.endpoint}\n`,
  );
  output.write(`Included events: ${String(preview.entries.length)}\n`);
  for (const entry of preview.entries) {
    output.write(
      `  INCLUDE ${entry.eventCreatedAt} ${entry.eventId} ${entry.eventType} ${entry.orderId}\n`,
    );
  }
  output.write(`Excluded events: ${String(preview.excluded.length)}\n`);
  for (const event of preview.excluded) {
    output.write(`  EXCLUDE ${event.eventId} ${event.reason}\n`);
  }
  if (preview.selection.kind === 'time_range' && preview.selection.hasMore) {
    output.write('WARNING: Stripe reported more matching events beyond this bounded preview.\n');
  }
  output.write(`Manifest: ${manifestPath}\n`);
  output.write('No DynamoDB item was read or changed. Review the manifest before execution.\n');
}

export async function runStripeReconciliationCli({
  arguments_,
  projectRoot,
  previewCampaign,
  output,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const parsed = parseStripeReconciliationArguments(arguments_);
  if (parsed.kind === 'help') {
    output.write(`${stripeReconciliationUsage()}\n`);
    return undefined;
  }

  const configuration = await loadStripeReconciliationConfiguration({
    environmentPath: join(projectRoot, '.env.development.local'),
  });
  const preview = await previewCampaign({ command: parsed.command, configuration, now });
  const manifest = createStripeReconciliationManifest({
    preview,
    configuration,
    now: now(),
    uuid: uuid(),
  });
  const manifestPath = await writeStripeReconciliationManifest({
    manifest,
    directory: join(projectRoot, DEFAULT_MANIFEST_DIRECTORY),
  });
  printPreview(output, manifestPath, preview, manifest);
  return { manifest, manifestPath, preview };
}
