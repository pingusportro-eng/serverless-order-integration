import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { parseEnv } from 'node:util';

export const LOCAL_RECONCILIATION_TABLE = 'serverless-order-integration-local';
export const LOCAL_RECONCILIATION_ENDPOINT = 'http://127.0.0.1:8000';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MANIFEST_DIRECTORY = '.aws-sam/stripe-reconcile';
const MAX_RECONCILIATION_EVENTS = 100;
const CAMPAIGN_ID =
  /^\d{8}T\d{6}(?:\.\d{1,3})?Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    '  npm run stripe:reconcile -- execute --campaign <campaign-id>',
  ].join('\n');
}

export function parseStripeReconciliationArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    return { kind: 'help' };
  }
  if (arguments_[0] === 'execute') {
    if (arguments_.length !== 3 || arguments_[1] !== '--campaign') {
      fail('execute requires exactly --campaign <campaign-id>');
    }
    const campaignId = optionValue(arguments_, 1, '--campaign');
    if (!CAMPAIGN_ID.test(campaignId)) {
      fail('--campaign must be an exact generated campaign ID');
    }
    return { kind: 'execute', campaignId };
  }
  if (arguments_[0] !== 'preview') {
    fail('the operation must be preview or execute');
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
  const manifest = {
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
  return { ...manifest, manifestDigest: manifestDigestOf(manifest) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestDigestOf(manifest) {
  return `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
}

function objectValue(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  if (actual.length !== reviewed.length || actual.some((key, index) => key !== reviewed[index])) {
    fail(`${name} contains unexpected or missing fields`);
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function rfc3339(value, name) {
  const result = nonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(result))) {
    fail(`${name} must be an RFC3339 timestamp`);
  }
  return new Date(result).toISOString();
}

function validatedSelection(value) {
  const selection = objectValue(value, 'manifest selection');
  if (selection.kind === 'event_ids') {
    exactKeys(selection, ['kind', 'eventIds'], 'manifest selection');
    if (
      !Array.isArray(selection.eventIds) ||
      selection.eventIds.length === 0 ||
      selection.eventIds.length > MAX_RECONCILIATION_EVENTS
    ) {
      fail('manifest exact event selection is empty or exceeds the hard limit');
    }
    const eventIds = selection.eventIds.map((eventId) => nonEmptyString(eventId, 'event ID'));
    if (
      eventIds.some((eventId) => !eventId.startsWith('evt_')) ||
      new Set(eventIds).size !== eventIds.length
    ) {
      fail('manifest exact event selection is invalid');
    }
    return { kind: 'event_ids', eventIds };
  }
  if (selection.kind === 'time_range') {
    exactKeys(selection, ['kind', 'since', 'until', 'limit', 'hasMore'], 'manifest selection');
    const since = rfc3339(selection.since, 'manifest since');
    const until = rfc3339(selection.until, 'manifest until');
    if (
      since >= until ||
      !Number.isSafeInteger(selection.limit) ||
      selection.limit < 1 ||
      selection.limit > MAX_RECONCILIATION_EVENTS ||
      typeof selection.hasMore !== 'boolean'
    ) {
      fail('manifest time-range selection is invalid');
    }
    return { kind: 'time_range', since, until, limit: selection.limit, hasMore: selection.hasMore };
  }
  fail('manifest selection kind is invalid');
}

function validatedEntry(value) {
  const entry = objectValue(value, 'manifest entry');
  exactKeys(
    entry,
    [
      'eventId',
      'eventType',
      'eventCreatedAt',
      'eventFingerprint',
      'stripePaymentIntentId',
      'merchantId',
      'orderId',
    ],
    'manifest entry',
  );
  const eventId = nonEmptyString(entry.eventId, 'manifest event ID');
  const eventFingerprint = nonEmptyString(entry.eventFingerprint, 'manifest event fingerprint');
  const stripePaymentIntentId = nonEmptyString(
    entry.stripePaymentIntentId,
    'manifest PaymentIntent ID',
  );
  if (
    !eventId.startsWith('evt_') ||
    !/^[a-f0-9]{64}$/.test(eventFingerprint) ||
    !stripePaymentIntentId.startsWith('pi_')
  ) {
    fail(`manifest entry ${eventId} has invalid identifiers`);
  }
  return {
    eventId,
    eventType: nonEmptyString(entry.eventType, 'manifest event type'),
    eventCreatedAt: rfc3339(entry.eventCreatedAt, 'manifest event creation time'),
    eventFingerprint,
    stripePaymentIntentId,
    merchantId: nonEmptyString(entry.merchantId, 'manifest merchant ID'),
    orderId: nonEmptyString(entry.orderId, 'manifest order ID'),
  };
}

export async function loadStripeReconciliationManifest({ campaignId, directory, configuration }) {
  if (!CAMPAIGN_ID.test(campaignId)) {
    fail('--campaign must be an exact generated campaign ID');
  }
  const manifestPath = join(directory, `${campaignId}.json`);
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch {
    fail(`campaign ${campaignId} does not exist`);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    fail('campaign manifest must be a regular file');
  }
  if ((manifestStat.mode & 0o777) !== 0o600) {
    fail('campaign manifest must use mode 0600');
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail('campaign manifest is not valid JSON');
  }
  const source = objectValue(parsed, 'campaign manifest');
  exactKeys(
    source,
    [
      'schemaVersion',
      'campaignId',
      'operation',
      'createdAt',
      'previewedAt',
      'targetStripeAccountId',
      'localTable',
      'selection',
      'entries',
      'manifestDigest',
    ],
    'campaign manifest',
  );
  const { manifestDigest, ...unsignedManifest } = source;
  if (
    typeof manifestDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(manifestDigest) ||
    manifestDigestOf(unsignedManifest) !== manifestDigest
  ) {
    fail('campaign manifest changed after preview');
  }
  if (
    source.schemaVersion !== 1 ||
    source.operation !== 'STRIPE_RECONCILIATION' ||
    source.campaignId !== campaignId
  ) {
    fail('campaign manifest identity is invalid');
  }
  rfc3339(source.createdAt, 'manifest creation time');
  rfc3339(source.previewedAt, 'manifest preview time');
  const targetStripeAccountId = nonEmptyString(
    source.targetStripeAccountId,
    'manifest Stripe account',
  );
  const localTable = objectValue(source.localTable, 'manifest local table');
  exactKeys(localTable, ['endpoint', 'tableName'], 'manifest local table');
  if (
    targetStripeAccountId !== configuration.expectedStripeAccountId ||
    localTable.endpoint !== configuration.dynamoDbEndpoint ||
    localTable.tableName !== configuration.tableName
  ) {
    fail('campaign manifest does not match the reviewed local environment');
  }
  const selection = validatedSelection(source.selection);
  if (!Array.isArray(source.entries) || source.entries.length === 0) {
    fail('campaign manifest must contain at least one reviewed event');
  }
  const entries = source.entries.map(validatedEntry);
  const maximumEntries =
    selection.kind === 'time_range' ? selection.limit : selection.eventIds.length;
  if (
    entries.length > maximumEntries ||
    entries.length > MAX_RECONCILIATION_EVENTS ||
    new Set(entries.map((entry) => entry.eventId)).size !== entries.length
  ) {
    fail('campaign entries exceed the reviewed selection or contain duplicates');
  }
  if (
    selection.kind === 'event_ids' &&
    entries.some((entry) => !selection.eventIds.includes(entry.eventId))
  ) {
    fail('campaign contains an event outside the reviewed selection');
  }
  const sortedEntries = [...entries].sort(
    (left, right) =>
      Date.parse(left.eventCreatedAt) - Date.parse(right.eventCreatedAt) ||
      left.eventId.localeCompare(right.eventId),
  );
  if (entries.some((entry, index) => entry.eventId !== sortedEntries[index]?.eventId)) {
    fail('campaign entries are not in reviewed creation order');
  }

  return {
    schemaVersion: 1,
    campaignId,
    operation: 'STRIPE_RECONCILIATION',
    createdAt: source.createdAt,
    previewedAt: source.previewedAt,
    targetStripeAccountId,
    localTable: {
      endpoint: localTable.endpoint,
      tableName: localTable.tableName,
    },
    selection,
    entries,
    manifestDigest,
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

function printExecution(output, manifestPath, execution) {
  output.write('\nSTRIPE RECONCILIATION EXECUTION\n\n');
  output.write(`Campaign: ${execution.campaignId}\n`);
  output.write(`Manifest: ${manifestPath}\n`);
  for (const outcome of execution.outcomes) {
    output.write(
      `  ${outcome.outcome.toUpperCase()} ${outcome.eventId}${
        outcome.reasonCode === undefined ? '' : ` ${outcome.reasonCode}`
      }${outcome.exceptionName === undefined ? '' : ` ${outcome.exceptionName}`}\n`,
    );
  }
  const applied = execution.outcomes.filter((outcome) => outcome.outcome === 'applied').length;
  const ignored = execution.outcomes.filter((outcome) => outcome.outcome === 'ignored').length;
  const reconciliationRequired = execution.outcomes.filter(
    (outcome) => outcome.outcome === 'reconciliation_required',
  ).length;
  const failed = execution.outcomes.filter((outcome) => outcome.outcome === 'failed').length;
  output.write(
    `Summary: applied=${String(applied)} ignored=${String(ignored)} reconciliation_required=${String(
      reconciliationRequired,
    )} failed=${String(failed)}\n`,
  );
}

export async function runStripeReconciliationCli({
  arguments_,
  projectRoot,
  previewCampaign,
  executeCampaign,
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
  if (parsed.kind === 'execute') {
    if (executeCampaign === undefined) {
      fail('execute campaign dependency is unavailable');
    }
    const manifestPath = join(projectRoot, DEFAULT_MANIFEST_DIRECTORY, `${parsed.campaignId}.json`);
    const manifest = await loadStripeReconciliationManifest({
      campaignId: parsed.campaignId,
      directory: join(projectRoot, DEFAULT_MANIFEST_DIRECTORY),
      configuration,
    });
    const execution = await executeCampaign({ manifest, configuration, now });
    printExecution(output, manifestPath, execution);
    return { manifest, manifestPath, execution };
  }
  if (previewCampaign === undefined) {
    fail('preview campaign dependency is unavailable');
  }
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
