import type { HttpHeaders, HttpResponse } from './response.js';

export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 412 | 422 | 428 | 500 | 502 | 503;

export type ProblemCode =
  | 'MALFORMED_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_WEBHOOK_SIGNATURE'
  | 'ORDER_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MERCHANT_ORDER_ID_CONFLICT'
  | 'INVALID_STATUS_TRANSITION'
  | 'EVENT_ID_CONFLICT'
  | 'VERSION_MISMATCH'
  | 'PRECONDITION_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'PAYMENT_PREPARATION_NOT_ALLOWED'
  | 'PAYMENT_INTENT_CONFLICT'
  | 'PAYMENT_PROVIDER_ERROR'
  | 'PAYMENT_PROVIDER_UNAVAILABLE'
  | 'INVALID_STRIPE_WEBHOOK'
  | 'INTERNAL_ERROR';

export interface ValidationIssue {
  readonly detail: string;
  readonly pointer: string;
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: ProblemStatus;
  readonly detail?: string;
  readonly instance: string;
  readonly code: ProblemCode;
  readonly requestId: string;
  readonly errors?: readonly ValidationIssue[];
}

export interface ProblemInput {
  readonly status: ProblemStatus;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: readonly ValidationIssue[];
  readonly headers?: HttpHeaders;
}

const PROBLEM_TYPE_BASE = 'https://example.invalid/problems';

export function problemResponse(
  problem: ProblemInput,
  requestId: string,
): HttpResponse<ProblemDetails> {
  const body: ProblemDetails = {
    type: `${PROBLEM_TYPE_BASE}/${problem.code.toLowerCase().replaceAll('_', '-')}`,
    title: problem.title,
    status: problem.status,
    instance: `/problems/${encodeURIComponent(requestId)}`,
    code: problem.code,
    requestId,
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    ...(problem.errors === undefined ? {} : { errors: problem.errors }),
  };

  return {
    statusCode: problem.status,
    headers: {
      ...problem.headers,
      'Content-Type': 'application/problem+json',
      'X-Request-Id': requestId,
    },
    body,
  };
}
