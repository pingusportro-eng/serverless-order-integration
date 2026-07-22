import type { OrderListPosition, OrderRepository } from '../application/order-repository.js';
import type { MerchantId } from '../domain/order.js';
import { ORDER_STATUSES, type OrderStatus } from '../domain/order-status.js';
import type { OrderCursorCodec, OrderCursorScope } from './order-cursor.js';
import { toOrderRepresentation, type OrderRepresentation } from './order-representation.js';
import { problemResponse, type ProblemDetails, type ValidationIssue } from './problem-details.js';
import { successResponse, type HttpResponse } from './response.js';

const DEFAULT_PAGE_LIMIT = 25;
const MAXIMUM_PAGE_LIMIT = 100;
const INTEGER_PATTERN = /^\d+$/;

export interface ListOrdersDependencies {
  readonly repository: OrderRepository;
  readonly cursorCodec: OrderCursorCodec;
}

export interface ListOrdersQuery {
  readonly limit?: string;
  readonly cursor?: string;
  readonly status?: string;
}

export interface ListOrdersHttpRequest {
  readonly merchantId: MerchantId;
  readonly requestId: string;
  readonly query: ListOrdersQuery;
}

export interface OrderPageRepresentation {
  readonly items: readonly OrderRepresentation[];
  readonly nextCursor?: string;
}

export type ListOrdersHttpResponse = HttpResponse<OrderPageRepresentation | ProblemDetails>;

function parseLimit(value: string | undefined, issues: ValidationIssue[]): number {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }

  const parsed = Number(value);
  if (
    !INTEGER_PATTERN.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAXIMUM_PAGE_LIMIT
  ) {
    issues.push({ pointer: '#/query/limit', detail: 'must be an integer from 1 through 100' });
  }

  return parsed;
}

function parseStatus(
  value: string | undefined,
  issues: ValidationIssue[],
): OrderStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  const status = ORDER_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    issues.push({ pointer: '#/query/status', detail: 'must be a supported order status' });
  }

  return status;
}

export async function handleListOrders(
  dependencies: ListOrdersDependencies,
  request: ListOrdersHttpRequest,
): Promise<ListOrdersHttpResponse> {
  const issues: ValidationIssue[] = [];
  const limit = parseLimit(request.query.limit, issues);
  const status = parseStatus(request.query.status, issues);
  const scope: OrderCursorScope = {
    merchantId: request.merchantId,
    ...(status === undefined ? {} : { status }),
  };
  let position: OrderListPosition | undefined;
  const statusIsValid = request.query.status === undefined || status !== undefined;

  if (request.query.cursor !== undefined && statusIsValid) {
    try {
      position = dependencies.cursorCodec.decode(request.query.cursor, scope);
    } catch {
      issues.push({
        pointer: '#/query/cursor',
        detail: 'must be a valid cursor for this merchant and status filter',
      });
    }
  }

  if (issues.length > 0) {
    return problemResponse(
      {
        status: 422,
        code: 'VALIDATION_ERROR',
        title: 'Request validation failed',
        detail: 'One or more query values are invalid.',
        errors: issues,
      },
      request.requestId,
    );
  }

  const result = await dependencies.repository.list({
    merchantId: request.merchantId,
    limit,
    ...(status === undefined ? {} : { status }),
    ...(position === undefined ? {} : { position }),
  });
  const nextCursor = result.nextPosition
    ? dependencies.cursorCodec.encode(scope, result.nextPosition)
    : undefined;

  return successResponse(
    200,
    {
      items: result.orders.map(toOrderRepresentation),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    request.requestId,
  );
}
