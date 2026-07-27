import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { env, stdout } from 'node:process';
import { URL } from 'node:url';

const expectedClaims = {
  aud: 'sts.amazonaws.com',
  environment: 'development',
  event_name: 'workflow_dispatch',
  iss: 'https://token.actions.githubusercontent.com',
  ref: 'refs/heads/master',
  ref_type: 'branch',
  repository: 'pingusportro-eng/serverless-order-integration',
  repository_id: '1313908687',
  repository_owner_id: '309778154',
  repository_visibility: 'public',
  runner_environment: 'github-hosted',
  sub: 'repo:pingusportro-eng@309778154/serverless-order-integration@1313908687:environment:development',
  workflow: 'Deploy development',
  workflow_ref:
    'pingusportro-eng/serverless-order-integration/.github/workflows/deploy-development.yaml@refs/heads/master',
};

const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
assert.ok(requestUrl, 'GitHub did not provide the OIDC request URL.');
assert.ok(requestToken, 'GitHub did not provide the OIDC request token.');

const url = new URL(requestUrl);
url.searchParams.set('audience', expectedClaims.aud);

const response = await globalThis.fetch(url, {
  headers: {
    authorization: `Bearer ${requestToken}`,
  },
  signal: globalThis.AbortSignal.timeout(15_000),
});
assert.equal(response.ok, true, `GitHub OIDC request failed with HTTP ${response.status}.`);

const body = await response.json();
assert.equal(typeof body.value, 'string', 'GitHub OIDC response did not contain a token.');

const tokenParts = body.value.split('.');
assert.equal(tokenParts.length, 3, 'GitHub OIDC response was not a JWT.');
const claims = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8'));

for (const [claim, expected] of Object.entries(expectedClaims)) {
  assert.equal(claims[claim], expected, `Unexpected GitHub OIDC ${claim} claim.`);
}

assert.equal(claims.sha, env.GITHUB_SHA, 'OIDC sha did not match the checked-out commit.');
assert.equal(claims.run_id, env.GITHUB_RUN_ID, 'OIDC run_id did not match this run.');
assert.ok(Number(claims.exp) > Math.floor(Date.now() / 1000), 'GitHub OIDC token was expired.');

const safeClaims = Object.fromEntries(
  [...Object.keys(expectedClaims), 'run_id', 'sha'].map((claim) => [claim, claims[claim]]),
);
stdout.write(`${JSON.stringify(safeClaims, null, 2)}\n`);
