import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

import type { DomainEvent } from '../events/domain-event.js';
import { domainEventFromOrderStreamRecord } from '../events/order-stream-event.js';
import { createLogger, type LogSink } from '../observability/logger.js';

export interface DomainEventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface StreamPublisherDependencies {
  readonly publisher: DomainEventPublisher;
  readonly logSink?: LogSink;
}

export type StreamPublisherHandler = (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>;

function exceptionName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

function sequenceNumber(record: DynamoDBRecord): string {
  const value = record.dynamodb?.SequenceNumber;
  if (value === undefined || value.length === 0) {
    throw new Error('DynamoDB stream record is missing its sequence number.');
  }
  return value;
}

export function createStreamPublisherHandler(
  dependencies: StreamPublisherDependencies,
): StreamPublisherHandler {
  return async (event) => {
    for (const record of event.Records) {
      const itemIdentifier = sequenceNumber(record);
      let domainEvent: DomainEvent | undefined;
      try {
        domainEvent = domainEventFromOrderStreamRecord(record);
        if (domainEvent !== undefined) {
          await dependencies.publisher.publish(domainEvent);
        }
      } catch (error) {
        const logger = createLogger(
          { requestId: itemIdentifier },
          dependencies.logSink === undefined ? {} : { sink: dependencies.logSink },
        );
        logger.write('error', 'stream.record.failed', {
          operation: domainEvent === undefined ? 'parseOrderStreamRecord' : 'publishDomainEvent',
          ...(domainEvent === undefined
            ? {}
            : {
                eventId: domainEvent.eventId,
                orderId: domainEvent.aggregateId,
              }),
          exceptionName: exceptionName(error),
        });
        return { batchItemFailures: [{ itemIdentifier }] };
      }
    }

    return { batchItemFailures: [] };
  };
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The ${name} environment variable is required.`);
  }
  return value;
}

function createDefaultHandler(): StreamPublisherHandler {
  const topicArn = requireEnvironment('DOMAIN_EVENTS_TOPIC_ARN');
  const client = new SNSClient({ region: process.env['AWS_REGION'] ?? 'eu-central-1' });
  return createStreamPublisherHandler({
    publisher: {
      async publish(event): Promise<void> {
        await client.send(
          new PublishCommand({
            TopicArn: topicArn,
            Message: JSON.stringify(event),
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: event.eventType },
              schemaVersion: { DataType: 'Number', StringValue: String(event.schemaVersion) },
              aggregateId: { DataType: 'String', StringValue: event.aggregateId },
            },
          }),
        );
      },
    },
  });
}

let defaultHandler: StreamPublisherHandler | undefined;

export const handler: StreamPublisherHandler = async (event) => {
  defaultHandler ??= createDefaultHandler();
  return defaultHandler(event);
};
