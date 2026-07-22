import {
  changeOrderStatus,
  type ChangeOrderStatusDependencies,
} from '../application/change-order-status.js';
import { OrderNotFoundError, OrderVersionConflictError } from '../application/order-repository.js';
import type { MerchantId } from '../domain/order.js';
import {
  InvalidOrderStatusDetailsError,
  InvalidOrderStatusTransitionError,
} from '../domain/order-status-transition.js';
import { toOrderRepresentation, type OrderRepresentation } from './order-representation.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import { successResponse, type HttpResponse } from './response.js';

const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{8,60}$/;
const ETAG_PATTERN = /^"([1-9][0-9]*)"$/;

export interface ChangeOrderStatusHttpRequest {
  readonly merchantId: MerchantId;
  readonly requestId: string;
  readonly orderId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export type ChangeOrderStatusHttpResponse = HttpResponse<OrderRepresentation | ProblemDetails>;

function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  return entry?.[1];
}

function notFoundResponse(requestId: string): ChangeOrderStatusHttpResponse {
  return problemResponse(
    {
      status: 404,
      code: 'ORDER_NOT_FOUND',
      title: 'Order not found',
      detail: 'The order does not exist or is not visible to this merchant.',
    },
    requestId,
  );
}

export async function handleChangeOrderStatus(
  dependencies: ChangeOrderStatusDependencies,
  request: ChangeOrderStatusHttpRequest,
): Promise<ChangeOrderStatusHttpResponse> {
  if (!ORDER_ID_PATTERN.test(request.orderId)) {
    return notFoundResponse(request.requestId);
  }

  const ifMatch = readHeader(request.headers, 'If-Match');
  if (ifMatch === undefined) {
    return problemResponse(
      {
        status: 428,
        code: 'PRECONDITION_REQUIRED',
        title: 'Precondition required',
        detail: 'If-Match is required for this mutation.',
      },
      request.requestId,
    );
  }

  const etagMatch = ETAG_PATTERN.exec(ifMatch);
  const expectedVersion = etagMatch ? Number(etagMatch[1]) : Number.NaN;
  if (!Number.isSafeInteger(expectedVersion)) {
    return problemResponse(
      {
        status: 400,
        code: 'MALFORMED_REQUEST',
        title: 'Malformed request',
        detail: 'If-Match must be a strong ETag containing a positive integer version.',
      },
      request.requestId,
    );
  }

  try {
    const result = await changeOrderStatus(dependencies, {
      merchantId: request.merchantId,
      orderId: request.orderId,
      expectedVersion,
      body: request.body,
    });
    if (result.outcome === 'invalid') {
      return problemResponse(
        {
          status: 422,
          code: 'VALIDATION_ERROR',
          title: 'Request validation failed',
          detail: 'One or more request values are invalid.',
          errors: result.issues,
        },
        request.requestId,
      );
    }

    return successResponse(200, toOrderRepresentation(result.order), request.requestId, {
      ETag: `"${String(result.order.version)}"`,
    });
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      return notFoundResponse(request.requestId);
    }
    if (error instanceof InvalidOrderStatusTransitionError) {
      return problemResponse(
        {
          status: 409,
          code: 'INVALID_STATUS_TRANSITION',
          title: 'Invalid status transition',
          detail: error.message,
        },
        request.requestId,
      );
    }
    if (error instanceof InvalidOrderStatusDetailsError) {
      return problemResponse(
        {
          status: 422,
          code: 'VALIDATION_ERROR',
          title: 'Request validation failed',
          detail: 'The requested transition is missing required details.',
          errors: [{ pointer: `#/${error.field.replace('.', '/')}`, detail: error.message }],
        },
        request.requestId,
      );
    }
    if (error instanceof OrderVersionConflictError) {
      return problemResponse(
        {
          status: 412,
          code: 'VERSION_MISMATCH',
          title: 'Version mismatch',
          detail: 'The supplied ETag does not match the current order version.',
          headers: { ETag: `"${String(error.actualVersion)}"` },
        },
        request.requestId,
      );
    }
    throw error;
  }
}
