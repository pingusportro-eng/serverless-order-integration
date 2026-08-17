import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localEnvironmentPath = join(projectRoot, '.env.development.local');
const fixturePath = join(projectRoot, 'sam-local-fixture.json');
const runtimeEnvironmentPath = join(projectRoot, '.aws-sam/sam-local-runtime-env.json');

function fail(message) {
  throw new Error(`SAM local: ${message}`);
}

export function buildSamLocalEnvironment(fixture, localEnvironment) {
  const stripeSecretKey = localEnvironment.STRIPE_SECRET_KEY?.trim();
  if (stripeSecretKey === undefined || stripeSecretKey.length === 0) {
    fail('STRIPE_SECRET_KEY is missing from .env.development.local');
  }
  if (!stripeSecretKey.startsWith('sk_test_')) {
    fail('STRIPE_SECRET_KEY must be a Stripe Sandbox key beginning with sk_test_');
  }
  if (stripeSecretKey.includes('replace-with')) {
    fail('STRIPE_SECRET_KEY still contains the example placeholder');
  }

  const stripeTimeoutMs = localEnvironment.STRIPE_TIMEOUT_MS?.trim() || '5000';
  const parsedTimeout = Number(stripeTimeoutMs);
  if (!Number.isSafeInteger(parsedTimeout) || parsedTimeout <= 0) {
    fail('STRIPE_TIMEOUT_MS must be a positive integer');
  }

  const ordersApiEnvironment = fixture.OrdersApiFunction;
  if (
    typeof ordersApiEnvironment !== 'object' ||
    ordersApiEnvironment === null ||
    Array.isArray(ordersApiEnvironment)
  ) {
    fail('sam-local-fixture.json must define OrdersApiFunction');
  }

  return {
    ...fixture,
    OrdersApiFunction: {
      ...ordersApiEnvironment,
      STRIPE_SECRET_KEY: stripeSecretKey,
      STRIPE_TIMEOUT_MS: stripeTimeoutMs,
    },
  };
}

export async function createSamLocalEnvironmentFile({
  environmentPath = localEnvironmentPath,
  sourceFixturePath = fixturePath,
  outputPath = runtimeEnvironmentPath,
} = {}) {
  let environmentFileStat;
  try {
    environmentFileStat = await stat(environmentPath);
  } catch {
    fail('.env.development.local is missing; copy .env.example and keep it git-ignored');
  }
  if ((environmentFileStat.mode & 0o777) !== 0o600) {
    fail('.env.development.local must use mode 0600');
  }

  const [environmentSource, fixtureSource] = await Promise.all([
    readFile(environmentPath, 'utf8'),
    readFile(sourceFixturePath, 'utf8'),
  ]);
  const localEnvironment = parseEnv(environmentSource);
  const fixture = JSON.parse(fixtureSource);
  const runtimeEnvironment = buildSamLocalEnvironment(fixture, localEnvironment);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(runtimeEnvironment, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

async function runSamLocal() {
  const environmentFile = await createSamLocalEnvironmentFile();
  process.stdout.write('Stripe Sandbox payment preparation enabled for SAM local.\n');
  process.stdout.write(
    'The Stripe secret key is loaded from the ignored local environment and is not logged.\n',
  );

  const child = spawn(
    'sam',
    [
      'local',
      'start-api',
      '--docker-network',
      'serverless-order-integration_default',
      '--env-vars',
      environmentFile,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, SAM_CLI_TELEMETRY: '0' },
      stdio: 'inherit',
    },
  );

  let forwardedSignal;
  const forward = (signal) => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  const interrupt = () => {
    forward('SIGINT');
  };
  const terminate = () => {
    forward('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    if (forwardedSignal !== undefined || result.signal !== null) {
      return;
    }
    if (result.code !== 0) {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    await rm(environmentFile, { force: true });
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  runSamLocal().catch(async (error) => {
    await rm(runtimeEnvironmentPath, { force: true });
    process.stderr.write(
      `${error instanceof Error ? error.message : 'SAM local failed unexpectedly.'}\n`,
    );
    process.exitCode = 1;
  });
}
