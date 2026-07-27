import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const drillScript = join(projectRoot, 'scripts/cloud/sns-subscription-dlq-drill.sh');
const fakeAws = join(projectRoot, 'tests/fixtures/fake-sns-dlq-drill-aws.sh');
const temporaryDirectories: string[] = [];

async function testEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), 'sns-dlq-drill-'));
  temporaryDirectories.push(directory);
  const fakeStateDirectory = join(directory, 'fake-aws');
  const drillStateDirectory = join(directory, 'drill-state');

  await chmod(fakeAws, 0o755);
  return {
    directory,
    fakeStateDirectory,
    drillStateDirectory,
    environment: {
      ...process.env,
      FAKE_AWS_STATE_DIRECTORY: fakeStateDirectory,
      SNS_DLQ_DRILL_AWS_CLI: fakeAws,
      SNS_DLQ_DRILL_POLL_SECONDS: '0',
      SNS_DLQ_DRILL_STATE_DIRECTORY: drillStateDirectory,
      SNS_DLQ_DRILL_TEST_MODE: '1',
    },
  };
}

describe('SNS subscription-DLQ cloud drill harness', () => {
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

  it('refuses to run unless an explicit mode is provided', async () => {
    const fixture = await testEnvironment();

    await expect(
      execFileAsync('bash', [drillScript], {
        cwd: projectRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 2,
    });
    await expect(access(join(fixture.fakeStateDirectory, 'commands.log'))).rejects.toThrow();
  });

  it('simulates the guarded drill, exact marker proof, and cleanup', async () => {
    const fixture = await testEnvironment();

    const result = await execFileAsync('bash', [drillScript, 'run'], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    expect(result.stdout).toContain(
      'SNS subscription-DLQ drill passed: messageId=fake-sns-message-id',
    );
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'temporary-subscription')),
    ).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'temporary-queue-url'))).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'marker-deleted')),
    ).resolves.toBeUndefined();

    const calls = await readFile(join(fixture.drillStateDirectory, 'aws-calls.log'), 'utf8');
    expect(calls.match(/^sns$/gmu)?.length).toBeLessThanOrEqual(10);
    expect(calls.match(/^sqs$/gmu)?.length).toBeLessThanOrEqual(30);

    const commands = await readFile(join(fixture.fakeStateDirectory, 'commands.log'), 'utf8');
    expect(commands.match(/^sns publish /gmu)).toHaveLength(1);
    expect(commands).toContain('sns unsubscribe');
    expect(commands).toContain('sqs delete-message');
    expect(commands).toContain('sqs delete-queue');
  });

  it('recovers an interrupted published marker from persisted state', async () => {
    const fixture = await testEnvironment();
    const marker = 'sns-dlq-drill-interrupted';
    const messageBody = JSON.stringify({
      drill: 'sns-subscription-dlq',
      marker,
    });
    const temporaryQueueName = 'serverless-order-integration-dev-sns-dlq-drill-interrupted';
    const temporaryQueueUrl = `https://sqs.eu-central-1.amazonaws.com/454921778743/${temporaryQueueName}`;
    const temporaryQueueArn = `arn:aws:sqs:eu-central-1:454921778743:${temporaryQueueName}`;
    const topicArn =
      'arn:aws:sns:eu-central-1:454921778743:serverless-order-integration-dev-domain-events';

    await mkdir(fixture.fakeStateDirectory, { recursive: true });
    await mkdir(fixture.drillStateDirectory, { recursive: true });
    await writeFile(
      join(fixture.fakeStateDirectory, 'temporary-queue-url'),
      `${temporaryQueueUrl}\n`,
    );
    await writeFile(
      join(fixture.fakeStateDirectory, 'temporary-queue-arn'),
      `${temporaryQueueArn}\n`,
    );
    await writeFile(join(fixture.fakeStateDirectory, 'temporary-subscription'), '');
    await writeFile(
      join(fixture.fakeStateDirectory, 'temporary-subscription-endpoint'),
      `${temporaryQueueArn}\n`,
    );
    await writeFile(join(fixture.fakeStateDirectory, 'published-body'), `${messageBody}\n`);
    await writeFile(
      join(fixture.drillStateDirectory, 'state.json'),
      JSON.stringify({
        accountId: '454921778743',
        region: 'eu-central-1',
        stackName: 'serverless-order-integration-dev',
        topicArn,
        deliveryQueueUrl:
          'https://sqs.eu-central-1.amazonaws.com/454921778743/serverless-order-integration-dev-delivery',
        subscriptionDlqUrl:
          'https://sqs.eu-central-1.amazonaws.com/454921778743/serverless-order-integration-dev-subscription-dlq',
        subscriptionDlqArn:
          'arn:aws:sqs:eu-central-1:454921778743:serverless-order-integration-dev-subscription-dlq',
        marker,
        messageBody,
        temporaryQueueUrl,
        temporaryQueueArn,
        temporarySubscriptionArn: `${topicArn}:22222222-2222-2222-2222-222222222222`,
        messageId: 'fake-sns-message-id',
        publishAttempted: true,
        receiptHandle: '',
        markerDeleted: false,
      }),
    );

    const result = await execFileAsync('bash', [drillScript, 'cleanup'], {
      cwd: projectRoot,
      env: fixture.environment,
    });

    expect(result.stdout).toContain('SNS subscription-DLQ drill cleanup completed.');
    await expect(access(join(fixture.drillStateDirectory, 'state.json'))).rejects.toThrow();
    await expect(
      access(join(fixture.fakeStateDirectory, 'marker-deleted')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fixture.fakeStateDirectory, 'temporary-subscription')),
    ).rejects.toThrow();
    await expect(access(join(fixture.fakeStateDirectory, 'temporary-queue-url'))).rejects.toThrow();
  });
});
