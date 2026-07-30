import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { parseDeliveryRequestedEvent } from '../../src/events/delivery-requested-event.js';

const fixtureUrl = new URL('../fixtures/domain-events/order-created.v2.json', import.meta.url);

describe('delivery-requested event parser', () => {
  let createdEvent: Record<string, unknown>;

  beforeAll(async () => {
    createdEvent = JSON.parse(await readFile(fixtureUrl, 'utf8')) as Record<string, unknown>;
  });

  it('accepts a created event', () => {
    expect(parseDeliveryRequestedEvent(JSON.stringify(createdEvent))).toMatchObject({
      eventType: 'order.created',
      aggregateVersion: 1,
    });
  });

  it('accepts padded platform request IDs as trace references', () => {
    const event = structuredClone(createdEvent);
    event['correlationId'] = 'BC8AYho8FiAEPYQ==';
    event['causationId'] = 'BC8AYho8FiAEPYQ=';

    expect(parseDeliveryRequestedEvent(JSON.stringify(event))).toMatchObject({
      correlationId: 'BC8AYho8FiAEPYQ==',
      causationId: 'BC8AYho8FiAEPYQ=',
    });
  });

  it('accepts a submission retry request with its required reason', () => {
    const retryEvent = structuredClone(createdEvent);
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

  it('rejects malformed JSON and a non-object envelope', () => {
    expect(() => parseDeliveryRequestedEvent('{')).toThrow('valid JSON');
    expect(() => parseDeliveryRequestedEvent('[]')).toThrow('valid domain-event envelope');
  });

  it('rejects invalid envelope identifiers and unknown fields', () => {
    const invalidId = structuredClone(createdEvent);
    invalidId['aggregateId'] = 'customer-123456789';
    const misplacedPadding = structuredClone(createdEvent);
    misplacedPadding['causationId'] = 'BC8=AYho8FiAEPYQ';
    const unknownField = structuredClone(createdEvent);
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
    const event = structuredClone(createdEvent);
    event['payload'] = { merchantId: 'not-a-merchant' };

    expect(() => parseDeliveryRequestedEvent(JSON.stringify(event))).toThrow(
      'valid delivery payload',
    );
  });

  it('rejects non-actionable events and invalid retry details', () => {
    const submitted = structuredClone(createdEvent);
    submitted['eventType'] = 'order.submitted';
    const retry = structuredClone(createdEvent);
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
