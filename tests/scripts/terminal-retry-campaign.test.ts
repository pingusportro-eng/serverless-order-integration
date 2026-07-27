import { execFile } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = new URL('../..', import.meta.url).pathname;
const campaignScript = join(projectRoot, 'scripts/cloud/terminal-retry-campaign.sh');

describe('terminal failure and retry cloud campaign harness', () => {
  it('refuses to make changes without an explicit mode', async () => {
    await chmod(campaignScript, 0o755);

    await expect(
      execFileAsync('bash', [campaignScript], {
        cwd: projectRoot,
      }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('locks the approved account, cost, traffic, and cleanup boundaries', async () => {
    const source = await readFile(campaignScript, 'utf8');

    expect(source).toContain("readonly expected_account_id='454921778743'");
    expect(source).toContain("readonly expected_region='eu-central-1'");
    expect(source).toContain("readonly expected_profile='pingusportro-admin'");
    expect(source).toContain('readonly call_cap=200');
    expect(source).toContain('readonly http_call_cap=200');
    expect(source).toContain('readonly throttle_request_count=100');
    expect(source).toContain('readonly throttle_parallelism=2');
    expect(source).toContain('assert_budget');
    expect(source).toContain('assert_stack_in_sync');
    expect(source).toContain('delete_campaign_data');
    expect(source).toContain('delete_audit_subscription');
    expect(source).toContain('delete_campaign_users');
    expect(source).not.toMatch(/--authorization\s+["']?Bearer/u);
  });
});
