import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/http/webhook-signature.js';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const signer = join(projectRoot, 'scripts/cloud/sign-webhook.mjs');
const temporaryDirectories: string[] = [];

describe('cloud webhook signer', () => {
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

  it('reads the secret from a file and emits the application-compatible signature', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-signer-'));
    temporaryDirectories.push(directory);
    const secretFile = join(directory, 'secret.json');
    const bodyFile = join(directory, 'body.json');
    const secret = 'cloud-webhook-test-secret-0123456789';
    const timestamp = '1785139200';
    const body = '{"eventId":"provider-event-signer"}';
    await Promise.all([
      writeFile(secretFile, JSON.stringify({ webhookSecret: secret }), { mode: 0o600 }),
      writeFile(bodyFile, body),
    ]);

    const result = await execFileAsync('node', [signer, secretFile, timestamp, bodyFile], {
      cwd: projectRoot,
    });

    expect(result.stdout.trim()).toBe(signWebhook(secret, timestamp, body));
    expect(result.stdout).not.toContain(secret);
  });

  it('refuses incomplete arguments', async () => {
    await expect(execFileAsync('node', [signer], { cwd: projectRoot })).rejects.toMatchObject({
      code: 2,
    });
  });
});
