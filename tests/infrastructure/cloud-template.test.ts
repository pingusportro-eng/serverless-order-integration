import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';
import { parse, type ScalarTag } from 'yaml';

type CloudFormationResource = {
  Type: string;
  DependsOn?: string | string[];
  Properties?: Record<string, unknown>;
};

type CloudFormationTemplate = {
  Resources: Record<string, CloudFormationResource>;
  Outputs: Record<string, Record<string, unknown>>;
};

const customTags: ScalarTag[] = [
  {
    tag: '!Ref',
    resolve: (value) => ({ Ref: value }),
  },
  {
    tag: '!GetAtt',
    resolve: (value) => ({ 'Fn::GetAtt': value.split('.') }),
  },
  {
    tag: '!Sub',
    resolve: (value) => ({ 'Fn::Sub': value }),
  },
];

describe('cloud infrastructure', () => {
  let template: CloudFormationTemplate;

  beforeAll(async () => {
    const source = await readFile(new URL('../../template.cloud.yaml', import.meta.url), 'utf8');
    template = parse(source, { customTags }) as CloudFormationTemplate;
  });

  it('retains terminal SNS subscription delivery failures', () => {
    const queue = template.Resources['DeliverySubscriptionDeadLetterQueue'];
    const subscription = template.Resources['DeliverySubscription'];

    expect(queue).toMatchObject({
      Type: 'AWS::SQS::Queue',
      Properties: {
        MessageRetentionPeriod: { Ref: 'FailureMessageRetentionSeconds' },
        SqsManagedSseEnabled: true,
      },
    });
    expect(subscription).toMatchObject({
      Type: 'AWS::SNS::Subscription',
      DependsOn: ['DeliveryQueuePolicy', 'DeliverySubscriptionDeadLetterQueuePolicy'],
      Properties: {
        RedrivePolicy: {
          deadLetterTargetArn: {
            'Fn::GetAtt': ['DeliverySubscriptionDeadLetterQueue', 'Arn'],
          },
        },
      },
    });
    expect(template.Outputs['DeliverySubscriptionDeadLetterQueueUrl']).toEqual({
      Description: 'SQS queue retaining domain events that SNS could not deliver.',
      Value: { Ref: 'DeliverySubscriptionDeadLetterQueue' },
    });
  });

  it('allows only this account and topic to send subscription failures', () => {
    const policy = template.Resources['DeliverySubscriptionDeadLetterQueuePolicy'];

    expect(policy).toEqual({
      Type: 'AWS::SQS::QueuePolicy',
      Properties: {
        Queues: [{ Ref: 'DeliverySubscriptionDeadLetterQueue' }],
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'AllowDomainEventsTopicFailureDelivery',
              Effect: 'Allow',
              Principal: {
                Service: 'sns.amazonaws.com',
              },
              Action: 'sqs:SendMessage',
              Resource: {
                'Fn::GetAtt': ['DeliverySubscriptionDeadLetterQueue', 'Arn'],
              },
              Condition: {
                ArnEquals: {
                  'aws:SourceArn': { Ref: 'DomainEventsTopic' },
                },
                StringEquals: {
                  'aws:SourceAccount': { Ref: 'AWS::AccountId' },
                },
              },
            },
          ],
        },
      },
    });
  });

  it('routes exactly the two actionable event types to the delivery queue', () => {
    const subscription = template.Resources['DeliverySubscription'];

    expect(subscription?.Properties).toMatchObject({
      TopicArn: { Ref: 'DomainEventsTopic' },
      Protocol: 'sqs',
      Endpoint: { 'Fn::GetAtt': ['DeliveryQueue', 'Arn'] },
      RawMessageDelivery: true,
      FilterPolicyScope: 'MessageAttributes',
      FilterPolicy: {
        eventType: ['order.ready_for_submission', 'order.submission_retry_requested'],
      },
    });
  });

  it('invokes the stream publisher only for inserted or modified order items', () => {
    const publisher = template.Resources['StreamPublisherFunction'];
    const events = publisher?.Properties?.['Events'] as
      Record<string, { Properties?: Record<string, unknown> }> | undefined;

    expect(events?.['OrdersStream']?.Properties?.['FilterCriteria']).toEqual({
      Filters: [
        {
          Pattern:
            '{"eventName":["INSERT","MODIFY"],"dynamodb":{"NewImage":{"entityType":{"S":["ORDER"]}}}}',
        },
      ],
    });
  });

  it('configures a public Cognito client for Authorization Code and PKCE', () => {
    expect(template.Resources['UserPoolDomain']).toEqual({
      Type: 'AWS::Cognito::UserPoolDomain',
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: {
        Domain: {
          'Fn::Sub': 'serverless-order-integration-${AWS::AccountId}-${EnvironmentName}',
        },
        ManagedLoginVersion: 1,
        UserPoolId: { Ref: 'UserPool' },
      },
    });
    expect(template.Resources['UserPoolClient']).toMatchObject({
      Type: 'AWS::Cognito::UserPoolClient',
      Properties: {
        UserPoolId: { Ref: 'UserPool' },
        GenerateSecret: false,
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthScopes: ['openid'],
        CallbackURLs: ['http://127.0.0.1:3002/auth/callback'],
        LogoutURLs: ['http://127.0.0.1:3002/'],
        SupportedIdentityProviders: ['COGNITO'],
      },
    });
    expect(template.Outputs['UserPoolDomainUrl']).toEqual({
      Description: 'Cognito prefix-domain origin used by the browser PKCE flow.',
      Value: {
        'Fn::Sub': 'https://${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com',
      },
    });
  });

  it('selects SSM as the cloud runtime secret provider', () => {
    const ordersApi = template.Resources['OrdersApiFunction'];

    expect(ordersApi?.Properties?.['Environment']).toMatchObject({
      Variables: {
        SECRET_PROVIDER: 'ssm',
        STRIPE_SECRET_KEY_PARAMETER_NAME: {
          'Fn::Sub': '/serverless-order-integration/${EnvironmentName}/stripe/secret-key',
        },
        STRIPE_TIMEOUT_MS: { Ref: 'StripeTimeoutMs' },
      },
    });

    const policies = ordersApi?.Properties?.['Policies'] as
      { Statement?: Record<string, unknown>[] }[] | undefined;
    const stripeParameterAccess = policies?.[0]?.Statement?.find(
      (statement) => statement['Sid'] === 'ReadStripeSecretKeyParameter',
    );

    expect(stripeParameterAccess).toEqual({
      Sid: 'ReadStripeSecretKeyParameter',
      Effect: 'Allow',
      Action: ['ssm:GetParameter'],
      Resource: {
        'Fn::Sub':
          'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/serverless-order-integration/${EnvironmentName}/stripe/secret-key',
      },
    });
    expect(JSON.stringify(stripeParameterAccess)).not.toContain('*');
    expect(template.Outputs['StripeSecretKeyParameterName']).toEqual({
      Description: 'Stable Standard SecureString parameter read by the Orders API.',
      Value: {
        'Fn::Sub': '/serverless-order-integration/${EnvironmentName}/stripe/secret-key',
      },
    });
  });

  it('exposes the authenticated payment route only to the exact local UI origin', () => {
    expect(template.Resources['SynchronousHttpApi']?.Properties).toMatchObject({
      CorsConfiguration: {
        AllowOrigins: ['http://127.0.0.1:3002'],
        AllowHeaders: [
          'Authorization',
          'Content-Type',
          'Idempotency-Key',
          'If-Match',
          'X-Correlation-Id',
        ],
        AllowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
        MaxAge: 600,
      },
      Auth: {
        DefaultAuthorizer: 'CognitoJwtAuthorizer',
      },
    });

    const events = template.Resources['OrdersApiFunction']?.Properties?.['Events'] as Record<
      string,
      { Type?: string; Properties?: Record<string, unknown> }
    >;
    expect(events['PreparePaymentIntent']).toEqual({
      Type: 'HttpApi',
      Properties: {
        ApiId: { Ref: 'SynchronousHttpApi' },
        Method: 'POST',
        Path: '/orders/{orderId}/payment-intents',
        PayloadFormatVersion: '2.0',
      },
    });
  });
});
