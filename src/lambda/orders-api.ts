import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';

import type { OrderRepository } from '../application/order-repository.js';
import { asMerchantId, type MerchantId } from '../domain/order.js';
import { handleChangeOrderStatus } from '../http/change-order-status-handler.js';
import { handleCreateOrder } from '../http/create-order-handler.js';
import { handleGetOrder } from '../http/get-order-handler.js';
import { handleListOrders, type ListOrdersQuery } from '../http/list-orders-handler.js';
import { createOrderCursorCodec, type OrderCursorCodec } from '../http/order-cursor.js';
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
    case 'PATCH /orders/{orderId}/status':
      return handleChangeOrderStatus(dependencies, {
        merchantId: dependencies.merchantId,
        requestId,
        orderId: event.pathParameters?.['orderId'] ?? '',
        headers: event.headers,
        body,
      });
    default:
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
}

export function createOrdersApiHandler(dependencies: OrdersApiDependencies): OrdersApiHandler {
  return async (event) => {
    const requestId = createRequestId(event.requestContext.requestId);
    const correlationId = header(event.headers, 'X-Correlation-Id');
    const logger = createLogger(
      {
        requestId,
        ...(correlationId === undefined ? {} : { correlationId }),
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
    } catch {
      logger.write('error', 'http.request.failed', {
        route: event.routeKey,
        statusCode: 500,
        errorCode: 'INTERNAL_ERROR',
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
  });
}

let defaultHandler: OrdersApiHandler | undefined;

export const handler: OrdersApiHandler = async (event, context) => {
  defaultHandler ??= createDefaultHandler();
  return defaultHandler(event, context);
};
