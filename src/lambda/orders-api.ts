import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';

import type { OrderRepository } from '../application/order-repository.js';
import type { PrepareStripePaymentIntentDependencies } from '../application/prepare-stripe-payment-intent.js';
import { asMerchantId, type MerchantId } from '../domain/order.js';
import { handleChangeOrderStatus } from '../http/change-order-status-handler.js';
import { handleCreateOrder } from '../http/create-order-handler.js';
import { handleGetOrder } from '../http/get-order-handler.js';
import { handleListOrders, type ListOrdersQuery } from '../http/list-orders-handler.js';
import { createOrderCursorCodec, type OrderCursorCodec } from '../http/order-cursor.js';
import { handlePrepareStripePaymentIntent } from '../http/prepare-stripe-payment-intent-handler.js';
import { problemResponse } from '../http/problem-details.js';
import type { HttpResponse } from '../http/response.js';
import { DynamoDbOrderRepository } from '../infrastructure/dynamodb/dynamodb-order-repository.js';
import { createLogger, type LogSink } from '../observability/logger.js';
import { createRequestId } from '../observability/request-id.js';

const LOCAL_ACCESS_KEY_ID = 'DUMMYIDEXAMPLE';
const LOCAL_SECRET_ACCESS_KEY = 'DUMMYEXAMPLEKEY';

export interface OrdersApiDependencies {
  readonly repository: OrderRepository;
  readonly cursorCodec: OrderCursorCodec;
  readonly merchantId: MerchantId;
  readonly requireAccessToken: boolean;
  readonly requireOperatorGroup: boolean;
  readonly paymentPreparation?: PrepareStripePaymentIntentDependencies;
  readonly now?: () => Date;
  readonly logSink?: LogSink;
}

