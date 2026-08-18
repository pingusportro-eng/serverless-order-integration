import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localEnvironmentPath = join(projectRoot, '.env.development.local');
const uiEnvironmentPath = join(projectRoot, 'ui', '.env.local');
const apiBaseUrl = 'http://127.0.0.1:3000';
const uiBaseUrl = 'http://127.0.0.1:3002';

export const STRIPE_EVENT_ALLOWLIST = [
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payment_intent.canceled',
];

function fail(message) {
  throw new Error(`Local lab: ${message}`);
}

export function stripeListenArguments() {
  return [
    'listen',
    '--skip-update',
    '--color',
    'off',
    '--events',
    STRIPE_EVENT_ALLOWLIST.join(','),
    '--forward-to',
    `${apiBaseUrl}/webhooks/stripe`,
  ];
}

export function redactStripeOutput(value) {
  return value
    .replaceAll(/sk_(?:test|live)_[A-Za-z0-9_]+/g, '[redacted Stripe API key]')
    .replaceAll(/whsec_[A-Za-z0-9_]+/g, '[redacted Stripe signing secret]')
    .replaceAll(/pi_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+/g, '[redacted client secret]');
}

async function secureEnvironment(path, description) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(`${description} is missing`);
  }
  if ((details.mode & 0o777) !== 0o600) {
    fail(`${description} must use mode 0600`);
  }
  return parseEnv(await readFile(path, 'utf8'));
}

function stripeApiKey(environment) {
  const value = environment.STRIPE_SECRET_KEY?.trim();
  if (value === undefined || !value.startsWith('sk_test_')) {
    fail('.env.development.local must contain a Stripe Sandbox STRIPE_SECRET_KEY');
  }
  return value;
}

function stripePublishableKey(environment) {
  const value = environment.VITE_STRIPE_PUBLISHABLE_KEY?.trim();
  if (value === undefined || !value.startsWith('pk_test_')) {
    fail('ui/.env.local must contain a Stripe Sandbox VITE_STRIPE_PUBLISHABLE_KEY');
  }
}

function startProcess(label, command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    cwd: projectRoot,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bufferedOutput = '';
  const consume = (chunk) => {
    bufferedOutput += chunk.toString();
    const lines = bufferedOutput.split(/\r?\n/);
    bufferedOutput = lines.pop() ?? '';
    for (const line of lines) {
      options.onLine?.(line);
      if (line.length > 0) {
        process.stdout.write(`[${label}] ${redactStripeOutput(line)}\n`);
      }
    }
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.once('exit', () => {
    if (bufferedOutput.length > 0) {
      process.stdout.write(`[${label}] ${redactStripeOutput(bufferedOutput)}\n`);
      bufferedOutput = '';
    }
  });
  return { label, child };
}

async function runCommand(command, arguments_, environment = process.env) {
  const child = spawn(command, arguments_, {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    fail(`${command} ${arguments_.join(' ')} failed`);
  }
}

async function commandOutput(command, arguments_, environment) {
  const child = spawn(command, arguments_, {
    cwd: projectRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    process.stderr.write(redactStripeOutput(stderr));
    fail(`${command} ${arguments_.join(' ')} failed`);
  }
  return stdout.trim();
}

async function portIsAvailable(port) {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function requireAvailablePorts() {
  for (const port of [3000, 3002]) {
    if (!(await portIsAvailable(port))) {
      fail(`port ${port} is already in use; stop the earlier local API or UI first`);
    }
  }
}

async function waitForHttp(url, managedProcesses, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const managed of managedProcesses) {
      if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
        fail(`${managed.label} stopped before ${url} became ready`);
      }
    }
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Readiness polling expects connection failures while a process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`${url} did not become ready within ${timeoutMs / 1000} seconds`);
}

function stopProcess(managed, signal = 'SIGINT') {
  const pid = managed.child.pid;
  if (pid === undefined || managed.child.exitCode !== null || managed.child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    managed.child.kill(signal);
  }
}

async function waitForExit(managed, timeoutMs = 10_000) {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => managed.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    stopProcess(managed, 'SIGTERM');
  }
}

