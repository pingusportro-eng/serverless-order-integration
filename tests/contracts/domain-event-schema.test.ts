import { readFile, readdir } from 'node:fs/promises';

import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';

const schemaUrl = new URL('../../docs/specifications/domain-event.schema.json', import.meta.url);
const fixturesUrl = new URL('../fixtures/domain-events/', import.meta.url);

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}

describe('domain event JSON Schema', () => {
  let validate: ValidateFunction;
  let validFixtures: readonly unknown[];

  beforeAll(async () => {
    const schema = (await readJson(schemaUrl)) as AnySchema;
    validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const fixtureNames = (await readdir(fixturesUrl))
      .filter((name) => name.endsWith('.v1.json'))
      .sort();
    validFixtures = await Promise.all(
      fixtureNames.map((name) => readJson(new URL(name, fixturesUrl))),
    );
  });

  it('accepts every representative version 1 fixture', () => {
    expect(validFixtures).toHaveLength(3);

    for (const fixture of validFixtures) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('rejects an event without trace context', () => {
    const event = structuredClone(validFixtures[0]) as Record<string, unknown>;
    delete event['correlationId'];

    expect(validate(event)).toBe(false);
  });

  it('rejects an event type paired with the wrong payload', () => {
    const event = structuredClone(validFixtures[0]) as Record<string, unknown>;
    event['eventType'] = 'order.submitted';

    expect(validate(event)).toBe(false);
  });

  it('rejects unknown fields and unsupported schema versions', () => {
    const eventWithUnknownField = structuredClone(validFixtures[0]) as Record<string, unknown>;
    const payload = eventWithUnknownField['payload'] as Record<string, unknown>;
    payload['dropoffAddress'] = 'must not travel in the event';
    const futureVersion = structuredClone(validFixtures[0]) as Record<string, unknown>;
    futureVersion['schemaVersion'] = 2;

    expect(validate(eventWithUnknownField)).toBe(false);
    expect(validate(futureVersion)).toBe(false);
  });

  it('rejects failure details for the wrong processing stage', () => {
    const fixture = validFixtures.find(
      (candidate) =>
        (candidate as Record<string, unknown>)['eventType'] === 'order.delivery_failed',
    );
    if (fixture === undefined) {
      throw new Error('Expected a delivery-failed fixture.');
    }
    const deliveryFailedEvent = structuredClone(fixture) as Record<string, unknown>;
    const payload = deliveryFailedEvent['payload'] as Record<string, unknown>;
    const failure = payload['failure'] as Record<string, unknown>;
    failure['stage'] = 'SUBMISSION';

    expect(validate(deliveryFailedEvent)).toBe(false);
  });
});
