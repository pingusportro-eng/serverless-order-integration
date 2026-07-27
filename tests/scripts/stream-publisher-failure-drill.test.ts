import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const drillScript = join(projectRoot, 'scripts/cloud/stream-publisher-failure-drill.sh');
const fakeAws = join(projectRoot, 'tests/fixtures/fake-stream-publisher-drill-aws.sh');
const temporaryDirectories: string[] = [];

async function testEnvironment(additionalEnvironment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stream-publisher-drill-'));
  temporaryDirectories.push(directory);
  const fakeStateDirectory = join(directory, 'fake-aws');
  const drillStateDirectory = join(directory, 'drill-state');

  await chmod(fakeAws, 0o755);
  return {
    fakeStateDirectory,
    drillStateDirectory,
    environment: {
      ...process.env,
      FAKE_AWS_STATE_DIRECTORY: fakeStateDirectory,
      FAKE_STREAM_DRILL_EMPTY_FAILURE_RECEIVES: '1',
      FAKE_STREAM_DRILL_EMPTY_LOG_POLLS: '1',
      FAKE_STREAM_DRILL_EMPTY_RECOVERY_RECEIVES: '1',
      STREAM_PUBLISHER_DRILL_AWS_CLI: fakeAws,
      STREAM_PUBLISHER_DRILL_POLL_SECONDS: '0',
      STREAM_PUBLISHER_DRILL_STATE_DIRECTORY: drillStateDirectory,
      STREAM_PUBLISHER_DRILL_TEST_MODE: '1',
      ...additionalEnvironment,
    },
  };
}

describe('stream-publisher failure drill harness', () => {
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
    await expect(access(join(fixture.fakeStateDirectory, 'commands.log'))).rejects.toThrow();
  });

  it('proves poison exhaustion, exact stream correlation, recovery, and cleanup', async () => {
    const fixture = await testEnvironment();

    const result = await execFileAsync('bash', [drillScript, 'run'], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    expect(result.stdout).toContain('Stream-publisher failure drill passed:');
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'item.json'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'temporary-queue-url'))).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'temporary-subscription')),
    ).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'failure-deleted')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fixture.fakeStateDirectory, 'recovery-deleted')),
    ).resolves.toBeUndefined();
    await expect(access(join(fixture.fakeStateDirectory, 'item-deleted'))).resolves.toBeUndefined();

    const calls = await readFile(join(fixture.drillStateDirectory, 'aws-calls.log'), 'utf8');
    expect(calls.match(/^sqs /gmu)?.length).toBeLessThanOrEqual(100);
    expect(calls.match(/^sns /gmu)?.length).toBeLessThanOrEqual(50);
    expect(calls.match(/^dynamodb /gmu)?.length).toBeLessThanOrEqual(20);
    expect(calls.match(/^dynamodbstreams /gmu)?.length).toBeLessThanOrEqual(50);
    expect(calls.match(/^logs /gmu)?.length).toBeLessThanOrEqual(50);
    expect(calls.match(/^lambda /gmu)?.length).toBeLessThanOrEqual(20);

    const commands = await readFile(join(fixture.fakeStateDirectory, 'commands.log'), 'utf8');
    expect(commands.match(/^dynamodb put-item /gmu)).toHaveLength(2);
    expect(commands.match(/^dynamodb delete-item /gmu)).toHaveLength(1);
    expect(commands.match(/^sqs create-queue /gmu)).toHaveLength(1);
    expect(commands.match(/^sns subscribe /gmu)).toHaveLength(1);
    expect(commands).not.toContain('execute-api');
  });

  it('resumes safely after interruption immediately following the poison write', async () => {
    const fixture = await testEnvironment({
      FAKE_STREAM_DRILL_INTERRUPT_AFTER_POISON: '1',
    });

    await expect(
      execFileAsync('bash', [drillScript, 'run'], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toThrow();
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).resolves.toBeUndefined();
    await expect(access(join(fixture.fakeStateDirectory, 'item.json'))).resolves.toBeUndefined();
    await expect(
      access(join(fixture.fakeStateDirectory, 'temporary-queue-url')),
    ).resolves.toBeUndefined();

    const recovery = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    expect(recovery.stdout).toContain('Stream-publisher failure drill cleanup completed.');
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'item.json'))).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'temporary-queue-url'))).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'temporary-subscription')),
    ).rejects.toThrow();
  });
});
