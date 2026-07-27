import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const drillScript = join(projectRoot, 'scripts/cloud/vendor-rate-limit-dlq-drill.sh');
const fakeAws = join(projectRoot, 'tests/fixtures/fake-vendor-rate-limit-aws.sh');
const fakeProcess = join(projectRoot, 'tests/fixtures/fake-vendor-rate-limit-process.sh');
const temporaryDirectories: string[] = [];

async function testEnvironment(additionalEnvironment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vendor-rate-limit-drill-'));
  temporaryDirectories.push(directory);
  const fakeStateDirectory = join(directory, 'fake');
  const drillStateDirectory = join(directory, 'drill');

  await Promise.all([chmod(drillScript, 0o755), chmod(fakeAws, 0o755), chmod(fakeProcess, 0o755)]);
  return {
    fakeStateDirectory,
    drillStateDirectory,
    environment: {
      ...process.env,
      FAKE_VENDOR_DRILL_EMPTY_DLQ_RECEIVES: '1',
      FAKE_VENDOR_DRILL_STATE_DIRECTORY: fakeStateDirectory,
      VENDOR_RATE_LIMIT_DRILL_AWS_CLI: fakeAws,
      VENDOR_RATE_LIMIT_DRILL_POLL_SECONDS: '0',
      VENDOR_RATE_LIMIT_DRILL_PROCESS_CLI: fakeProcess,
      VENDOR_RATE_LIMIT_DRILL_STATE_DIRECTORY: drillStateDirectory,
      VENDOR_RATE_LIMIT_DRILL_TEST_MODE: '1',
      ...additionalEnvironment,
    },
  };
}

