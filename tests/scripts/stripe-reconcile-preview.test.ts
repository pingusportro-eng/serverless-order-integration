import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadStripeReconciliationManifest,
  loadStripeReconciliationConfiguration,
  parseStripeReconciliationArguments,
  runStripeReconciliationCli,
} from '../../scripts/stripe/reconcile-preview.mjs';

const temporaryDirectories: string[] = [];

async function temporaryProject(environment: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stripe-reconcile-preview-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, '.env.development.local'), environment, { mode: 0o600 });
  return directory;
}

describe('Stripe reconciliation preview CLI', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('parses bounded time ranges and repeated exact event IDs', () => {
    expect(
      parseStripeReconciliationArguments([
        'preview',
        '--since',
        '2026-08-20T10:00:00Z',
        '--until',
        '2026-08-20T11:00:00Z',
        '--limit',
        '12',
      ]),
    ).toEqual({
      kind: 'preview',
      command: {
        kind: 'time_range',
        since: '2026-08-20T10:00:00Z',
        until: '2026-08-20T11:00:00Z',
        limit: 12,
      },
    });
    expect(
      parseStripeReconciliationArguments([
        'preview',
        '--event-id',
        'evt_one',
        '--event-id',
        'evt_two',
      ]),
    ).toEqual({
      kind: 'preview',
      command: { kind: 'event_ids', eventIds: ['evt_one', 'evt_two'] },
    });
    expect(
      parseStripeReconciliationArguments([
        'execute',
        '--campaign',
        '20260824T071045.974Z-00000000-0000-4000-8000-000000000001',
      ]),
    ).toEqual({
      kind: 'execute',
      campaignId: '20260824T071045.974Z-00000000-0000-4000-8000-000000000001',
    });
  });

  it.each([
    [['preview'], 'requires --since'],
    [['preview', '--since', '2026-08-20T10:00:00Z', '--event-id', 'evt_one'], 'cannot be combined'],
    [['execute', '--campaign', 'unsafe'], 'exact generated campaign ID'],
    [['execute'], 'requires exactly'],
    [['preview', '--since', '2026-08-20T10:00:00Z', '--limit', '1.5'], 'must be an integer'],
  ])('rejects ambiguous or mutating arguments', (arguments_, message) => {
    expect(() => parseStripeReconciliationArguments(arguments_)).toThrow(message);
  });

  it('refuses broad secret-file permissions and a non-local DynamoDB endpoint', async () => {
    const broadProject = await temporaryProject(
      'STRIPE_SECRET_KEY=sk_test_synthetic\nSTRIPE_ACCOUNT_ID=acct_synthetic\n',
    );
    const broadPath = join(broadProject, '.env.development.local');
    await chmod(broadPath, 0o644);
    await expect(
      loadStripeReconciliationConfiguration({ environmentPath: broadPath }),
    ).rejects.toThrow('mode 0600');

    const remoteProject = await temporaryProject(
      [
        'STRIPE_SECRET_KEY=sk_test_synthetic',
        'STRIPE_ACCOUNT_ID=acct_synthetic',
        'DYNAMODB_ENDPOINT=https://dynamodb.eu-central-1.amazonaws.com',
        '',
      ].join('\n'),
    );
    await expect(
      loadStripeReconciliationConfiguration({
        environmentPath: join(remoteProject, '.env.development.local'),
      }),
    ).rejects.toThrow('DynamoDB Local');
  });

  it('writes an atomic mode-0600 safe manifest without touching DynamoDB', async () => {
    const secret = 'sk_test_secret_must_not_escape';
    const projectRoot = await temporaryProject(
      [
        `STRIPE_SECRET_KEY=${secret}`,
        'STRIPE_ACCOUNT_ID=acct_preview123',
        'STRIPE_TIMEOUT_MS=4200',
        'STRIPE_WEBHOOK_SECRET=whsec_must_not_escape',
        '',
      ].join('\n'),
    );
    const previewCampaign = vi.fn().mockResolvedValue({
      stripeAccountId: 'acct_preview123',
      previewedAt: '2026-08-21T09:00:00.000Z',
      selection: {
        kind: 'time_range',
        since: '2026-08-20T09:00:00.000Z',
        until: '2026-08-21T09:00:00.000Z',
        limit: 20,
        hasMore: true,
      },
      entries: [
        {
          eventId: 'evt_owned',
          eventType: 'payment_intent.succeeded',
          eventCreatedAt: '2026-08-20T10:00:00.000Z',
          eventFingerprint: 'a'.repeat(64),
          stripePaymentIntentId: 'pi_owned',
          merchantId: 'mrc_demo',
          orderId: 'ord_owned',
          clientSecret: 'must-not-be-copied',
          rawPayload: 'must-not-be-copied',
        },
      ],
      excluded: [{ eventId: 'evt_foreign', reason: 'APPLICATION_NAMESPACE_MISMATCH' }],
    });
    let printed = '';

    const result = await runStripeReconciliationCli({
      arguments_: ['preview', '--since', '2026-08-20T09:00:00Z'],
      projectRoot,
      previewCampaign,
      output: { write: (value: string) => (printed += value) },
      now: () => new Date('2026-08-21T09:00:00.000Z'),
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });

    expect(previewCampaign).toHaveBeenCalledOnce();
    expect(previewCampaign.mock.calls[0]?.[0]).toMatchObject({
      configuration: {
        apiKey: secret,
        expectedStripeAccountId: 'acct_preview123',
        timeoutMs: 4200,
        dynamoDbEndpoint: 'http://127.0.0.1:8000',
        tableName: 'serverless-order-integration-local',
      },
    });
    expect(result).toBeDefined();
    const manifestPath = result?.manifestPath as string;
    const manifestSource = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      targetStripeAccountId: 'acct_preview123',
      localTable: {
        endpoint: 'http://127.0.0.1:8000',
        tableName: 'serverless-order-integration-local',
      },
      entries: [
        {
          eventId: 'evt_owned',
          stripePaymentIntentId: 'pi_owned',
          merchantId: 'mrc_demo',
          orderId: 'ord_owned',
        },
      ],
    });
    expect(manifest['manifestDigest']).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifestSource).not.toContain(secret);
    expect(manifestSource).not.toContain('whsec_');
    expect(manifestSource).not.toContain('clientSecret');
    expect(manifestSource).not.toContain('rawPayload');
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(projectRoot, '.aws-sam/stripe-reconcile'))).mode & 0o777).toBe(0o700);
    expect(printed).toContain('INCLUDE 2026-08-20T10:00:00.000Z evt_owned');
    expect(printed).toContain('EXCLUDE evt_foreign APPLICATION_NAMESPACE_MISMATCH');
    expect(printed).toContain('more matching events');
    expect(printed).toContain('No DynamoDB item was read or changed.');
  });

  it('loads and executes only the exact unchanged mode-0600 campaign', async () => {
    const projectRoot = await temporaryProject(
      ['STRIPE_SECRET_KEY=sk_test_synthetic', 'STRIPE_ACCOUNT_ID=acct_preview123', ''].join('\n'),
    );
    const previewCampaign = vi.fn().mockResolvedValue({
      stripeAccountId: 'acct_preview123',
      previewedAt: '2026-08-24T07:10:00.000Z',
      selection: { kind: 'event_ids', eventIds: ['evt_owned'] },
      entries: [
        {
          eventId: 'evt_owned',
          eventType: 'payment_intent.succeeded',
          eventCreatedAt: '2026-08-24T07:09:00.000Z',
          eventFingerprint: 'a'.repeat(64),
          stripePaymentIntentId: 'pi_owned',
          merchantId: 'mrc_demo',
          orderId: 'ord_owned',
        },
      ],
      excluded: [],
    });
    const campaignId = '20260824T071000Z-00000000-0000-4000-8000-000000000002';
    const previewResult = await runStripeReconciliationCli({
      arguments_: ['preview', '--event-id', 'evt_owned'],
      projectRoot,
      previewCampaign,
      output: { write: vi.fn() },
      now: () => new Date('2026-08-24T07:10:00.000Z'),
      uuid: () => '00000000-0000-4000-8000-000000000002',
    });
    expect(previewResult?.manifest.campaignId).toBe(campaignId);

    const configuration = await loadStripeReconciliationConfiguration({
      environmentPath: join(projectRoot, '.env.development.local'),
    });
    await expect(
      loadStripeReconciliationManifest({
        campaignId,
        directory: join(projectRoot, '.aws-sam/stripe-reconcile'),
        configuration,
      }),
    ).resolves.toMatchObject({ campaignId, entries: [{ eventId: 'evt_owned' }] });

    const executeCampaign = vi.fn().mockResolvedValue({
      campaignId,
      successful: true,
      outcomes: [
        {
          eventId: 'evt_owned',
          outcome: 'ignored',
          orderId: 'ord_owned',
          orderVersion: 3,
        },
      ],
    });
    let printed = '';
    const executionResult = await runStripeReconciliationCli({
      arguments_: ['execute', '--campaign', campaignId],
      projectRoot,
      executeCampaign,
      output: { write: (value: string) => (printed += value) },
    });

    expect(executeCampaign).toHaveBeenCalledOnce();
    expect(executionResult).toMatchObject({ execution: { successful: true } });
    expect(printed).toContain('IGNORED evt_owned');
    expect(printed).toContain('Summary: applied=0 ignored=1 reconciliation_required=0 failed=0');
  });

  it('rejects an edited manifest before invoking campaign execution', async () => {
    const projectRoot = await temporaryProject(
      ['STRIPE_SECRET_KEY=sk_test_synthetic', 'STRIPE_ACCOUNT_ID=acct_preview123', ''].join('\n'),
    );
    const previewCampaign = vi.fn().mockResolvedValue({
      stripeAccountId: 'acct_preview123',
      previewedAt: '2026-08-24T07:10:00.000Z',
      selection: { kind: 'event_ids', eventIds: ['evt_owned'] },
      entries: [
        {
          eventId: 'evt_owned',
          eventType: 'payment_intent.succeeded',
          eventCreatedAt: '2026-08-24T07:09:00.000Z',
          eventFingerprint: 'a'.repeat(64),
          stripePaymentIntentId: 'pi_owned',
          merchantId: 'mrc_demo',
          orderId: 'ord_owned',
        },
      ],
      excluded: [],
    });
    const result = await runStripeReconciliationCli({
      arguments_: ['preview', '--event-id', 'evt_owned'],
      projectRoot,
      previewCampaign,
      output: { write: vi.fn() },
      now: () => new Date('2026-08-24T07:10:00.000Z'),
      uuid: () => '00000000-0000-4000-8000-000000000003',
    });
    const manifestPath = result?.manifestPath as string;
    const source = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, source.replace('ord_owned', 'ord_changed'), { mode: 0o600 });
    const executeCampaign = vi.fn();

    await expect(
      runStripeReconciliationCli({
        arguments_: ['execute', '--campaign', result?.manifest.campaignId as string],
        projectRoot,
        executeCampaign,
        output: { write: vi.fn() },
      }),
    ).rejects.toThrow('changed after preview');
    expect(executeCampaign).not.toHaveBeenCalled();
  });
});
