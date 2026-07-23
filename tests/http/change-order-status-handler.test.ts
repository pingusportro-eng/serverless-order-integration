import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asMerchantId } from '../../src/domain/order.js';
import { handleChangeOrderStatus } from '../../src/http/change-order-status-handler.js';
import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { createOrderFixture } from '../fixtures/order.js';

const now = () => new Date('2026-07-22T10:00:00.000Z');

describe('PATCH /orders/{orderId}/status handler', () => {
  let repository: InMemoryOrderRepository;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
  });

  it('applies a valid transition and returns the new ETag', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'change-status-key-1',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: 'change-status-fingerprint-1',
    });

    const response = await handleChangeOrderStatus(
      { repository, now },
      {
        merchantId: order.merchantId,
        requestId: 'request-change',
        orderId: order.orderId,
        headers: { 'If-Match': '"1"' },
        body: {
          targetStatus: 'SUBMITTED',
          reason: 'Reconciled with the provider.',
          providerOrderId: 'provider-123',
        },
      },
    );

    expect(response).toMatchObject({
      statusCode: 200,
      headers: { ETag: '"2"', 'X-Request-Id': 'request-change' },
      body: {
        status: 'SUBMITTED',
        version: 2,
        provider: { providerOrderId: 'provider-123', acceptedAt: now().toISOString() },
      },
    });
    expect(response.body).not.toHaveProperty('provider.submissionKey');
  });

  it('requires a valid If-Match header', async () => {
    const order = createOrderFixture();
    const request = {
      merchantId: order.merchantId,
      requestId: 'request-precondition',
      orderId: order.orderId,
      body: { targetStatus: 'CANCELLED', reason: 'Operator cancellation.' },
    };

    const missing = await handleChangeOrderStatus({ repository, now }, { ...request, headers: {} });
    const malformed = await handleChangeOrderStatus(
      { repository, now },
      { ...request, headers: { 'if-match': '1' } },
    );

    expect(missing).toMatchObject({ statusCode: 428, body: { code: 'PRECONDITION_REQUIRED' } });
    expect(malformed).toMatchObject({ statusCode: 400, body: { code: 'MALFORMED_REQUEST' } });
  });

  it('rejects a stale version and supplies the current ETag', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'change-status-key-2',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: 'change-status-fingerprint-2',
    });

    const response = await handleChangeOrderStatus(
      { repository, now },
      {
        merchantId: order.merchantId,
        requestId: 'request-stale',
        orderId: order.orderId,
        headers: { 'If-Match': '"2"' },
        body: { targetStatus: 'CANCELLED', reason: 'Operator cancellation.' },
      },
    );

    expect(response).toMatchObject({
      statusCode: 412,
      headers: { ETag: '"1"' },
      body: { code: 'VERSION_MISMATCH' },
    });
  });

  it('rejects an invalid terminal transition without changing the order', async () => {
    const order = createOrderFixture({
      status: 'DELIVERED',
      provider: {
        ...createOrderFixture().provider,
        providerOrderId: 'provider-delivered',
        acceptedAt: '2026-07-22T09:00:00.000Z',
      },
      version: 4,
    });
    await repository.create({
      order,
      idempotencyKey: 'change-status-key-3',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: 'change-status-fingerprint-3',
    });

    const response = await handleChangeOrderStatus(
      { repository, now },
      {
        merchantId: order.merchantId,
        requestId: 'request-terminal',
        orderId: order.orderId,
        headers: { 'If-Match': '"4"' },
        body: { targetStatus: 'CANCELLED', reason: 'Late cancellation.' },
      },
    );

    expect(response).toMatchObject({
      statusCode: 409,
      body: { code: 'INVALID_STATUS_TRANSITION' },
    });
    await expect(repository.get(order.merchantId, order.orderId)).resolves.toEqual(order);
  });

  it('does not write or increment the version for a same-status request', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'change-status-key-4',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: 'change-status-fingerprint-4',
    });
    const saveStatusChange = vi.spyOn(repository, 'saveStatusChange');

    const response = await handleChangeOrderStatus(
      { repository, now },
      {
        merchantId: order.merchantId,
        requestId: 'request-noop',
        orderId: order.orderId,
        headers: { 'If-Match': '"1"' },
        body: { targetStatus: 'PENDING_SUBMISSION', reason: 'Already pending.' },
      },
    );

    expect(response).toMatchObject({
      statusCode: 200,
      headers: { ETag: '"1"' },
      body: { status: 'PENDING_SUBMISSION', version: 1 },
    });
    expect(saveStatusChange).not.toHaveBeenCalled();
  });

  it('returns validation details for invalid bodies and transition details', async () => {
    const order = createOrderFixture();
    await repository.create({
      order,
      idempotencyKey: 'change-status-key-5',
      mutation: {
        kind: 'ORDER_CREATED',
        correlationId: 'corr_test_123',
        causationId: 'request_test_123',
      },
      requestFingerprint: 'change-status-fingerprint-5',
    });
    const request = {
      merchantId: order.merchantId,
      requestId: 'request-validation',
      orderId: order.orderId,
      headers: { 'If-Match': '"1"' },
    };

    const invalidBody = await handleChangeOrderStatus(
      { repository, now },
      { ...request, body: { targetStatus: 'UNKNOWN', reason: 'No.' } },
    );
    const missingProviderId = await handleChangeOrderStatus(
      { repository, now },
      {
        ...request,
        body: { targetStatus: 'SUBMITTED', reason: 'Provider reconciliation.' },
      },
    );

    expect(invalidBody).toMatchObject({
      statusCode: 422,
      body: { code: 'VALIDATION_ERROR' },
    });
    expect(invalidBody.body).toHaveProperty('errors');
    expect(missingProviderId).toMatchObject({
      statusCode: 422,
      body: {
        code: 'VALIDATION_ERROR',
        errors: [{ pointer: '#/providerOrderId' }],
      },
    });
  });

  it('uses the same safe not-found response for malformed and hidden orders', async () => {
    const request = {
      requestId: 'request-not-found',
      headers: { 'If-Match': '"1"' },
      body: { targetStatus: 'CANCELLED', reason: 'Operator cancellation.' },
    };
    const malformed = await handleChangeOrderStatus(
      { repository, now },
      {
        ...request,
        merchantId: asMerchantId('mrc_operator'),
        orderId: 'invalid',
      },
    );
    const unknown = await handleChangeOrderStatus(
      { repository, now },
      {
        ...request,
        merchantId: asMerchantId('mrc_operator'),
        orderId: 'ord_00000000000000000000',
      },
    );

    expect(malformed.statusCode).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
  });
});