describe('vendor rate-limit and worker-DLQ drill harness', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it('refuses to run without an explicit mode', async () => {
    const fixture = await testEnvironment();

    await expect(
      execFileAsync('bash', [drillScript], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({ code: 2 });
    await expect(access(join(fixture.fakeStateDirectory, 'aws-commands.log'))).rejects.toThrow();
  });

  it(
    'proves bounded 429 attempts, managed redrive, recovery, and cleanup',
    { timeout: 20_000 },
    async () => {
      const fixture = await testEnvironment({
        FAKE_VENDOR_DRILL_STALE_REDRIVE_COUNT_ONCE: '1',
      });

      const result = await execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      });

      expect(result.stdout).toContain('Vendor rate-limit drill passed:');
      await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
      await expect(
        access(join(fixture.drillStateDirectory, 'vendor-token.json')),
      ).rejects.toThrow();
      await expect(access(join(fixture.fakeStateDirectory, 'order.json'))).rejects.toThrow();
      await expect(
        access(join(fixture.fakeStateDirectory, 'provider-item.json')),
      ).rejects.toThrow();
      await expect(access(join(fixture.fakeStateDirectory, 'vendor-running'))).rejects.toThrow();
      await expect(access(join(fixture.fakeStateDirectory, 'tunnel-running'))).rejects.toThrow();
      await expect(
        access(join(fixture.fakeStateDirectory, 'redrive-completed')),
      ).resolves.toBeUndefined();
      await expect(
        access(join(fixture.fakeStateDirectory, 'data-deleted')),
      ).resolves.toBeUndefined();

      const attempts = (
        await readFile(join(fixture.drillStateDirectory, 'vendor-attempts.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { scenario: string; statusCode: number });
      expect(attempts).toHaveLength(4);
      expect(attempts.filter((attempt) => attempt.statusCode === 429)).toHaveLength(3);
      expect(attempts.filter((attempt) => attempt.statusCode === 201)).toHaveLength(1);

      const calls = await readFile(join(fixture.drillStateDirectory, 'aws-calls.log'), 'utf8');
      for (const service of [
        'budgets',
        'cloudformation',
        'dynamodb',
        'lambda',
        'logs',
        'sqs',
        'sts',
      ]) {
        expect(calls.match(new RegExp(`^${service} `, 'gmu'))?.length ?? 0).toBeLessThanOrEqual(
          200,
        );
      }

      const awsCommands = await readFile(
        join(fixture.fakeStateDirectory, 'aws-commands.log'),
        'utf8',
      );
      expect(awsCommands.match(/^cloudformation create-change-set /gmu)).toHaveLength(1);
      expect(awsCommands.match(/^cloudformation execute-change-set /gmu)).toHaveLength(1);
      expect(awsCommands.match(/^dynamodb put-item /gmu)).toHaveLength(1);
      expect(awsCommands.match(/^dynamodb transact-write-items /gmu)).toHaveLength(1);
      expect(awsCommands.match(/^sqs start-message-move-task /gmu)).toHaveLength(1);
      expect(awsCommands).not.toMatch(/[a-f0-9]{64}/u);
      expect(awsCommands).not.toContain('execute-api');
    },
  );

  it('retains mode-0600 recovery state and resumes after the order write', async () => {
    const fixture = await testEnvironment({
      FAKE_VENDOR_DRILL_INTERRUPT_AFTER_ORDER: '1',
    });

    await expect(
      execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toThrow();

    const statePath = join(fixture.drillStateDirectory, 'state.json');
    const tokenPath = join(fixture.drillStateDirectory, 'vendor-token.json');
    await expect(access(statePath)).resolves.toBeUndefined();
    await expect(access(tokenPath)).resolves.toBeUndefined();
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    await expect(
      access(join(fixture.fakeStateDirectory, 'vendor-running')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fixture.fakeStateDirectory, 'tunnel-running')),
    ).resolves.toBeUndefined();

    const recovery = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: {
        ...fixture.environment,
        FAKE_VENDOR_DRILL_INTERRUPT_AFTER_ORDER: '0',
      },
    });

    expect(recovery.stdout).toContain('Vendor rate-limit drill cleanup completed.');
    await expect(access(statePath)).rejects.toThrow();
    await expect(access(tokenPath)).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'order.json'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'vendor-running'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'tunnel-running'))).rejects.toThrow();
  });

  it('removes an unexecuted change set and stops processes after setup interruption', async () => {
    const fixture = await testEnvironment({
      FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET: '1',
    });

    await expect(
      execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'vendor-running'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'tunnel-running'))).rejects.toThrow();

    const recovery = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: {
        ...fixture.environment,
        FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET: '0',
      },
    });

    expect(recovery.stdout).toContain('Vendor rate-limit drill cleanup completed.');
    await expect(
      access(join(fixture.fakeStateDirectory, 'change-set-deleted')),
    ).resolves.toBeUndefined();
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
  });

  it('reconciles an executed stack update before cleaning an interrupted setup', async () => {
    const fixture = await testEnvironment({
      FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET_EXECUTION: '1',
    });

    await expect(
      execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'stack-updated')),
    ).resolves.toBeUndefined();

    const recovery = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: {
        ...fixture.environment,
        FAKE_VENDOR_DRILL_INTERRUPT_AFTER_CHANGE_SET_EXECUTION: '0',
      },
    });

    expect(recovery.stdout).toContain('Vendor rate-limit drill cleanup completed.');
    await expect(access(join(fixture.fakeStateDirectory, 'change-set-deleted'))).rejects.toThrow();
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
    await expect(access(join(fixture.drillStateDirectory, 'vendor-token.json'))).rejects.toThrow();
  });

  it('reconciles a completed redrive when interrupted before its handle was saved', async () => {
    const fixture = await testEnvironment({
      FAKE_VENDOR_DRILL_INTERRUPT_AFTER_REDRIVE: '1',
    });

    await expect(
      execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'redrive-completed')),
    ).resolves.toBeUndefined();

    const recovery = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: {
        ...fixture.environment,
        FAKE_VENDOR_DRILL_INTERRUPT_AFTER_REDRIVE: '0',
      },
    });

    expect(recovery.stdout).toContain('Vendor rate-limit drill cleanup completed.');
    const awsCommands = await readFile(
      join(fixture.fakeStateDirectory, 'aws-commands.log'),
      'utf8',
    );
    expect(awsCommands.match(/^sqs start-message-move-task /gmu)).toHaveLength(1);
    await expect(access(join(fixture.fakeStateDirectory, 'order.json'))).rejects.toThrow();
  });
});
