const STABLE_STACK_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
]);

const IN_PROGRESS_SUFFIXES = ['_IN_PROGRESS', '_CLEANUP_IN_PROGRESS'];

export function decideStackAction(stack, desired) {
  if (stack === undefined) {
    return { action: 'prepare', reason: 'application stack is absent' };
  }

  if (IN_PROGRESS_SUFFIXES.some((suffix) => stack.status.endsWith(suffix))) {
    return { action: 'wait', reason: `application stack is ${stack.status}` };
  }

  if (!STABLE_STACK_STATUSES.has(stack.status)) {
    return {
      action: 'blocked',
      reason: `application stack requires recovery from ${stack.status}`,
    };
  }

  if (stack.gitCommit === desired.gitCommit && stack.vendorBaseUrl === desired.vendorBaseUrl) {
    return { action: 'reuse', reason: 'deployed commit and vendor URL already match' };
  }

  return {
    action: 'prepare',
    reason:
      stack.gitCommit === desired.gitCommit
        ? 'the deployed stack needs the current lab vendor URL'
        : 'the deployed stack needs the reviewed commit',
  };
}

export function decideOwnedProcess(savedProcess, observation) {
  if (savedProcess === undefined) {
    return { action: 'start', reason: 'no lab-owned process is recorded' };
  }
  if (!observation.running) {
    return { action: 'replace', reason: 'the recorded process is no longer running' };
  }
  if (!observation.commandMatches) {
    return {
      action: 'blocked',
      reason: `PID ${String(savedProcess.pid)} now belongs to another command`,
    };
  }
  if (!observation.healthy) {
    return { action: 'replace', reason: 'the lab-owned process is unhealthy' };
  }
  return { action: 'reuse', reason: 'the healthy process is owned by this lab' };
}

export function isStableStackStatus(status) {
  return STABLE_STACK_STATUSES.has(status);
}
