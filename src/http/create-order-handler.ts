import { createOrder, type CreateOrderDependencies } from '../application/create-order.js';
import {
  IdempotencyConflictError,
  MerchantReferenceConflictError,
  OrderAlreadyExistsError,
} from '../application/order-repository.js';
import type { MerchantId } from '../domain/order.js';
import { toOrderRepresentation, type OrderRepresentation } from './order-representation.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import { successResponse, type HttpResponse } from './response.js';

export interface CreateOrderHttpRequest {
  readonly merchantId: MerchantId;
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export type CreateOrderHttpResponse = HttpResponse<OrderRepresentation | ProblemDetails>;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  expectedName: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([name, value]) => name.toLowerCase() === expectedName.toLowerCase() && value !== undefined,
  );
  return entry?.[1];
}

function conflictResponse(
  requestId: string,
  code: 'IDEMPOTENCY_CONFLICT' | 'MERCHANT_REFERENCE_CONFLICT',
  detail: string,
): CreateOrderHttpResponse {
  return problemResponse(
    {
      status: 409,
      code,
      title: 'Order creation conflict',
      detail,
    },
    requestId,
  );
}

export async function handleCreateOrder(
  dependencies: CreateOrderDependencies,
  request: CreateOrderHttpRequest,
): Promise<CreateOrderHttpResponse> {
  const idempotencyKey = readHeader(request.headers, 'Idempotency-Key');
  if (idempotencyKey === undefined || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return problemResponse(
      {
        status: 400,
        code: 'MALFORMED_REQUEST',
        title: 'Malformed request',
        detail:
          'Idempotency-Key is required and must contain 8 to 128 letters, digits, dots, underscores, colons, or hyphens.',
      },
      request.requestId,
    );
  }

  try {
    const result = await createOrder(dependencies, {
      merchantId: request.merchantId,
      idempotencyKey,
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

    const replayed = result.outcome === 'replayed';
    const order = toOrderRepresentation(result.order);
    return successResponse(replayed ? 200 : 201, order, request.requestId, {
      ...(replayed ? {} : { Location: `/orders/${order.orderId}` }),
      ETag: `"${String(order.version)}"`,
      'Idempotency-Replayed': String(replayed),
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return conflictResponse(request.requestId, 'IDEMPOTENCY_CONFLICT', error.message);
    }

    if (error instanceof MerchantReferenceConflictError) {
      return conflictResponse(request.requestId, 'MERCHANT_REFERENCE_CONFLICT', error.message);
    }

    if (error instanceof OrderAlreadyExistsError) {
      return problemResponse(
        {
          status: 500,
          code: 'INTERNAL_ERROR',
          title: 'Internal error',
          detail: 'The order could not be created safely.',
        },
        request.requestId,
      );
    }

    throw error;
  }
}
