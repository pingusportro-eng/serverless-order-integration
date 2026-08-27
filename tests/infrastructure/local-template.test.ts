import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';
import { parse, type ScalarTag } from 'yaml';

interface LocalResource {
  readonly Type: string;
  readonly Properties?: Readonly<Record<string, unknown>>;
}

interface LocalTemplate {
  readonly Resources: Readonly<Record<string, LocalResource>>;
}

const customTags: ScalarTag[] = [
  {
    tag: '!Ref',
    resolve: (value) => ({ Ref: value }),
  },
];

describe('local SAM payment infrastructure', () => {
  let template: LocalTemplate;

  beforeAll(async () => {
    const source = await readFile(new URL('../../template.yaml', import.meta.url), 'utf8');
    template = parse(source, { customTags }) as LocalTemplate;
  });

  it('routes raw Stripe webhooks to a dedicated local Lambda', () => {
    const webhook = template.Resources['StripeWebhookFunction'];
    const events = webhook?.Properties?.['Events'] as
      | Readonly<Record<string, { readonly Properties?: Readonly<Record<string, unknown>> }>>
      | undefined;
    const environment = webhook?.Properties?.['Environment'] as
      { readonly Variables?: Readonly<Record<string, unknown>> } | undefined;

    expect(webhook).toMatchObject({
      Type: 'AWS::Serverless::Function',
      Properties: {
        Handler: 'stripe-webhook.handler',
      },
    });
    expect(events?.['StripeWebhook']?.Properties).toMatchObject({
      Method: 'POST',
      Path: '/webhooks/stripe',
    });
    expect(environment?.Variables).toMatchObject({
      SECRET_PROVIDER: 'environment',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
    });
  });
});
