import type { OrderRepository } from '../application/order-repository.js';
import { asOrderId, type MerchantId } from '../domain/order.js';
import { toOrderRepresentation, type OrderRepresentation } from './order-representation.js';
import { problemResponse, type ProblemDetails } from './problem-details.js';
import { successResponse, type HttpResponse } from './response.js';

export interface GetOrderDependencies {
  readonly repository: OrderRepository;
}

export interface GetOrderHttpRequest {
  readonly merchantId: MerchantId;
  readonly requestId: string;
  readonly orderId: string;
}

export type GetOrderHttpResponse = HttpResponse<OrderRepresentation | ProblemDetails>;

const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{8,60}$/;

function notFoundResponse(requestId: string): GetOrderHttpResponse {
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

export async function handleGetOrder(
  dependencies: GetOrderDependencies,
  request: GetOrderHttpRequest,
): Promise<GetOrderHttpResponse> {
  if (!ORDER_ID_PATTERN.test(request.orderId)) {
    return notFoundResponse(request.requestId);
  }

  const order = await dependencies.repository.get(request.merchantId, asOrderId(request.orderId));
  if (!order) {
    return notFoundResponse(request.requestId);
  }

  return successResponse(200, toOrderRepresentation(order), request.requestId, {
    ETag: `"${String(order.version)}"`,
  });
}
