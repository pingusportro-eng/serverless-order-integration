import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { verifyStripeWebhook } from '../../src/http/stripe-webhook-verification.js';

const SIGNING_SECRET = 'whsec_stripe_fingerprint_test_secret_123456789';
const TIMESTAMP = 1_786_003_200;

const BASE_EVENT = {
  id: 'evt_canonical_fingerprint_123',
  object: 'event',
  type: 'payment_intent.succeeded',
  account: 'acct_stripe_fingerprint_123',
  api_version: '2026-07-29.dahlia',
  created: TIMESTAMP,
  livemode: false,
  pending_webhooks: 1,
  data: {
    object: {
      id: 'pi_canonical_fingerprint_123',
      object: 'payment_intent',
      amount: 1299,
      currency: 'ron',
      metadata: {
        orderId: 'ord_canonical_fingerprint_123',
        merchantId: 'mrc_demo',
      },
    },
  },
} as const;

function verifiedFingerprint(event: object, formatted = false): string {
  const rawBody = formatted ? JSON.stringify(event, null, 2) : JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: SIGNING_SECRET,
    timestamp: TIMESTAMP,
  });
  return verifyStripeWebhook({
    rawBody,
    signature,
    signingSecret: SIGNING_SECRET,
    toleranceSeconds: 300,
    receivedAtSeconds: TIMESTAMP,
  }).eventFingerprint;
}

describe('Stripe webhook semantic fingerprint', () => {
  it('ignores JSON formatting and property order', () => {
    const reordered = {
      pending_webhooks: BASE_EVENT.pending_webhooks,
      livemode: BASE_EVENT.livemode,
      created: BASE_EVENT.created,
      api_version: BASE_EVENT.api_version,
      account: BASE_EVENT.account,
      type: BASE_EVENT.type,
      object: BASE_EVENT.object,
      id: BASE_EVENT.id,
      data: {
        object: {
          metadata: {
            merchantId: BASE_EVENT.data.object.metadata.merchantId,
            orderId: BASE_EVENT.data.object.metadata.orderId,
          },
          currency: BASE_EVENT.data.object.currency,
          amount: BASE_EVENT.data.object.amount,
          object: BASE_EVENT.data.object.object,
          id: BASE_EVENT.data.object.id,
        },
      },
    };

    expect(verifiedFingerprint(reordered, true)).toBe(verifiedFingerprint(BASE_EVENT));
  });

  it('excludes mutable Stripe delivery bookkeeping', () => {
    expect(verifiedFingerprint({ ...BASE_EVENT, pending_webhooks: 0 })).toBe(
      verifiedFingerprint({ ...BASE_EVENT, pending_webhooks: 7 }),
    );
  });

  it('changes when immutable event identity or data changes', () => {
    const baseline = verifiedFingerprint(BASE_EVENT);
    const changedEvents = [
      { ...BASE_EVENT, id: 'evt_different' },
      { ...BASE_EVENT, type: 'payment_intent.processing' },
      { ...BASE_EVENT, account: 'acct_different' },
      { ...BASE_EVENT, api_version: '2026-08-20.different' },
      { ...BASE_EVENT, created: BASE_EVENT.created + 1 },
      { ...BASE_EVENT, livemode: true },
      {
        ...BASE_EVENT,
        data: {
          ...BASE_EVENT.data,
          object: { ...BASE_EVENT.data.object, amount: BASE_EVENT.data.object.amount + 1 },
        },
      },
    ];

    for (const changedEvent of changedEvents) {
      expect(verifiedFingerprint(changedEvent)).not.toBe(baseline);
    }
  });
});
