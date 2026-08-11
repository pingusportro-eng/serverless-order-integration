import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { parseDeliveryRequestedEvent } from '../../src/events/delivery-requested-event.js';

const fixtureUrl = new URL(
  '../fixtures/domain-events/order-ready-for-submission.v2.json',
  import.meta.url,
);

describe('delivery-requested event parser', () => {
  let readyEvent: Record<string, unknown>;

  beforeAll(async () => {
    readyEvent = JSON.parse(await readFile(fixtureUrl, 'utf8')) as Record<string, unknown>;
  });

  it('accepts an order that became ready after verified payment', () => {
    expect(parseDeliveryRequestedEvent(JSON.stringify(readyEvent))).toMatchObject({
      eventType: 'order.ready_for_submission',
      aggregateVersion: 2,
      payload: { previousStatus: 'AWAITING_PAYMENT' },
    });
  });

  it('accepts padded platform request IDs as trace references', () => {
    const event = structuredClone(readyEvent);
    event['correlationId'] = 'BC8AYho8FiAEPYQ==';
    event['causationId'] = 'BC8AYho8FiAEPYQ=';

    expect(parseDeliveryRequestedEvent(JSON.stringify(event))).toMatchObject({
      correlationId: 'BC8AYho8FiAEPYQ==',
      causationId: 'BC8AYho8FiAEPYQ=',
    });
  });

  it('accepts a submission retry request with its required reason', () => {
    const retryEvent = structuredClone(readyEvent);
    retryEvent['eventType'] = 'order.submission_retry_requested';
    retryEvent['aggregateVersion'] = 3;
    retryEvent['payload'] = {
      merchantId: 'mrc_demo',
      previousStatus: 'SUBMISSION_FAILED',
      status: 'PENDING_SUBMISSION',
      deliveryProviderCode: 'mock-delivery',
      deliveryProviderSubmissionKey: 'submission_01JABCDEF0123456789',
      reason: 'Operator approved a controlled retry.',
    };

    expect(parseDeliveryRequestedEvent(JSON.stringify(retryEvent))).toMatchObject({
      eventType: 'order.submission_retry_requested',
      payload: { previousStatus: 'SUBMISSION_FAILED' },
    });
  });

  it('rejects order.created even when its payload claims the order is pending submission', () => {
    const createdEvent = structuredClone(readyEvent);
    createdEvent['eventType'] = 'order.created';
    createdEvent['aggregateVersion'] = 1;
    createdEvent['payload'] = {
      merchantId: 'mrc_demo',
      status: 'PENDING_SUBMISSION',
      deliveryProviderCode: 'mock-delivery',
      deliveryProviderSubmissionKey: 'submission_01JABCDEF0123456789',
    };

    expect(() => parseDeliveryRequestedEvent(JSON.stringify(createdEvent))).toThrow(
      'not actionable',
    );
  });

  it('rejects malformed JSON and a non-object envelope', () => {
    expect(() => parseDeliveryRequestedEvent('{')).toThrow('valid JSON');
    expect(() => parseDeliveryRequestedEvent('[]')).toThrow('valid domain-event envelope');
  });

  it('rejects invalid envelope identifiers and unknown fields', () => {
    const invalidId = structuredClone(readyEvent);
    invalidId['aggregateId'] = 'customer-123456789';
    const misplacedPadding = structuredClone(readyEvent);
    misplacedPadding['causationId'] = 'BC8=AYho8FiAEPYQ';
    const unknownField = structuredClone(readyEvent);
    unknownField['secret'] = 'must not be accepted';

    expect(() => parseDeliveryRequestedEvent(JSON.stringify(invalidId))).toThrow(
      'valid domain-event envelope',
    );
    expect(() => parseDeliveryRequestedEvent(JSON.stringify(misplacedPadding))).toThrow(
      'valid domain-event envelope',
    );
    expect(() => parseDeliveryRequestedEvent(JSON.stringify(unknownField))).toThrow(
      'valid domain-event envelope',
    );
  });

  it('rejects a malformed delivery payload', () => {
    const event = structuredClone(readyEvent);
    event['payload'] = { merchantId: 'not-a-merchant' };

    expect(() => parseDeliveryRequestedEvent(JSON.stringify(event))).toThrow(
      'valid delivery payload',
    );
  });

  it('rejects non-actionable events and invalid retry details', () => {
    const submitted = structuredClone(readyEvent);
    submitted['eventType'] = 'order.submitted';
    const retry = structuredClone(readyEvent);
    retry['eventType'] = 'order.submission_retry_requested';
    retry['payload'] = {
      merchantId: 'mrc_demo',
      previousStatus: 'SUBMISSION_FAILED',
      status: 'PENDING_SUBMISSION',
      deliveryProviderCode: 'mock-delivery',
      deliveryProviderSubmissionKey: 'submission_01JABCDEF0123456789',
      reason: 'x',
    };

    expect(() => parseDeliveryRequestedEvent(JSON.stringify(submitted))).toThrow('not actionable');
    expect(() => parseDeliveryRequestedEvent(JSON.stringify(retry))).toThrow('not actionable');
  });
});
