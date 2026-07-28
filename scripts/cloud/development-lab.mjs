#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { parseEnv } from 'node:util';

import {
  decideOwnedProcess,
  decideStackAction,
  isStableStackStatus,
} from './development-lab-state.mjs';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const accountId = '454921778743';
const region = 'eu-central-1';
const profile = 'pingusportro-admin';
const repository = 'pingusportro-eng/serverless-order-integration';
const workflow = 'deploy-development.yaml';
const branch = 'master';
const stackName = 'serverless-order-integration-dev';
const budgetName = 'My Zero-Spend Budget';
const artifactBucket = 'soi-artifacts-454921778743-eu-central-1';
const artifactPrefix = 'serverless-order-integration-dev/';
const stateDirectory = join(projectRoot, '.aws-sam', 'cloud-lab');
const statePath = join(stateDirectory, 'state.json');
const secretPath = join(stateDirectory, 'secrets.json');
const tokenPath = join(stateDirectory, 'operator-token.txt');
const headerPath = join(stateDirectory, 'operator-headers.txt');
const orderPath = join(stateDirectory, 'order.json');
const responsePath = join(stateDirectory, 'response.json');
const vendorLogPath = join(stateDirectory, 'vendor.log');
const tunnelLogPath = join(stateDirectory, 'cloudflared.log');
const lockPath = join(stateDirectory, 'supervisor.lock');
const maximumHttpRequests = 20;

let shutdownRequested = false;
let lockHandle;

function fail(message) {
  throw new Error(`Development lab: ${message}`);
}

function print(message = '') {
  process.stdout.write(`${message}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function command(
  executable,
  arguments_,
  { cwd = projectRoot, env = process.env, input, visible = false, allowFailure = false } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env,
      stdio: visible ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!visible) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      if (input !== undefined) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || allowFailure) {
        resolve(result);
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit ${String(code)}`;
        reject(new Error(`${executable} ${arguments_.join(' ')} failed: ${detail}`));
      }
    });
  });
}

