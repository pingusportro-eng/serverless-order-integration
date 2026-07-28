import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';

import type { ProviderWebhookRepository } from '../application/provider-webhook-repository.js';
import {
  handleProviderWebhook,
  type ProviderWebhookHttpResponse,
} from '../http/provider-webhook-handler.js';
import { problemResponse } from '../http/problem-details.js';
import { DynamoDbOrderRepository } from '../infrastructure/dynamodb/dynamodb-order-repository.js';
import { createLogger, type LogSink } from '../observability/logger.js';
import { createRequestId } from '../observability/request-id.js';

const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';

export interface VendorWebhookLambdaDependencies {
  readonly repository: ProviderWebhookRepository;
  readonly signingSecret: string;
  readonly signatureToleranceSeconds: number;
  readonly now?: () => Date;
  readonly logSink?: LogSink;
}

export type VendorWebhookLambdaHandler = (
  event: APIGatewayProxyEventV2,
  context?: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

function exceptionName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The ${name} environment variable is required.`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number(requireEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${name} environment variable must be a positive integer.`);
  }
  return value;
}

function rawBody(event: APIGatewayProxyEventV2): string {
  if (event.body === undefined) {
    return '';
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  return entry?.[1];
}

function serialize(response: ProviderWebhookHttpResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    ...(response.body === undefined ? {} : { body: JSON.stringify(response.body) }),
  };
}

export function createVendorWebhookLambdaHandler(
  dependencies: VendorWebhookLambdaDependencies,
): VendorWebhookLambdaHandler {
  return async (event) => {
    const requestId = createRequestId(event.requestContext.requestId);
    const correlationId = header(event.headers, 'X-Correlation-Id') ?? requestId;
    const logger = createLogger(
      { requestId, correlationId },
      {
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.logSink === undefined ? {} : { sink: dependencies.logSink }),
      },
    );
    logger.write('info', 'webhook.request.started', { route: event.routeKey });

    try {
      const response = await handleProviderWebhook(dependencies, {
        requestId,
        headers: event.headers,
        rawBody: rawBody(event),
      });
      logger.write('info', 'webhook.request.completed', {
        route: event.routeKey,
        statusCode: response.statusCode,
        ...(response.processing === undefined
          ? {}
          : {
              eventId: response.processing.eventId,
              eventType: response.processing.eventType,
              orderId: response.processing.orderId,
              orderVersion: response.processing.orderVersion,
              outcome: response.processing.outcome,
            }),
      });
      return serialize(response);
    } catch (error) {
      logger.write('error', 'webhook.request.failed', {
        route: event.routeKey,
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
        exceptionName: exceptionName(error),
      });
      return serialize(
        problemResponse(
          {
            status: 500,
            code: 'INTERNAL_ERROR',
            title: 'Internal error',
            detail: 'The webhook could not be completed.',
          },
          requestId,
        ),
      );
    }
  };
}

function createDefaultHandler(): VendorWebhookLambdaHandler {
  const endpoint = process.env['DYNAMODB_ENDPOINT']?.trim();
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: process.env['AWS_REGION'] ?? 'eu-central-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: LOCAL_ACCESS_KEY_ID,
              secretAccessKey: LOCAL_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  return createVendorWebhookLambdaHandler({
    repository: new DynamoDbOrderRepository(client, requireEnvironment('TABLE_NAME')),
    signingSecret: requireEnvironment('WEBHOOK_SIGNING_SECRET'),
    signatureToleranceSeconds: positiveIntegerEnvironment('WEBHOOK_TOLERANCE_SECONDS'),
  });
}

let defaultHandler: VendorWebhookLambdaHandler | undefined;

export const handler: VendorWebhookLambdaHandler = async (event, context) => {
  defaultHandler ??= createDefaultHandler();
  return defaultHandler(event, context);
};