export type OrdersApiHandler = (
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

function booleanEnvironment(name: string): boolean {
  const value = requireEnvironment(name);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`The ${name} environment variable must be true or false.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseBody(event: APIGatewayProxyEventV2): unknown {
  const eventBody: unknown = event.body;
  if (eventBody === undefined || eventBody === null || eventBody === '') {
    return undefined;
  }
  if (typeof eventBody !== 'string') {
    throw new TypeError('The API Gateway request body must be a string.');
  }

  const body = event.isBase64Encoded
    ? Buffer.from(eventBody, 'base64').toString('utf8')
    : eventBody;
  return JSON.parse(body) as unknown;
}

function query(event: APIGatewayProxyEventV2): ListOrdersQuery {
  const values = event.queryStringParameters;
  return {
    ...(values?.['limit'] === undefined ? {} : { limit: values['limit'] }),
    ...(values?.['cursor'] === undefined ? {} : { cursor: values['cursor'] }),
    ...(values?.['status'] === undefined ? {} : { status: values['status'] }),
  };
}

function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // API Gateway can expose a simple comma-separated claim instead of JSON.
  }
  const commaSeparated = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return commaSeparated.split(',').map((entry) => entry.trim());
}

function jwtClaims(event: APIGatewayProxyEventV2): Record<string, unknown> | undefined {
  const requestContext: unknown = event.requestContext;
  if (!isRecord(requestContext)) {
    return undefined;
  }
  const authorizer = requestContext['authorizer'];
  if (!isRecord(authorizer) || !isRecord(authorizer['jwt'])) {
    return undefined;
  }
  const claims = authorizer['jwt']['claims'];
  return isRecord(claims) ? claims : undefined;
}

function hasOperatorGroup(event: APIGatewayProxyEventV2): boolean {
  const claims = jwtClaims(event);
  return claims !== undefined && stringList(claims['cognito:groups']).includes('operators');
}

function authorizationFailure(
  dependencies: OrdersApiDependencies,
  event: APIGatewayProxyEventV2,
  requestId: string,
): HttpResponse<unknown> | undefined {
  if (dependencies.requireAccessToken && jwtClaims(event)?.['token_use'] !== 'access') {
    return problemResponse(
      {
        status: 401,
        code: 'UNAUTHORIZED',
        title: 'Unauthorized',
        detail: 'A verified Cognito access token is required for this operation.',
      },
      requestId,
    );
  }

  if (
    !dependencies.requireOperatorGroup ||
    event.routeKey !== 'PATCH /orders/{orderId}/status' ||
    hasOperatorGroup(event)
  ) {
    return undefined;
  }

  return problemResponse(
    {
      status: 403,
      code: 'FORBIDDEN',
      title: 'Forbidden',
      detail: 'Operator group membership is required for this operation.',
    },
    requestId,
  );
}

function serialize(response: HttpResponse<unknown>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.stringify(response.body),
  };
}

function malformedJsonResponse(requestId: string): APIGatewayProxyStructuredResultV2 {
  return serialize(
    problemResponse(
      {
        status: 400,
        code: 'MALFORMED_REQUEST',
        title: 'Malformed request',
        detail: 'The request body must contain valid JSON.',
      },
      requestId,
    ),
  );
}

function routeNotFoundResponse(requestId: string): HttpResponse<unknown> {
  return problemResponse(
    {
      status: 404,
      code: 'MALFORMED_REQUEST',
      title: 'Route not found',
      detail: 'The requested route is not available.',
    },
    requestId,
  );
}

function exceptionName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

async function route(
  dependencies: OrdersApiDependencies,
  event: APIGatewayProxyEventV2,
  requestId: string,
  body: unknown,
): Promise<HttpResponse<unknown>> {
  switch (event.routeKey) {
    case 'POST /orders':
      return handleCreateOrder(dependencies, {
        merchantId: dependencies.merchantId,
        requestId,
        headers: event.headers,
        body,
      });
    case 'GET /orders':
      return handleListOrders(dependencies, {
        merchantId: dependencies.merchantId,
        requestId,
        query: query(event),
      });
    case 'GET /orders/{orderId}':
      return handleGetOrder(dependencies, {
        merchantId: dependencies.merchantId,
        requestId,
        orderId: event.pathParameters?.['orderId'] ?? '',
      });
    case 'POST /orders/{orderId}/payment-intents':
      if (dependencies.paymentPreparation === undefined) {
        return routeNotFoundResponse(requestId);
      }
      return handlePrepareStripePaymentIntent(dependencies.paymentPreparation, {
        merchantId: dependencies.merchantId,
        requestId,
        orderId: event.pathParameters?.['orderId'] ?? '',
        headers: event.headers,
      });
    case 'PATCH /orders/{orderId}/status':
      return handleChangeOrderStatus(dependencies, {
        merchantId: dependencies.merchantId,
        requestId,
        orderId: event.pathParameters?.['orderId'] ?? '',
        headers: event.headers,
        body,
      });
    default:
      return routeNotFoundResponse(requestId);
  }
}

export function createOrdersApiHandler(dependencies: OrdersApiDependencies): OrdersApiHandler {
  return async (event) => {
    const requestId = createRequestId(event.requestContext.requestId);
    const correlationId = header(event.headers, 'X-Correlation-Id') ?? requestId;
    const logger = createLogger(
      {
        requestId,
        correlationId,
      },
      {
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.logSink === undefined ? {} : { sink: dependencies.logSink }),
      },
    );
    logger.write('info', 'http.request.started', {
      route: event.routeKey,
      httpMethod: event.requestContext.http.method,
      merchantId: dependencies.merchantId,
    });

    const authorizationError = authorizationFailure(dependencies, event, requestId);
    if (authorizationError !== undefined) {
      const errorCode = authorizationError.statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
      logger.write('warn', 'http.request.completed', {
        route: event.routeKey,
        statusCode: authorizationError.statusCode,
        errorCode,
      });
      return serialize(authorizationError);
    }

    let body: unknown;
    try {
      body = parseBody(event);
    } catch {
      const response = malformedJsonResponse(requestId);
      logger.write('warn', 'http.request.completed', {
        route: event.routeKey,
        statusCode: response.statusCode ?? 400,
        errorCode: 'MALFORMED_REQUEST',
      });
      return response;
    }

    try {
      const response = await route(dependencies, event, requestId, body);
      logger.write('info', 'http.request.completed', {
        route: event.routeKey,
        statusCode: response.statusCode,
      });
      return serialize(response);
    } catch (error) {
      logger.write('error', 'http.request.failed', {
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
            detail: 'The request could not be completed.',
          },
          requestId,
        ),
      );
    }
  };
}

function createDefaultHandler(): OrdersApiHandler {
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

  return createOrdersApiHandler({
    repository: new DynamoDbOrderRepository(client, requireEnvironment('TABLE_NAME')),
    cursorCodec: createOrderCursorCodec(requireEnvironment('CURSOR_SIGNING_SECRET')),
    merchantId: asMerchantId(requireEnvironment('MERCHANT_ID')),
    requireAccessToken: booleanEnvironment('REQUIRE_ACCESS_TOKEN'),
    requireOperatorGroup: booleanEnvironment('REQUIRE_OPERATOR_GROUP'),
  });
}

let defaultHandler: OrdersApiHandler | undefined;

export const handler: OrdersApiHandler = async (event, context) => {
  defaultHandler ??= createDefaultHandler();
  return defaultHandler(event, context);
};
