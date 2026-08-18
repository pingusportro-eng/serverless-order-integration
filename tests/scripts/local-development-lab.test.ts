import { describe, expect, it } from 'vitest';

import {
  STRIPE_EVENT_ALLOWLIST,
  redactStripeOutput,
  stripeListenArguments,
} from '../../scripts/local/development-lab.mjs';
import { readFile } from 'node:fs/promises';

describe('local payment lab', () => {
  it('forwards only the reviewed Stripe PaymentIntent event allowlist', () => {
    const arguments_ = stripeListenArguments();
    const eventIndex = arguments_.indexOf('--events');
    const forwardIndex = arguments_.indexOf('--forward-to');

    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(arguments_[eventIndex + 1]?.split(',')).toEqual(STRIPE_EVENT_ALLOWLIST);
    expect(arguments_[forwardIndex + 1]).toBe('http://127.0.0.1:3000/webhooks/stripe');
    expect(arguments_).not.toContain('--live');
    expect(arguments_.join(' ')).not.toContain('sk_test_');
    expect(arguments_.join(' ')).not.toContain('whsec_');
  });

  it('redacts every Stripe credential type before lab output is printed', () => {
    const output = redactStripeOutput(
      'key=sk_test_example secret=whsec_example client=pi_example_secret_example',
    );

    expect(output).toBe(
      'key=[redacted Stripe API key] secret=[redacted Stripe signing secret] client=[redacted client secret]',
    );
  });

  it('starts the local vendor and relay without exposing AWS services', async () => {
    const source = await readFile('scripts/local/development-lab.mjs', 'utf8');

    expect(source).toContain("['scripts/mock-vendor/start-local.mjs']");
    expect(source).toContain("['scripts/local/delivery-relay.mjs']");
    expect(source).toContain("MOCK_VENDOR_SCENARIO: 'success'");
    expect(source).not.toContain('cloudflared');
  });
});
