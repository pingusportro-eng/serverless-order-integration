import { describe, expect, it } from 'vitest';

import * as labState from '../../scripts/cloud/development-lab-state.mjs';

const { decideOwnedProcess, decideStackAction, isStableStackStatus } = labState;

describe('development lab state decisions', () => {
  const desired = {
    gitCommit: '0123456789abcdef0123456789abcdef01234567',
    vendorBaseUrl: 'https://current-vendor.trycloudflare.com',
  };

  it('prepares an absent stack and reuses an exact healthy deployment', () => {
    expect(decideStackAction(undefined, desired)).toEqual({
      action: 'prepare',
      reason: 'application stack is absent',
    });
    expect(
      decideStackAction(
        {
          status: 'CREATE_COMPLETE',
          gitCommit: desired.gitCommit,
          vendorBaseUrl: desired.vendorBaseUrl,
        },
        desired,
      ),
    ).toEqual({
      action: 'reuse',
      reason: 'deployed commit and vendor URL already match',
    });
  });

  it('updates a stable stack when either the commit or ephemeral vendor URL changed', () => {
    expect(
      decideStackAction(
        {
          status: 'UPDATE_COMPLETE',
          gitCommit: desired.gitCommit,
          vendorBaseUrl: 'https://expired-vendor.trycloudflare.com',
        },
        desired,
      ),
    ).toMatchObject({ action: 'prepare' });
    expect(
      decideStackAction(
        {
          status: 'UPDATE_ROLLBACK_COMPLETE',
          gitCommit: 'another-commit',
          vendorBaseUrl: desired.vendorBaseUrl,
        },
        desired,
      ),
    ).toMatchObject({ action: 'prepare' });
  });

  it('waits for an operation in progress and blocks an unrecoverable stack', () => {
    expect(
      decideStackAction(
        {
          status: 'UPDATE_IN_PROGRESS',
          gitCommit: desired.gitCommit,
          vendorBaseUrl: desired.vendorBaseUrl,
        },
        desired,
      ),
    ).toMatchObject({ action: 'wait' });
    expect(
      decideStackAction(
        {
          status: 'ROLLBACK_FAILED',
          gitCommit: desired.gitCommit,
          vendorBaseUrl: desired.vendorBaseUrl,
        },
        desired,
      ),
    ).toMatchObject({ action: 'blocked' });
  });

  it('reuses only a healthy process whose PID still belongs to the lab command', () => {
    const saved = { pid: 123, commandFragment: 'mock-vendor' };
    expect(
      decideOwnedProcess(saved, {
        running: true,
        commandMatches: true,
        healthy: true,
      }),
    ).toMatchObject({ action: 'reuse' });
    expect(
      decideOwnedProcess(saved, {
        running: true,
        commandMatches: false,
        healthy: true,
      }),
    ).toMatchObject({ action: 'blocked' });
    expect(
      decideOwnedProcess(saved, {
        running: false,
        commandMatches: false,
        healthy: false,
      }),
    ).toMatchObject({ action: 'replace' });
  });

  it('recognizes only the reviewed stable CloudFormation states', () => {
    expect(isStableStackStatus('CREATE_COMPLETE')).toBe(true);
    expect(isStableStackStatus('UPDATE_COMPLETE')).toBe(true);
    expect(isStableStackStatus('UPDATE_ROLLBACK_COMPLETE')).toBe(true);
    expect(isStableStackStatus('ROLLBACK_COMPLETE')).toBe(false);
  });
});
