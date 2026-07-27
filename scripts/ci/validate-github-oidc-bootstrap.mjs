import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stdout } from 'node:process';

import { parse } from 'yaml';

const template = parse(await readFile('infrastructure/github-oidc-bootstrap.yaml', 'utf8'));

const resources = template.Resources;
assert.deepEqual(Object.keys(resources).sort(), [
  'CloudFormationExecutionRole',
  'GitHubActionsOidcProvider',
  'GitHubDeployerRole',
]);

const deployer = resources.GitHubDeployerRole.Properties;
const trust = deployer.AssumeRolePolicyDocument.Statement;
assert.equal(trust.length, 1);
assert.equal(trust[0].Effect, 'Allow');
assert.equal(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');
assert.deepEqual(Object.keys(trust[0].Condition), ['StringEquals']);

const claims = trust[0].Condition.StringEquals;
assert.deepEqual(claims, {
  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
  'token.actions.githubusercontent.com:sub':
    'repo:pingusportro-eng@309778154/serverless-order-integration@1313908687:environment:development',
  'token.actions.githubusercontent.com:repository': 'pingusportro-eng/serverless-order-integration',
  'token.actions.githubusercontent.com:repository_owner_id': '309778154',
  'token.actions.githubusercontent.com:repository_id': '1313908687',
  'token.actions.githubusercontent.com:environment': 'development',
  'token.actions.githubusercontent.com:ref': 'refs/heads/master',
  'token.actions.githubusercontent.com:workflow': 'Deploy development',
});

const serializedTrust = JSON.stringify(trust);
assert.equal(
  serializedTrust.includes('*'),
  false,
  'The GitHub trust policy must not contain a wildcard.',
);

const deployerPolicy = JSON.stringify(deployer.Policies);
for (const forbiddenAction of [
  'iam:CreateOpenIDConnectProvider',
  'iam:DeleteOpenIDConnectProvider',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePolicy',
  'iam:CreateAccessKey',
  's3:',
]) {
  assert.equal(
    deployerPolicy.includes(forbiddenAction),
    false,
    `The GitHub role must not receive ${forbiddenAction}.`,
  );
}

assert.equal(
  deployerPolicy.includes(
    'arn:${AWS::Partition}:cloudformation:eu-central-1:${AWS::AccountId}:stack/serverless-order-integration-dev/*',
  ),
  true,
);
assert.equal(
  deployerPolicy.includes(
    'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/serverless-order-integration-cloudformation-execution',
  ),
  false,
  'The service role ARN must be resolved with Fn::GetAtt, not reconstructed.',
);

const executionPolicy = JSON.stringify(resources.CloudFormationExecutionRole.Properties.Policies);
for (const protectedName of [
  'serverless-order-integration-github-deployer',
  'serverless-order-integration-cloudformation-execution',
  'oidc-provider/token.actions.githubusercontent.com',
]) {
  assert.equal(
    executionPolicy.includes(protectedName),
    false,
    `The CloudFormation execution policy must not target ${protectedName}.`,
  );
}

const roleStatements = Object.values(resources)
  .filter((resource) => resource.Type === 'AWS::IAM::Role')
  .flatMap((resource) => resource.Properties.Policies)
  .flatMap((policy) => policy.PolicyDocument.Statement);

for (const statement of roleStatements) {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  assert.equal(
    actions.some((action) => action === '*' || action.endsWith(':*')),
    false,
    `${statement.Sid} must not grant a wildcard action.`,
  );
}

const unrestrictedResourceStatements = roleStatements
  .filter((statement) => statement.Resource === '*')
  .map((statement) => statement.Sid)
  .sort();
assert.deepEqual(unrestrictedResourceStatements, [
  'DescribeRegionalLogGroups',
  'ListEventSourceMappings',
  'ManageApplicationEventSourceMappings',
  'ManageApplicationUserPool',
  'ReadTemplateSummary',
]);

for (const statement of roleStatements.filter((candidate) => candidate.Resource === '*')) {
  assert.equal(
    statement.Condition?.StringEquals?.['aws:RequestedRegion'],
    'eu-central-1',
    `${statement.Sid} must be constrained to the reviewed region.`,
  );
}

for (const resource of Object.values(resources).filter(
  (candidate) => candidate.Type === 'AWS::IAM::Role',
)) {
  const aggregatePolicySize = resource.Properties.Policies.reduce(
    (size, policy) => size + JSON.stringify(policy.PolicyDocument).length,
    0,
  );
  assert.ok(
    aggregatePolicySize <= 10_240,
    `${resource.Properties.RoleName} inline policies exceed the IAM quota.`,
  );
}

assert.equal(
  resources.GitHubActionsOidcProvider.Properties.Url,
  'https://token.actions.githubusercontent.com',
);
assert.deepEqual(resources.GitHubActionsOidcProvider.Properties.ClientIdList, [
  'sts.amazonaws.com',
]);

stdout.write('GitHub OIDC bootstrap invariants are valid.\n');
