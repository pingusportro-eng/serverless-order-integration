import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const executeScript = join(projectRoot, 'scripts/ci/execute-development-change-set.sh');
const fakeAws = join(projectRoot, 'tests/fixtures/fake-execute-development-aws.sh');
const fakeBash = join(projectRoot, 'tests/fixtures/fake-execute-development-bash.sh');
const sha = '0123456789abcdef0123456789abcdef01234567';
const changeSetName = `github-${sha.slice(0, 12)}-123456789`;
const temporaryDirectories: string[] = [];

async function testEnvironment(stackStatus: string, roleArn?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'execute-development-'));
  temporaryDirectories.push(directory);
  const commandLog = join(directory, 'commands.log');
  const smokeLog = join(directory, 'smoke.log');
  const binDirectory = join(directory, 'bin');

  await mkdir(binDirectory);
  await Promise.all([chmod(fakeAws, 0o755), chmod(fakeBash, 0o755)]);
  await Promise.all([
    symlink(fakeAws, join(binDirectory, 'aws')),
    symlink(fakeBash, join(binDirectory, 'bash')),
  ]);

  return {
    commandLog,
    smokeLog,
    environment: {
      ...process.env,
      CHANGE_SET_NAME: changeSetName,
      FAKE_EXECUTE_COMMAND_LOG: commandLog,
      FAKE_EXECUTE_ROLE_ARN: roleArn,
      FAKE_EXECUTE_SMOKE_LOG: smokeLog,
      FAKE_EXECUTE_STACK_STATUS: stackStatus,
      GITHUB_SHA: sha,
      PATH: `${binDirectory}:${process.env['PATH'] ?? ''}`,
    },
  };
}

describe('execute development change-set guard', () => {
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

  it('executes a commit-bound CREATE change set with the reviewed stack role', async () => {
    const fixture = await testEnvironment('REVIEW_IN_PROGRESS');

    await execFileAsync('/usr/bin/bash', [executeScript], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).toContain('cloudformation execute-change-set');
    expect(commands).toContain('cloudformation wait stack-create-complete');
    expect(commands).not.toContain('cloudformation wait stack-update-complete');
    await expect(readFile(fixture.smokeLog, 'utf8')).resolves.toContain(
      'scripts/ci/smoke-development-stack.sh',
    );
  });

  it('uses the update waiter for a stable deployed stack', async () => {
    const fixture = await testEnvironment('UPDATE_COMPLETE');

    await execFileAsync('/usr/bin/bash', [executeScript], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).toContain('cloudformation execute-change-set');
    expect(commands).toContain('cloudformation wait stack-update-complete');
    expect(commands).not.toContain('cloudformation wait stack-create-complete');
  });

  it('rejects a stack that does not use the reviewed execution role', async () => {
    const fixture = await testEnvironment(
      'REVIEW_IN_PROGRESS',
      'arn:aws:iam::454921778743:role/unreviewed-role',
    );

    try {
      await execFileAsync('/usr/bin/bash', [executeScript], {
        cwd: projectRoot,
        env: fixture.environment,
      });
      expect.unreachable('The execute guard accepted an unreviewed role.');
    } catch (error: unknown) {
      const executionError = error as Error & { code?: number; stderr?: string };
      expect(executionError.code).toBe(1);
      expect(executionError.stderr).toContain(
        'the change set does not use the reviewed CloudFormation execution role',
      );
    }

    const commands = await readFile(fixture.commandLog, 'utf8');
    expect(commands).not.toContain('cloudformation execute-change-set');
  });
});
