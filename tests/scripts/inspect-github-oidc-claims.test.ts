import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const inspector = join(projectRoot, 'scripts/ci/inspect-github-oidc-claims.mjs');
const requestToken = 'github-test-request-token-do-not-log';
const sha = '0123456789abcdef0123456789abcdef01234567';
const runId = '123456789';

const expectedClaims = {
  aud: 'sts.amazonaws.com',
  environment: 'development',
  event_name: 'workflow_dispatch',
  exp: Math.floor(Date.now() / 1000) + 300,
  iss: 'https://token.actions.githubusercontent.com',
  ref: 'refs/heads/master',
  ref_type: 'branch',
  repository: 'pingusportro-eng/serverless-order-integration',
  repository_id: '1313908687',
  repository_owner_id: '309778154',
  repository_visibility: 'public',
  run_id: runId,
  runner_environment: 'github-hosted',
  sha,
  sub: 'repo:pingusportro-eng@309778154/serverless-order-integration@1313908687:environment:development',
  workflow: 'Deploy development',
  workflow_ref:
    'pingusportro-eng/serverless-order-integration/.github/workflows/deploy-development.yaml@refs/heads/master',
};

function unsignedJwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'test-signature',
  ].join('.');
}

async function inspectClaims(claims: Record<string, unknown>) {
  let requestedUrl: string | undefined;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    requestedUrl = request.url;
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: unsignedJwt(claims) }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('OIDC fixture did not bind to a TCP address.');
  }

  try {
    const result = await execFileAsync('node', [inspector], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/oidc`,
        GITHUB_RUN_ID: runId,
        GITHUB_SHA: sha,
      },
    });
    return { authorization, requestedUrl, result };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

describe('GitHub OIDC claim inspector', () => {
  it('requests the AWS audience and emits only allow-listed claims', async () => {
    const { authorization, requestedUrl, result } = await inspectClaims(expectedClaims);
    const output: unknown = JSON.parse(result.stdout);

    expect(requestedUrl).toBe('/oidc?audience=sts.amazonaws.com');
    expect(authorization).toBe(`Bearer ${requestToken}`);
    expect(output).toMatchObject({
      aud: 'sts.amazonaws.com',
      repository_id: '1313908687',
      run_id: runId,
      sha,
    });
    expect(result.stdout).not.toContain(requestToken);
    expect(result.stdout).not.toContain('test-signature');
  });

  it('rejects an unexpected immutable subject without printing the request token', async () => {
    try {
      await inspectClaims({
        ...expectedClaims,
        sub: 'repo:unexpected/repository:environment:development',
      });
      expect.unreachable('The claim inspector accepted an unexpected subject.');
    } catch (error: unknown) {
      const executionError = error as Error & { code?: number; stderr?: string };
      expect(executionError.code).toBe(1);
      expect(executionError.stderr).not.toContain(requestToken);
    }
  });
});