async function runLocalLab() {
  await requireAvailablePorts();
  const [localEnvironment, uiEnvironment] = await Promise.all([
    secureEnvironment(localEnvironmentPath, '.env.development.local'),
    secureEnvironment(uiEnvironmentPath, 'ui/.env.local'),
  ]);
  const apiKey = stripeApiKey(localEnvironment);
  stripePublishableKey(uiEnvironment);

  const stripeEnvironment = { ...process.env, STRIPE_API_KEY: apiKey };
  const signingSecret = await commandOutput(
    'stripe',
    ['listen', '--print-secret', '--skip-update'],
    stripeEnvironment,
  );
  if (!signingSecret.startsWith('whsec_')) {
    fail('Stripe CLI returned an invalid webhook signing secret');
  }

  await runCommand('npm', ['run', 'dynamodb:bootstrap']);
  await runCommand('npm', ['run', 'sam:build']);

  const managedProcesses = [];
  let stopping = false;
  const beginStop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write('\nStopping the local payment lab...\n');
    for (const managed of managedProcesses.toReversed()) {
      stopProcess(managed);
    }
  };
  process.once('SIGINT', beginStop);
  process.once('SIGTERM', beginStop);

  try {
    let stripeReadyResolve;
    let stripeReadyReject;
    const stripeReady = new Promise((resolve, reject) => {
      stripeReadyResolve = resolve;
      stripeReadyReject = reject;
    });
    const stripeListener = startProcess('stripe', 'stripe', stripeListenArguments(), {
      env: stripeEnvironment,
      onLine: (line) => {
        const reportedSecret = line.match(/whsec_[A-Za-z0-9_]+/)?.[0];
        if (reportedSecret !== undefined && reportedSecret !== signingSecret) {
          stripeReadyReject(new Error('Stripe CLI changed its signing secret between sessions.'));
        }
        if (line.includes('Ready!')) {
          stripeReadyResolve();
        }
      },
    });
    managedProcesses.push(stripeListener);

    const samApi = startProcess('api', 'node', ['scripts/sam/start-local.mjs'], {
      env: { ...process.env, STRIPE_WEBHOOK_SECRET: signingSecret },
    });
    managedProcesses.push(samApi);

    const ui = startProcess('ui', 'npm', ['run', 'dev', '--workspace', 'ui']);
    managedProcesses.push(ui);

    await Promise.all([
      Promise.race([
        stripeReady,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Stripe CLI did not become ready in 30 seconds.')),
            30_000,
          ),
        ),
      ]),
      waitForHttp(`${apiBaseUrl}/orders?limit=1`, managedProcesses),
      waitForHttp(uiBaseUrl, managedProcesses),
    ]);

    process.stdout.write('\nLOCAL PAYMENT LAB READY\n\n');
    process.stdout.write(`UI:             ${uiBaseUrl}\n`);
    process.stdout.write(`API:            ${apiBaseUrl}\n`);
    process.stdout.write(`Stripe webhook: ${apiBaseUrl}/webhooks/stripe\n`);
    process.stdout.write('Stripe mode:    Sandbox\n\n');
    process.stdout.write('Press Ctrl+C once to stop every process owned by this local lab.\n');

    await new Promise((resolve, reject) => {
      const stopPoll = setInterval(() => {
        if (stopping) {
          clearInterval(stopPoll);
          resolve();
        }
      }, 100);
      for (const managed of managedProcesses) {
        managed.child.once('exit', (code, signal) => {
          if (!stopping) {
            clearInterval(stopPoll);
            reject(
              new Error(
                `${managed.label} stopped unexpectedly (code=${String(code)}, signal=${String(signal)})`,
              ),
            );
          }
        });
      }
    });
  } finally {
    beginStop();
    await Promise.all(managedProcesses.map((managed) => waitForExit(managed)));
    process.removeListener('SIGINT', beginStop);
    process.removeListener('SIGTERM', beginStop);
    process.stdout.write('Local payment lab stopped. DynamoDB Local data was preserved.\n');
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  runLocalLab().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Local lab failed.'}\n`);
    process.exitCode = 1;
  });
}
