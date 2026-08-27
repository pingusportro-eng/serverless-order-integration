import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';

import type { ProcessStripeWebhookDependencies } from '../application/process-stripe-webhook.js';
import type { StripeWebhookRepository } from '../application/stripe-webhook-repository.js';
import {
  handleStripeWebhook,
  type StripeWebhookHttpResponse,
} from '../http/stripe-webhook-handler.js';
import { problemResponse } from '../http/problem-details.js';
import { DynamoDbOrderRepository } from '../infrastructure/dynamodb/dynamodb-order-repository.js';
import { createRuntimeSecretProvider } from '../infrastructure/ssm/runtime-secret-provider.js';
import { SsmSecureParameterLoader } from '../infrastructure/ssm/ssm-secure-parameter-loader.js';
import { createStripePaymentClient } from '../integrations/stripe-payment-client.js';
import { createLogger, type LogSink } from '../observability/logger.js';
import { createRequestId } from '../observability/request-id.js';
import { createRetryableInitializer } from './retryable-initializer.js';

const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';

export interface StripeWebhookLambdaDependencies extends ProcessStripeWebhookDependencies {
  readonly repository: ProcessStripeWebhookDependencies['repository'] & StripeWebhookRepository;
  readonly signingSecret: string;
  readonly signatureToleranceSeconds: number;
  readonly logSink?: LogSink;
}

export type StripeWebhookLambdaHandler = (
  event: APIGatewayProxyEventV2,
  context?: Context,
) => Promise<APIGatewayProxyStructuredResultV2>;

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

function serialize(response: StripeWebhookHttpResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    ...(response.body === undefined ? {} : { body: JSON.stringify(response.body) }),
  };
}

function exceptionName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

export function createStripeWebhookLambdaHandler(
  dependencies: StripeWebhookLambdaDependencies,
): StripeWebhookLambdaHandler {
  return async (event) => {
    const requestId = createRequestId(event.requestContext.requestId);
    const logger = createLogger(
      { requestId, correlationId: requestId },
      {
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.logSink === undefined ? {} : { sink: dependencies.logSink }),
      },
    );
    logger.write('info', 'stripe.webhook.started', { route: event.routeKey });
    try {
      const response = await handleStripeWebhook(dependencies, {
        requestId,
        headers: event.headers,
        rawBody: rawBody(event),
      });
      if (
        response.processing?.outcome === 'reconciliation_required' &&
        response.processing.reconciliationRecorded === true
      ) {
        logger.write('error', 'stripe.webhook.reconciliation_required', {
          operation: 'processStripeWebhook',
          eventId: response.processing.eventId,
          eventType: response.processing.eventType,
          stripePaymentIntentId: response.processing.stripePaymentIntentId,
          ...(response.processing.orderId === undefined
            ? {}
            : { orderId: response.processing.orderId }),
          ...(response.processing.orderVersion === undefined
            ? {}
            : { orderVersion: response.processing.orderVersion }),
          outcome: response.processing.outcome,
          ...(response.processing.reasonCode === undefined
            ? {}
            : { reasonCode: response.processing.reasonCode }),
        });
      }
      logger.write('info', 'stripe.webhook.completed', {
        route: event.routeKey,
        statusCode: response.statusCode,
        ...(response.processing === undefined
          ? {}
          : {
              eventId: response.processing.eventId,
              eventType: response.processing.eventType,
              stripePaymentIntentId: response.processing.stripePaymentIntentId,
              ...(response.processing.orderId === undefined
                ? {}
                : { orderId: response.processing.orderId }),
              ...(response.processing.orderVersion === undefined
                ? {}
                : { orderVersion: response.processing.orderVersion }),
              outcome: response.processing.outcome,
              ...(response.processing.reasonCode === undefined
                ? {}
                : { reasonCode: response.processing.reasonCode }),
            }),
      });
      return serialize(response);
    } catch (error: unknown) {
      logger.write('error', 'stripe.webhook.failed', {
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
            detail: 'The Stripe webhook could not be completed.',
          },
          requestId,
        ),
      );
    }
  };
}

async function createDefaultHandler(): Promise<StripeWebhookLambdaHandler> {
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
  const repository = new DynamoDbOrderRepository(client, requireEnvironment('TABLE_NAME'));
  const secrets = createRuntimeSecretProvider(process.env, secureParameterLoader);
  const [stripeSecretKey, stripeWebhookSecret] = await Promise.all([
    secrets.required('STRIPE_SECRET_KEY'),
    secrets.required('STRIPE_WEBHOOK_SECRET'),
  ]);
  return createStripeWebhookLambdaHandler({
    repository,
    stripeClient: createStripePaymentClient({
      apiKey: stripeSecretKey,
      timeoutMs: positiveIntegerEnvironment('STRIPE_TIMEOUT_MS'),
    }),
    signingSecret: stripeWebhookSecret,
    signatureToleranceSeconds: positiveIntegerEnvironment('STRIPE_WEBHOOK_TOLERANCE_SECONDS'),
  });
}

const secureParameterLoader = new SsmSecureParameterLoader(
  new SSMClient({ region: process.env['AWS_REGION'] ?? 'eu-central-1' }),
);
const getDefaultHandler = createRetryableInitializer(createDefaultHandler);

export const handler: StripeWebhookLambdaHandler = async (event, context) => {
  const defaultHandler = await getDefaultHandler();
  return defaultHandler(event, context);
};
