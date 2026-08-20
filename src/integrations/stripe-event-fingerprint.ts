import { createHash } from 'node:crypto';

import type Stripe from 'stripe';

function primitiveJson(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return primitiveJson(value);
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
      .join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${primitiveJson(key)}:${canonicalJson(record[key])}`);
    return `{${properties.join(',')}}`;
  }

  throw new TypeError('A Stripe event contains a value that cannot be serialized as JSON.');
}

export function stripeEventFingerprint(event: Stripe.Event): string {
  const immutableSemanticEnvelope = {
    id: event.id,
    type: event.type,
    account: event.account ?? null,
    api_version: event.api_version ?? null,
    created: event.created,
    livemode: event.livemode,
    data: event.data,
  };

  return createHash('sha256').update(canonicalJson(immutableSemanticEnvelope)).digest('hex');
}
