export const IDEMPOTENT_OPERATION_STATES = [
  'READY',
  'IN_FLIGHT',
  'OUTCOME_UNKNOWN',
  'SUCCEEDED',
  'REJECTED',
] as const;

export type IdempotentOperationState = (typeof IDEMPOTENT_OPERATION_STATES)[number];

export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> };

export interface IdempotentOperation<TRequest> {
  readonly idempotencyKey: string;
  readonly request: DeepReadonly<TRequest>;
  readonly requestFingerprint: string;
  readonly state: IdempotentOperationState;
  readonly attemptCount: number;
}

export class InvalidIdempotentOperationError extends Error {
  override readonly name = 'InvalidIdempotentOperationError';
}

function immutableSnapshot<T>(value: T): DeepReadonly<T> {
  const snapshot = structuredClone(value);

  function freeze(valueToFreeze: unknown): void {
    if (typeof valueToFreeze !== 'object' || valueToFreeze === null) {
      return;
    }
    for (const nestedValue of Object.values(valueToFreeze)) {
      freeze(nestedValue);
    }
    Object.freeze(valueToFreeze);
  }

  freeze(snapshot);
  return snapshot as DeepReadonly<T>;
}

export function createIdempotentOperation<TRequest>(
  idempotencyKey: string,
  request: Readonly<TRequest>,
  requestFingerprint: string,
): IdempotentOperation<TRequest> {
  if (idempotencyKey.length === 0 || requestFingerprint.length === 0) {
    throw new InvalidIdempotentOperationError(
      'An idempotent operation requires a key and request fingerprint.',
    );
  }

  return {
    idempotencyKey,
    request: immutableSnapshot(request),
    requestFingerprint,
    state: 'READY',
    attemptCount: 0,
  };
}

export function beginIdempotentOperationAttempt<TRequest>(
  operation: IdempotentOperation<TRequest>,
  requestFingerprint: string,
): IdempotentOperation<TRequest> {
  if (operation.requestFingerprint !== requestFingerprint) {
    throw new InvalidIdempotentOperationError(
      'A retry cannot change the request associated with its idempotency key.',
    );
  }
  if (operation.state !== 'READY' && operation.state !== 'OUTCOME_UNKNOWN') {
    throw new InvalidIdempotentOperationError(
      `An operation in ${operation.state} cannot start another attempt.`,
    );
  }

  return {
    ...operation,
    state: 'IN_FLIGHT',
    attemptCount: operation.attemptCount + 1,
  };
}

export function markIdempotentOperationOutcome<TRequest>(
  operation: IdempotentOperation<TRequest>,
  state: 'OUTCOME_UNKNOWN' | 'SUCCEEDED' | 'REJECTED',
): IdempotentOperation<TRequest> {
  if (operation.state !== 'IN_FLIGHT') {
    throw new InvalidIdempotentOperationError(
      `An operation in ${operation.state} cannot record an attempt outcome.`,
    );
  }

  return { ...operation, state };
}
