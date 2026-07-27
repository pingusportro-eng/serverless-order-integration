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

describe('cloud messaging infrastructure', () => {
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
        eventType: ['order.created', 'order.submission_retry_requested'],
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
});
