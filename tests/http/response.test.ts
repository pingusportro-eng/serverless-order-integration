import { describe, expect, it } from 'vitest';

import { problemResponse, successResponse } from '../../src/index.js';

describe('HTTP responses', () => {
  it('creates a typed success response with tracing and JSON headers', () => {
    const response = successResponse(
      201,
      { orderId: 'ord_123', status: 'PENDING_SUBMISSION' },
      'request-123',
      { Location: '/orders/ord_123' },
    );

    expect(response).toEqual({
      statusCode: 201,
      headers: {
        Location: '/orders/ord_123',
        'Content-Type': 'application/json',
        'X-Request-Id': 'request-123',
      },
      body: { orderId: 'ord_123', status: 'PENDING_SUBMISSION' },
    });
  });

  it('creates contract-compatible Problem Details with validation issues', () => {
    const response = problemResponse(
      {
        status: 422,
        code: 'VALIDATION_ERROR',
        title: 'Request validation failed',
        detail: 'One or more request values are invalid.',
        errors: [{ pointer: '#/items/0/quantity', detail: 'must be at least 1' }],
      },
      'request/123',
    );

    expect(response).toEqual({
      statusCode: 422,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Request-Id': 'request/123',
      },
      body: {
        type: 'https://example.invalid/problems/validation-error',
        title: 'Request validation failed',
        status: 422,
        detail: 'One or more request values are invalid.',
        instance: '/problems/request%2F123',
        code: 'VALIDATION_ERROR',
        requestId: 'request/123',
        errors: [{ pointer: '#/items/0/quantity', detail: 'must be at least 1' }],
      },
    });
  });

  it('omits optional Problem Details fields and preserves safe response headers', () => {
    const response = problemResponse(
      {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        title: 'Service unavailable',
        headers: { 'Retry-After': '2' },
      },
      'request-456',
    );

    expect(response.headers['Retry-After']).toBe('2');
    expect(response.body).not.toHaveProperty('detail');
    expect(response.body).not.toHaveProperty('errors');
  });
});
