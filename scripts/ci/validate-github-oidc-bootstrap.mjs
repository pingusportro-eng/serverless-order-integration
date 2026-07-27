import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stdout } from 'node:process';

import { parse } from 'yaml';

const template = parse(await readFile('infrastructure/github-oidc-bootstrap.yaml', 'utf8'));
const workflow = parse(await readFile('.github/workflows/deploy-development.yaml', 'utf8'));
const deploymentScripts = (
  await Promise.all(
    [
      'prepare-development-change-set.sh',
      'execute-development-change-set.sh',
      'smoke-development-stack.sh',
      'destroy-development-stack.sh',
    ].map((name) => readFile(`scripts/ci/${name}`, 'utf8')),
  )
).join('\n');

const resources = template.Resources;
assert.deepEqual(Object.keys(resources).sort(), [
  'CloudFormationExecutionRole',
  'DeploymentArtifactBucket',
  'GitHubActionsOidcProvider',
  'GitHubDeployerRole',
]);

const artifactBucket = resources.DeploymentArtifactBucket;
assert.equal(artifactBucket.Type, 'AWS::S3::Bucket');
assert.equal(
  artifactBucket.Properties.BucketName['Fn::Sub'],
  'serverless-order-integration-artifacts-${AWS::AccountId}-${AWS::Region}',
);
assert.equal(
  Object.hasOwn(artifactBucket.Properties, 'VersioningConfiguration'),
  false,
  'The short-lived artifact bucket must remain non-versioned.',
);
assert.deepEqual(artifactBucket.Properties.PublicAccessBlockConfiguration, {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
});
assert.equal(
  artifactBucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
    .ServerSideEncryptionByDefault.SSEAlgorithm,
  'AES256',
);
assert.deepEqual(artifactBucket.Properties.LifecycleConfiguration.Rules, [
  {
    Id: 'ExpireDevelopmentArtifacts',
    Status: 'Enabled',
    Prefix: 'serverless-order-integration-dev/',
    ExpirationInDays: 1,
    AbortIncompleteMultipartUpload: {
      DaysAfterInitiation: 1,
    },
  },
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

assert.equal(
  JSON.stringify(trust).includes('*'),
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
  's3:CreateBucket',
  's3:DeleteBucket',
  's3:PutBucket',
  's3:*',
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

const deployerArtifactPolicy = deployer.Policies.find(
  (policy) => policy.PolicyName === 'ManageBoundedDeploymentArtifacts',
);
assert.ok(deployerArtifactPolicy);
assert.deepEqual(
  deployerArtifactPolicy.PolicyDocument.Statement.map((statement) => statement.Sid),
  [
    'InspectArtifactBucket',
    'ListOnlyDevelopmentArtifactPrefix',
    'ManageOnlyDevelopmentArtifactObjects',
  ],
);
assert.deepEqual(deployerArtifactPolicy.PolicyDocument.Statement[2].Action, [
  's3:DeleteObject',
  's3:GetObject',
  's3:PutObject',
]);
assert.deepEqual(
  deployerArtifactPolicy.PolicyDocument.Statement[1].Condition.StringLike['s3:prefix'],
  ['serverless-order-integration-dev', 'serverless-order-integration-dev/*'],
);
assert.equal(
  deployerArtifactPolicy.PolicyDocument.Statement[2].Resource['Fn::Sub'],
  '${DeploymentArtifactBucket.Arn}/serverless-order-integration-dev/*',
);

const executionRole = resources.CloudFormationExecutionRole.Properties;
const executionPolicy = JSON.stringify(executionRole.Policies);
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
const executionArtifactPolicy = executionRole.Policies.find(
  (policy) => policy.PolicyName === 'ReadPackagedApplicationCode',
);
assert.deepEqual(executionArtifactPolicy.PolicyDocument.Statement, [
  {
    Sid: 'ReadOnlyDevelopmentArtifacts',
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:GetObjectVersion'],
    Resource: {
      'Fn::Sub': '${DeploymentArtifactBucket.Arn}/serverless-order-integration-dev/*',
    },
  },
]);

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

assert.equal(workflow.name, 'Deploy development');
assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
assert.deepEqual(workflow.permissions, {});
const inputs = workflow.on.workflow_dispatch.inputs;
assert.deepEqual(inputs.operation.options, ['prepare', 'execute', 'destroy']);
assert.equal(inputs.vendor_base_url.required, false);
assert.equal(inputs.change_set_name.required, false);
assert.equal(inputs.confirm_destroy.required, false);
assert.deepEqual(Object.keys(workflow.jobs), ['controlled-operation']);

const job = workflow.jobs['controlled-operation'];
assert.equal(job.environment, 'development');
assert.equal(job['runs-on'], 'ubuntu-24.04');
assert.equal(job['timeout-minutes'], 45);
assert.deepEqual(job.permissions, {
  contents: 'read',
  'id-token': 'write',
});

const serializedWorkflow = JSON.stringify(workflow);
for (const forbiddenValue of [
  'pull_request',
  '"push"',
  'schedule',
  'sam deploy',
  '--resolve-s3',
  'secretsmanager',
]) {
  assert.equal(
    serializedWorkflow.includes(forbiddenValue),
    false,
    `The controlled workflow must not contain ${forbiddenValue}.`,
  );
}

for (const expectedValue of [
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
  'aws-actions/setup-sam@89ddb14d60e682855e3fea4be85b3c56485de310',
  'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c',
  'arn:aws:iam::454921778743:role/serverless-order-integration-github-deployer',
  'secrets.CURSOR_SIGNING_SECRET',
  'secrets.WEBHOOK_SIGNING_SECRET',
  'secrets.VENDOR_AUTH_TOKEN',
  'prepare-development-change-set.sh',
  'execute-development-change-set.sh',
  'destroy-development-stack.sh',
]) {
  assert.equal(
    serializedWorkflow.includes(expectedValue),
    true,
    `The controlled workflow is missing ${expectedValue}.`,
  );
}

for (const expectedControl of [
  "readonly expected_account_id='454921778743'",
  "readonly region='eu-central-1'",
  "readonly stack_name='serverless-order-integration-dev'",
  "readonly artifact_bucket='serverless-order-integration-artifacts-454921778743-eu-central-1'",
  "readonly artifact_prefix='serverless-order-integration-dev/'",
  'maximum_artifact_bytes=$((50 * 1024 * 1024))',
  'sam package',
  'create-change-set',
  'wait change-set-create-complete',
  'execute-change-set',
  'wait stack-delete-complete',
  'CONFIRM_DESTROY:-}" == "$stack_name',
  'AWS HTTP requests made: `2`',
]) {
  assert.equal(
    deploymentScripts.includes(expectedControl),
    true,
    `Deployment scripts are missing control: ${expectedControl}`,
  );
}

for (const forbiddenControl of [
  'sam deploy',
  '--resolve-s3',
  'aws s3 rb',
  'rm -rf',
  'secretsmanager',
]) {
  assert.equal(
    deploymentScripts.includes(forbiddenControl),
    false,
    `Deployment scripts must not contain ${forbiddenControl}.`,
  );
}

stdout.write('GitHub OIDC and controlled deployment invariants are valid.\n');
