export interface ObservedStack {
  readonly status: string;
  readonly gitCommit?: string;
  readonly vendorBaseUrl?: string;
}

export interface DesiredStack {
  readonly gitCommit: string;
  readonly vendorBaseUrl: string;
}

export interface SavedProcess {
  readonly pid: number;
  readonly commandFragment: string;
}

export interface ProcessObservation {
  readonly running: boolean;
  readonly commandMatches: boolean;
  readonly healthy: boolean;
}

export interface StateDecision {
  readonly action: 'blocked' | 'prepare' | 'replace' | 'reuse' | 'start' | 'wait';
  readonly reason: string;
}

export function decideStackAction(
  stack: ObservedStack | undefined,
  desired: DesiredStack,
): StateDecision;

export function decideOwnedProcess(
  savedProcess: SavedProcess | undefined,
  observation: ProcessObservation,
): StateDecision;

export function isStableStackStatus(status: string): boolean;