async function requireCommand(name) {
  const result = await command('bash', ['-lc', `command -v "$1"`, 'require-command', name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    fail(`required command is missing: ${name}`);
  }
}

async function aws(arguments_, options = {}) {
  return await command(
    'aws',
    [...arguments_, '--profile', profile, '--region', region, '--no-cli-pager'],
    options,
  );
}

async function gh(arguments_, options = {}) {
  return await command('gh', [...arguments_, '--repo', repository], options);
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${description} did not return valid JSON`);
  }
}

async function ensureStateDirectory() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
}

async function saveState(state) {
  await ensureStateDirectory();
  const temporary = `${statePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

async function loadState() {
  try {
    const state = parseJson(await readFile(statePath, 'utf8'), 'lab state');
    return typeof state === 'object' && state !== null ? state : {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function processObservation(savedProcess) {
  if (savedProcess === undefined || !Number.isSafeInteger(savedProcess.pid)) {
    return { running: false, commandMatches: false, healthy: false };
  }
  try {
    process.kill(savedProcess.pid, 0);
    const commandLine = readFileSync(
      `/proc/${String(savedProcess.pid)}/cmdline`,
      'utf8',
    ).replaceAll('\0', ' ');
    return {
      running: true,
      commandMatches:
        typeof savedProcess.commandFragment === 'string' &&
        commandLine.includes(savedProcess.commandFragment),
      healthy: true,
    };
  } catch {
    return { running: false, commandMatches: false, healthy: false };
  }
}

async function httpHealth(url) {
  if (typeof url !== 'string') {
    return false;
  }
  const result = await command(
    'curl',
    [
      '--silent',
      '--show-error',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      '--connect-timeout',
      '2',
      '--max-time',
      '5',
      `${url}/`,
    ],
    { allowFailure: true },
  );
  return result.code === 0 && result.stdout === '404';
}

async function quickTunnelHealth(publicUrl) {
  if (typeof publicUrl !== 'string') {
    return { healthy: false, status: 'URL_MISSING' };
  }
  const hostname = new URL(publicUrl).hostname;
  const resolution = await command(
    'dig',
    ['+time=2', '+tries=1', '+short', '@1.1.1.1', hostname, 'A'],
    { allowFailure: true },
  );
  const address = resolution.stdout.trim().split('\n')[0];
  if (resolution.code !== 0 || address === '') {
    return { healthy: false, status: 'DNS_PENDING' };
  }
  const result = await command(
    'curl',
    [
      '--silent',
      '--show-error',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      '--connect-timeout',
      '5',
      '--max-time',
      '10',
      '--resolve',
      `${hostname}:443:${address}`,
      '--request',
      'POST',
      `${publicUrl}/deliveries`,
    ],
    { allowFailure: true },
  );
  return { healthy: result.code === 0 && result.stdout === '401', status: result.stdout || '000' };
}

async function ownedProcessObservation(savedProcess, healthUrl) {
  const observation = processObservation(savedProcess);
  if (!observation.running || !observation.commandMatches) {
    return observation;
  }
  return { ...observation, healthy: await httpHealth(healthUrl) };
}

async function ownedTunnelObservation(savedProcess) {
  const observation = processObservation(savedProcess);
  if (!observation.running || !observation.commandMatches) {
    return observation;
  }
  const health = await quickTunnelHealth(savedProcess.publicUrl);
  return { ...observation, healthy: health.healthy };
}

async function acquireLock() {
  await ensureStateDirectory();
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    const existingText = await readFile(lockPath, 'utf8').catch(() => '');
    const existingPid = Number(existingText.trim());
    if (Number.isSafeInteger(existingPid)) {
      try {
        process.kill(existingPid, 0);
        fail(`another lab supervisor is active as PID ${String(existingPid)}`);
      } catch (processError) {
        if (processError?.code !== 'ESRCH') {
          throw processError;
        }
      }
    }
    await unlink(lockPath);
    lockHandle = await open(lockPath, 'wx', 0o600);
  }
  await lockHandle.writeFile(`${String(process.pid)}\n`);
}

async function releaseLock() {
  await lockHandle?.close();
  lockHandle = undefined;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
}

async function assertIdentityAndBudget() {
  const identity = parseJson(
    (await aws(['sts', 'get-caller-identity', '--output', 'json'])).stdout,
    'AWS identity',
  );
  if (identity.Account !== accountId) {
    fail(`expected AWS account ${accountId}, received ${String(identity.Account)}`);
  }
  const budgetResult = await command('aws', [
    'budgets',
    'describe-budget',
    '--account-id',
    accountId,
    '--budget-name',
    budgetName,
    '--profile',
    profile,
    '--region',
    'us-east-1',
    '--no-cli-pager',
    '--output',
    'json',
  ]);
  const budget = parseJson(budgetResult.stdout, 'AWS Budget').Budget;
  const actual = Number(budget?.CalculatedSpend?.ActualSpend?.Amount);
  const forecast = Number(budget?.CalculatedSpend?.ForecastedSpend?.Amount);
  if (!Number.isFinite(actual) || !Number.isFinite(forecast) || actual >= 1 || forecast >= 1) {
    fail('the one-dollar Budget is absent, invalid, or already at its alert threshold');
  }
  print(
    `Cost guard: ${budgetName} actual $${actual.toFixed(4)}, forecast $${forecast.toFixed(4)}.`,
  );
}

async function assertGitHubAndGit() {
  await command('gh', ['auth', 'status']);
  const remote = (await command('git', ['remote', 'get-url', 'origin'])).stdout;
  if (!remote.includes('pingusportro-eng/serverless-order-integration')) {
    fail(`origin is not the reviewed repository: ${remote}`);
  }
  const currentBranch = (await command('git', ['branch', '--show-current'])).stdout;
  if (currentBranch !== branch) {
    fail(`deployment must run from ${branch}, received ${currentBranch || 'detached HEAD'}`);
  }
  const dirty = (await command('git', ['status', '--porcelain'])).stdout;
  if (dirty !== '') {
    fail('commit the current reviewable change before deploying');
  }
  await command('git', ['fetch', 'origin', branch]);
  const head = (await command('git', ['rev-parse', 'HEAD'])).stdout;
  const remoteHead = (await command('git', ['rev-parse', `origin/${branch}`])).stdout;
  if (head !== remoteHead) {
    fail('local HEAD must exactly match the pushed origin/master commit');
  }
  return head;
}

async function describeStack() {
  const result = await aws(
    ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    if (result.stderr.includes('does not exist')) {
      return undefined;
    }
    fail(`could not inspect the application stack: ${result.stderr}`);
  }
  const stack = parseJson(result.stdout, 'CloudFormation stack').Stacks?.[0];
  if (stack === undefined) {
    fail('CloudFormation returned no application stack');
  }
  const tags = Object.fromEntries((stack.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
  const parameters = Object.fromEntries(
    (stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey, parameter.ParameterValue]),
  );
  const outputs = Object.fromEntries(
    (stack.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]),
  );
  return {
    status: stack.StackStatus,
    gitCommit: tags.GitCommit,
    vendorBaseUrl: parameters.VendorBaseUrl,
    outputs,
  };
}

async function waitForStableStack() {
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    const stack = await describeStack();
    if (
      stack === undefined ||
      isStableStackStatus(stack.status) ||
      stack.status === 'REVIEW_IN_PROGRESS'
    ) {
      return stack;
    }
    if (!stack.status.endsWith('_IN_PROGRESS')) {
      return stack;
    }
    if (attempt === 1 || attempt % 6 === 0) {
      print(`Waiting for existing CloudFormation operation: ${stack.status}`);
    }
    await sleep(5_000);
  }
  fail('existing CloudFormation operation did not settle within 15 minutes');
}

function loadLocalEnvironment() {
  const path = join(projectRoot, '.env.development.local');
  if (!existsSync(path)) {
    fail('.env.development.local is missing');
  }
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    fail(`.env.development.local must use mode 0600, received ${mode.toString(8)}`);
  }
  const values = parseEnv(readFileSync(path, 'utf8'));
  const vendorToken = values.VENDOR_AUTH_TOKEN?.trim();
  if (vendorToken === undefined || vendorToken.length < 32) {
    fail('.env.development.local must contain a VENDOR_AUTH_TOKEN of at least 32 characters');
  }
  return { vendorToken };
}

async function setGitHubEnvironmentSecret(name, value) {
  const result = await command(
    'gh',
    ['secret', 'set', name, '--env', 'development', '--repo', repository],
    { input: `${value}\n`, allowFailure: true },
  );
  if (result.code !== 0) {
    fail(`could not synchronize GitHub environment secret ${name}: ${result.stderr}`);
  }
}

async function loadOrCreateLabSecrets() {
  try {
    const secrets = parseJson(await readFile(secretPath, 'utf8'), 'lab secrets');
    if (
      typeof secrets.webhookSigningSecret === 'string' &&
      secrets.webhookSigningSecret.length >= 32
    ) {
      return secrets;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  const secrets = { webhookSigningSecret: randomBytes(32).toString('hex') };
  await writeFile(secretPath, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  return secrets;
}

function spawnDetached(executable, arguments_, environment, logPath) {
  const descriptor = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(executable, arguments_, {
      cwd: projectRoot,
      env: environment,
      detached: true,
      stdio: ['ignore', descriptor, descriptor],
    });
    if (!Number.isSafeInteger(child.pid)) {
      fail(`could not start ${executable}`);
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(descriptor);
  }
}

async function readAppendedUntil(logPath, offset, pattern, timeoutMs, processId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
    } catch {
      fail(`process ${String(processId)} stopped during startup; see ${logPath}`);
    }
    const content = await readFile(logPath, 'utf8').catch(() => '');
    const appended = content.slice(offset);
    const match = pattern.exec(appended);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    await sleep(250);
  }
  fail(`process ${String(processId)} was not ready within ${String(timeoutMs / 1_000)} seconds`);
}

async function startVendor({ vendorToken, webhookSigningSecret, webhookUrl, port = 0 }) {
  await ensureStateDirectory();
  const offset = existsSync(vendorLogPath) ? statSync(vendorLogPath).size : 0;
  writeFileSync(
    vendorLogPath,
    `${existsSync(vendorLogPath) && offset > 0 ? '\n' : ''}--- vendor start ${new Date().toISOString()} ---\n`,
    { flag: 'a', mode: 0o600 },
  );
  const processId = spawnDetached(
    process.execPath,
    [join(projectRoot, 'scripts', 'mock-vendor', 'start-local.mjs')],
    {
      ...process.env,
      MOCK_VENDOR_PORT: String(port),
      MOCK_VENDOR_SCENARIO: 'success',
      MOCK_VENDOR_TOKEN: vendorToken,
      ...(webhookUrl === undefined
        ? {}
        : {
            MOCK_VENDOR_WEBHOOK_URL: webhookUrl,
            MOCK_VENDOR_WEBHOOK_SECRET: webhookSigningSecret,
          }),
    },
    vendorLogPath,
  );
  const savedProcess = {
    pid: processId,
    commandFragment: 'scripts/mock-vendor/start-local.mjs',
  };
  try {
    const localUrl = await readAppendedUntil(
      vendorLogPath,
      offset,
      /Mock delivery vendor listening at (http:\/\/127[.]0[.]0[.]1:\d+)/,
      30_000,
      processId,
    );
    return { ...savedProcess, localUrl };
  } catch (error) {
    await stopOwnedProcess(savedProcess, 'Failed mock vendor');
    throw error;
  }
}

async function stopOwnedProcess(savedProcess, label) {
  if (savedProcess === undefined) {
    return;
  }
  const observation = processObservation(savedProcess);
  if (!observation.running) {
    print(`${label}: already stopped.`);
    return;
  }
  if (!observation.commandMatches) {
    fail(`refusing to stop ${label}; PID ${String(savedProcess.pid)} belongs to another command`);
  }
  process.kill(-savedProcess.pid, 'SIGTERM');
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await sleep(250);
    try {
      process.kill(savedProcess.pid, 0);
    } catch {
      print(`${label}: stopped.`);
      return;
    }
  }
  process.kill(-savedProcess.pid, 'SIGKILL');
  print(`${label}: required SIGKILL after the bounded graceful wait.`);
}

async function startTunnel(localUrl) {
  const offset = existsSync(tunnelLogPath) ? statSync(tunnelLogPath).size : 0;
  writeFileSync(
    tunnelLogPath,
    `${existsSync(tunnelLogPath) && offset > 0 ? '\n' : ''}--- tunnel start ${new Date().toISOString()} ---\n`,
    { flag: 'a', mode: 0o600 },
  );
  const processId = spawnDetached(
    'cloudflared',
    ['tunnel', '--url', localUrl, '--no-autoupdate'],
    process.env,
    tunnelLogPath,
  );
  const savedProcess = {
    pid: processId,
    commandFragment: 'cloudflared tunnel',
  };
  try {
    const publicUrl = await readAppendedUntil(
      tunnelLogPath,
      offset,
      /(https:\/\/[a-z0-9-]+[.]trycloudflare[.]com)/,
      45_000,
      processId,
    );
    let lastStatus = 'DNS_PENDING';
    for (let attempt = 1; attempt <= 90; attempt += 1) {
      const health = await quickTunnelHealth(publicUrl);
      if (health.healthy) {
        return { ...savedProcess, publicUrl, localUrl };
      }
      lastStatus = health.status;
      await sleep(1_000);
    }
    fail(
      `Quick Tunnel did not expose the authenticated mock vendor within the bounded readiness wait; last status: ${lastStatus}`,
    );
  } catch (error) {
    await stopOwnedProcess(savedProcess, 'Failed Quick Tunnel');
    throw error;
  }
}

async function prepareLocalBoundary(state, localEnvironment, secrets) {
  const vendorDecision = decideOwnedProcess(
    state.vendor,
    await ownedProcessObservation(state.vendor, state.vendor?.localUrl),
  );
  const tunnelDecision = decideOwnedProcess(
    state.tunnel,
    await ownedTunnelObservation(state.tunnel),
  );
  if (vendorDecision.action === 'blocked' || tunnelDecision.action === 'blocked') {
    fail(`${vendorDecision.reason}; ${tunnelDecision.reason}`);
  }
  if (
    vendorDecision.action === 'reuse' &&
    tunnelDecision.action === 'reuse' &&
    state.tunnel?.localUrl === state.vendor?.localUrl
  ) {
    print(`Mock vendor: reusing lab-owned ${state.vendor.localUrl}.`);
    print(`Quick Tunnel: reusing lab-owned ${state.tunnel.publicUrl}.`);
    return state;
  }

  if (tunnelDecision.action !== 'start') {
    await stopOwnedProcess(state.tunnel, 'Quick Tunnel');
  }
  if (vendorDecision.action !== 'start') {
    await stopOwnedProcess(state.vendor, 'Mock vendor');
  }
  const vendor = await startVendor({
    vendorToken: localEnvironment.vendorToken,
    webhookSigningSecret: secrets.webhookSigningSecret,
  });
  print(`Mock vendor: started on automatically selected ${vendor.localUrl}.`);
  print('Any unrelated mock vendor already using port 4000 was left untouched.');
  const vendorState = { ...state, vendor };
  delete vendorState.tunnel;
  await saveState(vendorState);
  const tunnel = await startTunnel(vendor.localUrl);
  print(`Quick Tunnel: ${tunnel.publicUrl}`);
  const updated = { ...vendorState, tunnel };
  await saveState(updated);
  return updated;
}

async function listWorkflowRuns() {
  const result = await gh([
    'run',
    'list',
    '--workflow',
    workflow,
    '--branch',
    branch,
    '--event',
    'workflow_dispatch',
    '--limit',
    '30',
    '--json',
    'databaseId,headSha,status,conclusion,createdAt',
  ]);
  return parseJson(result.stdout, 'GitHub workflow list');
}

async function findActiveWorkflow(head, operation) {
  const runs = await listWorkflowRuns();
  for (const run of runs) {
    if (run.headSha !== head || run.status === 'completed') {
      continue;
    }
    const detail = parseJson(
      (await gh(['run', 'view', String(run.databaseId), '--json', 'jobs'])).stdout,
      'active GitHub workflow',
    );
    if ((detail.jobs ?? []).some((job) => job.name === `${operation} development`)) {
      return run.databaseId;
    }
  }
  return undefined;
}

async function approvePendingDeployment(runId) {
  const path = `repos/${repository}/actions/runs/${String(runId)}/pending_deployments`;
  const pendingResult = await command('gh', ['api', path], { allowFailure: true });
  if (pendingResult.code !== 0) {
    return;
  }
  const pending = parseJson(pendingResult.stdout || '[]', 'pending deployments');
  const environmentIds = pending
    .map((deployment) => deployment.environment?.id)
    .filter(Number.isSafeInteger);
  if (environmentIds.length === 0) {
    return;
  }
  const approval = JSON.stringify({
    environment_ids: environmentIds,
    state: 'approved',
    comment: 'Approved by the reviewed local development-lab supervisor.',
  });
  const result = await command('gh', ['api', '--method', 'POST', path, '--input', '-'], {
    input: approval,
    allowFailure: true,
  });
  if (result.code !== 0 && !result.stderr.includes('already')) {
    fail(`could not approve the GitHub development environment: ${result.stderr}`);
  }
  print(`GitHub environment approval recorded for run ${String(runId)}.`);
}

async function dispatchWorkflow(operation, fields, head) {
  const activeRunId = await findActiveWorkflow(head, operation);
  if (activeRunId !== undefined) {
    print(`GitHub ${operation} run: reusing active ${String(activeRunId)}.`);
    return activeRunId;
  }
  const beforeRuns = await listWorkflowRuns();
  const beforeIds = new Set(beforeRuns.map((run) => run.databaseId));
  const arguments_ = ['workflow', 'run', workflow, '--ref', branch, '-f', `operation=${operation}`];
  for (const [name, value] of Object.entries(fields)) {
    arguments_.push('-f', `${name}=${value}`);
  }
  await gh(arguments_);

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const runs = await listWorkflowRuns();
    const run = runs.find(
      (candidate) => candidate.headSha === head && !beforeIds.has(candidate.databaseId),
    );
    if (run !== undefined) {
      print(`GitHub ${operation} run: ${String(run.databaseId)}`);
      return run.databaseId;
    }
    await sleep(1_000);
  }
  fail(`could not identify the dispatched GitHub ${operation} run`);
}

function workflowProgress(view) {
  return (view.jobs ?? [])
    .map((job) => {
      const current = (job.steps ?? []).find((step) => step.status === 'in_progress');
      return `${job.name}:${job.status}:${current?.name ?? job.conclusion ?? ''}`;
    })
    .join('|');
}

async function waitForWorkflow(runId, operation) {
  let lastProgress = '';
  for (let attempt = 1; attempt <= 600; attempt += 1) {
    await approvePendingDeployment(runId);
    const result = await gh(['run', 'view', String(runId), '--json', 'status,conclusion,jobs,url']);
    const view = parseJson(result.stdout, 'GitHub workflow run');
    const progress = workflowProgress(view);
    if (progress !== lastProgress) {
      print(`[GitHub ${operation}] ${progress || view.status}`);
      lastProgress = progress;
    }
    if (view.status === 'completed') {
      if (view.conclusion !== 'success') {
        fail(`GitHub ${operation} run concluded ${String(view.conclusion)}: ${String(view.url)}`);
      }
      print(`[GitHub ${operation}] success.`);
      return;
    }
    await sleep(3_000);
  }
  fail(`GitHub ${operation} workflow did not complete within 30 minutes`);
}

async function describeChangeSet(name) {
  const result = await aws([
    'cloudformation',
    'describe-change-set',
    '--stack-name',
    stackName,
    '--change-set-name',
    name,
    '--output',
    'json',
  ]);
  return parseJson(result.stdout, 'CloudFormation change set');
}

async function findPreparedChangeSet(head, vendorBaseUrl) {
  const result = await aws(
    ['cloudformation', 'list-change-sets', '--stack-name', stackName, '--output', 'json'],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return undefined;
  }
  const summaries = parseJson(result.stdout, 'CloudFormation change-set list').Summaries ?? [];
  for (const summary of summaries) {
    if (
      summary.Status !== 'CREATE_COMPLETE' ||
      summary.ExecutionStatus !== 'AVAILABLE' ||
      summary.Description !== `GitHub commit ${head}` ||
      typeof summary.ChangeSetName !== 'string' ||
      !summary.ChangeSetName.startsWith(`github-${head.slice(0, 12)}-`)
    ) {
      continue;
    }
    const changeSet = await describeChangeSet(summary.ChangeSetName);
    const parameters = Object.fromEntries(
      (changeSet.Parameters ?? []).map((parameter) => [
        parameter.ParameterKey,
        parameter.ParameterValue,
      ]),
    );
    if (parameters.VendorBaseUrl === vendorBaseUrl) {
      return changeSet;
    }
  }
  return undefined;
}

function printChangeSet(changeSet) {
  print('');
  print(`CloudFormation change set: ${changeSet.ChangeSetName}`);
  print(`Type: ${changeSet.ChangeSetType}`);
  print('Reviewed resource changes:');
  for (const change of changeSet.Changes ?? []) {
    const resource = change.ResourceChange ?? {};
    print(
      `  ${resource.Action ?? 'Unknown'} ${resource.LogicalResourceId ?? 'unknown'} (${resource.ResourceType ?? 'unknown'}) replacement=${resource.Replacement ?? 'n/a'}`,
    );
  }
  print('');
}

async function promptExact(expected) {
  if (shutdownRequested) {
    return false;
  }
  process.stdout.write(`Type ${expected} to execute this exact change set: `);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return await new Promise((resolve) => {
    const onData = (chunk) => {
      cleanup();
      resolve(chunk.trim() === expected);
    };
    const onSignal = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.off('SIGINT', onSignal);
      process.stdin.pause();
    };
    process.stdin.once('data', onData);
    process.once('SIGINT', onSignal);
  });
}

async function deployStack(head, vendorBaseUrl, resume) {
  let stack = await waitForStableStack();
  let changeSet = resume.allowPrepared
    ? await findPreparedChangeSet(head, vendorBaseUrl)
    : undefined;
  if (changeSet !== undefined) {
    print(`Cloud stack discovery: resuming prepared change set ${changeSet.ChangeSetName}.`);
  }
  let decision = decideStackAction(stack, { gitCommit: head, vendorBaseUrl });
  if (decision.action === 'wait') {
    stack = await waitForStableStack();
    decision = decideStackAction(stack, { gitCommit: head, vendorBaseUrl });
  }
  if (changeSet === undefined) {
    print(`Cloud stack discovery: ${decision.reason}.`);
  }
  if (changeSet === undefined && decision.action === 'blocked') {
    fail(`${decision.reason}; verified teardown will run before another deployment is attempted`);
  }
  if (changeSet === undefined && decision.action === 'reuse' && resume.allowDeployed) {
    return stack;
  }
  if (changeSet === undefined && decision.action === 'reuse') {
    decision = {
      action: 'prepare',
      reason: 'the existing stack must receive the current ephemeral lab secret',
    };
    print(`Cloud stack discovery: ${decision.reason}.`);
  }

  if (changeSet === undefined) {
    const prepareRunId = await dispatchWorkflow(
      'prepare',
      { vendor_base_url: vendorBaseUrl },
      head,
    );
    await waitForWorkflow(prepareRunId, 'prepare');
    const changeSetName = `github-${head.slice(0, 12)}-${String(prepareRunId)}`;
    changeSet = await describeChangeSet(changeSetName);
  }
  if (
    changeSet.Status !== 'CREATE_COMPLETE' ||
    changeSet.ExecutionStatus !== 'AVAILABLE' ||
    changeSet.Description !== `GitHub commit ${head}`
  ) {
    fail('the prepared change set is not available and bound to the reviewed commit');
  }
  printChangeSet(changeSet);
  if (!(await promptExact('deploy'))) {
    shutdownRequested = true;
    print('Deployment execution declined; verified teardown will start.');
    return undefined;
  }

  const executeRunId = await dispatchWorkflow(
    'execute',
    { change_set_name: changeSet.ChangeSetName },
    head,
  );
  await waitForWorkflow(executeRunId, 'execute');
  stack = await describeStack();
  if (stack === undefined || !isStableStackStatus(stack.status)) {
    fail('application stack did not reach a stable deployed state');
  }
  return stack;
}

function securePassword() {
  return `Lab-${randomBytes(18).toString('base64url')}!7a`;
}

async function awsJsonInput(service, operation, value, extra = []) {
  const inputPath = join(stateDirectory, `aws-${service}-${operation}.json`);
  await writeFile(inputPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    return await aws([service, operation, '--cli-input-json', `file://${inputPath}`, ...extra]);
  } finally {
    await rm(inputPath, { force: true });
  }
}

async function createOperator(stack, state) {
  const userPoolId = stack.outputs.UserPoolId;
  const clientId = stack.outputs.UserPoolClientId;
  if (typeof userPoolId !== 'string' || typeof clientId !== 'string') {
    fail('Cognito stack outputs are missing');
  }
  const username = `cloud-lab-${Date.now().toString(36)}`;
  const password = securePassword();
  await awsJsonInput('cognito-idp', 'admin-create-user', {
    UserPoolId: userPoolId,
    Username: username,
    TemporaryPassword: password,
    MessageAction: 'SUPPRESS',
  });
  await awsJsonInput('cognito-idp', 'admin-set-user-password', {
    UserPoolId: userPoolId,
    Username: username,
    Password: password,
    Permanent: true,
  });
  await aws([
    'cognito-idp',
    'admin-add-user-to-group',
    '--user-pool-id',
    userPoolId,
    '--username',
    username,
    '--group-name',
    'operators',
  ]);
  const authentication = await awsJsonInput(
    'cognito-idp',
    'initiate-auth',
    {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    },
    ['--output', 'json'],
  );
  const token = parseJson(authentication.stdout, 'Cognito authentication').AuthenticationResult
    ?.AccessToken;
  if (typeof token !== 'string' || token.length < 100) {
    fail('Cognito did not return a usable operator access token');
  }
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(headerPath, `Authorization: Bearer ${token}\nContent-Type: application/json\n`, {
    mode: 0o600,
  });
  await writeFile(
    orderPath,
    `${JSON.stringify(
      {
        merchantOrderReference: 'cookbook-order-001',
        items: [
          {
            itemReference: 'cookbook-item-1',
            description: 'Synthetic cookbook item',
            quantity: 1,
            unitPrice: { amountMinor: 1000, currency: 'RON' },
          },
        ],
        pickup: {
          addressLine: '10 Synthetic Test Street',
          city: 'Bucharest',
          postalCode: '010101',
          countryCode: 'RO',
        },
        dropoff: {
          addressLine: '20 Synthetic Test Avenue',
          city: 'Bucharest',
          postalCode: '020202',
          countryCode: 'RO',
        },
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    ...state,
    operator: { username, userPoolId, clientId },
    apiUrl: stack.outputs.ApiUrl,
    httpRequests: state.httpRequests ?? 0,
  };
}

async function restartVendorWithWebhook(state, localEnvironment, secrets) {
  const localUrl = state.vendor.localUrl;
  const port = new URL(localUrl).port;
  await stopOwnedProcess(state.vendor, 'Bootstrap mock vendor');
  const vendor = await startVendor({
    vendorToken: localEnvironment.vendorToken,
    webhookSigningSecret: secrets.webhookSigningSecret,
    webhookUrl: `${state.apiUrl}/webhooks/vendor`,
    port: Number(port),
  });
  if (vendor.localUrl !== localUrl) {
    fail('the webhook-enabled mock vendor did not reclaim the tunnel target');
  }
  const updated = {
    ...state,
    vendor,
    vendorWebhookUrl: `${state.apiUrl}/webhooks/vendor`,
  };
  await saveState(updated);
  return updated;
}

function printReady(state) {
  const correlation = 'cookbook-lab-001';
  const idempotency = 'cookbook-order-001';
  print('');
  print('AWS LAB READY');
  print('');
  print(`AWS account:        ${accountId}`);
  print(`Region:             ${region}`);
  print(`Stack:              ${stackName}`);
  print(`API:                ${state.apiUrl}`);
  print(`Create order:       POST ${state.apiUrl}/orders`);
  print(`Mock vendor local:  ${state.vendor.localUrl}`);
  print(`Mock vendor public: ${state.tunnel.publicUrl}`);
  print('Mock scenario:      success');
  print('');
  print('From a second terminal, either run:');
  print('  npm run cloud:order:create');
  print('');
  print('Or edit .aws-sam/cloud-lab/order.json and send it yourself:');
  print(
    `  curl --request POST '${state.apiUrl}/orders' --header @.aws-sam/cloud-lab/operator-headers.txt --header 'Idempotency-Key: ${idempotency}' --header 'X-Correlation-Id: ${correlation}' --data-binary @.aws-sam/cloud-lab/order.json`,
  );
  print('');
  print('Live mock-vendor exchanges follow. Press Ctrl+C once for verified AWS teardown.');
}

async function followVendorLog(startOffset) {
  let offset = startOffset;
  while (!shutdownRequested) {
    const content = await readFile(vendorLogPath, 'utf8').catch(() => '');
    if (content.length < offset) {
      offset = 0;
    }
    if (content.length > offset) {
      process.stdout.write(content.slice(offset));
      offset = content.length;
    }
    await sleep(250);
  }
}

async function dispatchDestroy(head) {
  const runId = await dispatchWorkflow('destroy', { confirm_destroy: stackName }, head);
  await waitForWorkflow(runId, 'destroy');
}

async function verifyDestroyed() {
  const stack = await describeStack();
  if (stack !== undefined) {
    fail(`stack remains in ${stack.status} after destroy`);
  }
  const objects = await deploymentArtifacts();
  if (objects.length !== 0) {
    fail(`${String(objects.length)} deployment artifacts remain after destroy`);
  }
}

async function deploymentArtifacts() {
  const objectsResult = await aws([
    's3api',
    'list-objects-v2',
    '--bucket',
    artifactBucket,
    '--prefix',
    artifactPrefix,
    '--output',
    'json',
  ]);
  return parseJson(objectsResult.stdout, 'artifact listing').Contents ?? [];
}

async function destroyCloudAndLocal(state, head) {
  print('');
  print('VERIFIED TEARDOWN STARTED');
  let cloudDestroyed = false;
  try {
    const stack = await describeStack();
    const artifacts = await deploymentArtifacts();
    if (stack === undefined && artifacts.length === 0) {
      print('Cloud application and deployment prefix are already absent.');
    } else {
      await dispatchDestroy(head);
    }
    await verifyDestroyed();
    cloudDestroyed = true;
    await stopOwnedProcess(state.tunnel, 'Quick Tunnel');
    await stopOwnedProcess(state.vendor, 'Mock vendor');
    await Promise.all([
      rm(tokenPath, { force: true }),
      rm(headerPath, { force: true }),
      rm(secretPath, { force: true }),
      rm(responsePath, { force: true }),
    ]);
    const destroyedState = {
      phase: 'destroyed',
      destroyedAt: new Date().toISOString(),
      stackName,
      stackAbsent: true,
      artifactPrefixEmpty: true,
    };
    await saveState(destroyedState);
    print('');
    print('AWS LAB DESTROYED');
    print('');
    print('Application stack:   absent');
    print('Deployment artifacts: empty');
    print('Temporary user:      removed with Cognito pool');
    print('Quick Tunnel:        stopped');
    print('Mock vendor:         stopped');
    print('Retained app cost:   $0 expected');
  } finally {
    if (!cloudDestroyed) {
      print('');
      print('TEARDOWN INCOMPLETE');
      print('Owned local processes and recovery state were preserved.');
      print('Run npm run cloud:destroy when connectivity is restored.');
    }
  }
}

async function deploy() {
  await acquireLock();
  const signal = () => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      print('');
      print('Ctrl+C received. The current operation will settle, then verified teardown will run.');
    } else {
      print('Teardown is already requested; the second interrupt is ignored.');
    }
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);

  let state = await loadState();
  state = { ...state, supervisorPid: process.pid };
  await saveState(state);
  let head;
  let cloudMayExist = false;
  try {
    await Promise.all(
      ['aws', 'cloudflared', 'curl', 'dig', 'gh', 'git', 'node', 'npm'].map(requireCommand),
    );
    await assertIdentityAndBudget();
    head = await assertGitHubAndGit();
    const localEnvironment = loadLocalEnvironment();
    const secrets = await loadOrCreateLabSecrets();
    const webhookSecretDigest = createHash('sha256')
      .update(secrets.webhookSigningSecret)
      .digest('hex');
    await setGitHubEnvironmentSecret('VENDOR_AUTH_TOKEN', localEnvironment.vendorToken);
    await setGitHubEnvironmentSecret('WEBHOOK_SIGNING_SECRET', secrets.webhookSigningSecret);
    await command('npm', ['run', 'build'], { visible: true });

    state = await prepareLocalBoundary(state, localEnvironment, secrets);
    const wasActive = state.phase === 'active';
    const canResume =
      (wasActive || state.phase === 'deploying') &&
      state.gitCommit === head &&
      state.webhookSecretDigest === webhookSecretDigest &&
      state.tunnel?.publicUrl !== undefined;
    state = {
      ...state,
      phase: 'deploying',
      supervisorPid: process.pid,
      gitCommit: head,
      webhookSecretDigest,
      startedAt: new Date().toISOString(),
    };
    await saveState(state);
    cloudMayExist = (await describeStack()) !== undefined;

    const stack = await deployStack(head, state.tunnel.publicUrl, {
      allowDeployed: canResume && wasActive,
      allowPrepared: canResume,
    });
    cloudMayExist = true;
    if (shutdownRequested || stack === undefined) {
      return;
    }
    state = await createOperator(stack, state);
    state = { ...state, phase: 'activating' };
    await saveState(state);
    state = await restartVendorWithWebhook(state, localEnvironment, secrets);
    state = { ...state, phase: 'active' };
    await saveState(state);
    printReady(state);
    const offset = statSync(vendorLogPath).size;
    await followVendorLog(offset);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    shutdownRequested = true;
    state = await loadState();
    cloudMayExist ||= (await describeStack().catch(() => undefined)) !== undefined;
    process.exitCode = 1;
  } finally {
    if (
      head !== undefined &&
      (cloudMayExist || state.tunnel !== undefined || state.vendor !== undefined)
    ) {
      try {
        await destroyCloudAndLocal(state, head);
        process.exitCode = 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    await releaseLock();
  }
}

async function createOrder() {
  const state = await loadState();
  if (state.phase !== 'active' || typeof state.apiUrl !== 'string') {
    fail('the cloud lab is not active; run npm run cloud:deploy first');
  }
  const current = Number(state.httpRequests ?? 0);
  if (!Number.isSafeInteger(current) || current >= maximumHttpRequests) {
    fail(`HTTP request cap of ${String(maximumHttpRequests)} has been reached`);
  }
  if (!existsSync(headerPath) || !existsSync(orderPath)) {
    fail('the secure operator headers or synthetic order file is missing');
  }
  const suffix = Date.now().toString(36);
  const correlationId = `cookbook-lab-${suffix}`;
  const idempotencyKey = `cookbook-order-${suffix}`;
  const requestPath = join(stateDirectory, 'order-request.json');
  const order = parseJson(await readFile(orderPath, 'utf8'), 'synthetic order');
  order.merchantOrderReference = `cookbook-order-${suffix}`;
  await writeFile(requestPath, `${JSON.stringify(order, undefined, 2)}\n`, { mode: 0o600 });
  const result = await command('curl', [
    '--silent',
    '--show-error',
    '--output',
    responsePath,
    '--write-out',
    '%{http_code}',
    '--request',
    'POST',
    `${state.apiUrl}/orders`,
    '--header',
    `@${headerPath}`,
    '--header',
    `Idempotency-Key: ${idempotencyKey}`,
    '--header',
    `X-Correlation-Id: ${correlationId}`,
    '--data-binary',
    `@${requestPath}`,
    '--connect-timeout',
    '5',
    '--max-time',
    '20',
  ]);
  await rm(requestPath, { force: true });
  state.httpRequests = current + 1;
  await saveState(state);
  const body = await readFile(responsePath, 'utf8');
  print(`HTTP ${result.stdout}`);
  try {
    print(JSON.stringify(JSON.parse(body), undefined, 2));
  } catch {
    print(body);
  }
  print(`Correlation ID for the cookbook: ${correlationId}`);
  print(`Idempotency key: ${idempotencyKey}`);
}

async function status() {
  await requireCommand('aws');
  const state = await loadState();
  const stack = await describeStack();
  print(`State: ${String(state.phase ?? 'absent')}`);
  print(`Stack: ${stack === undefined ? 'absent' : stack.status}`);
  for (const [label, savedProcess] of [
    ['Mock vendor', state.vendor],
    ['Quick Tunnel', state.tunnel],
  ]) {
    const observation = processObservation(savedProcess);
    const decision = decideOwnedProcess(savedProcess, observation);
    print(`${label}: ${decision.action} (${decision.reason})`);
  }
  if (typeof state.apiUrl === 'string') {
    print(`API: ${state.apiUrl}`);
  }
}

async function destroy() {
  const state = await loadState();
  if (Number.isSafeInteger(state.supervisorPid) && state.supervisorPid !== process.pid) {
    try {
      const commandLine = readFileSync(
        `/proc/${String(state.supervisorPid)}/cmdline`,
        'utf8',
      ).replaceAll('\0', ' ');
      if (commandLine.includes('development-lab.mjs')) {
        process.kill(state.supervisorPid, 'SIGINT');
        print(`Teardown requested from active supervisor PID ${String(state.supervisorPid)}.`);
        print('Watch the original lab terminal for the verified final status.');
        return;
      }
    } catch {
      // The recorded supervisor is stale; recovery continues below.
    }
  }
  await acquireLock();
  try {
    await Promise.all(['aws', 'git'].map(requireCommand));
    await assertIdentityAndBudget();
    const head = (await command('git', ['rev-parse', 'HEAD'])).stdout;
    await destroyCloudAndLocal(state, head);
  } finally {
    await releaseLock();
  }
}

const operation = process.argv[2];
try {
  switch (operation) {
    case 'deploy':
      await deploy();
      break;
    case 'create-order':
      await createOrder();
      break;
    case 'status':
      await status();
      break;
    case 'destroy':
      await destroy();
      break;
    default:
      print('Usage: development-lab.mjs deploy|create-order|status|destroy');
      process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
