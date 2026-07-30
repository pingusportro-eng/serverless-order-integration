import type { FailureDetails } from '../domain/order.js';
import type { OrderStatus } from '../domain/order-status.js';
import type { ValidationIssue } from '../http/problem-details.js';
import type { ValidationResult } from './create-order-validation.js';

const OPERATOR_TARGET_STATUSES = [
  'PENDING_SUBMISSION',
  'SUBMITTED',
  'PICKED_UP',
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];
const TOP_LEVEL_FIELDS = new Set(['targetStatus', 'reason', 'deliveryProviderOrderId', 'failure']);
const FAILURE_FIELDS = new Set(['stage', 'reasonCode', 'summary', 'occurredAt']);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface ChangeOrderStatusRequest {
  readonly targetStatus: (typeof OPERATOR_TARGET_STATUSES)[number];
  readonly reason: string;
  readonly deliveryProviderOrderId?: string;
  readonly failure?: FailureDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addUnknownFieldIssues(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  pointer: string,
  issues: ValidationIssue[],
): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      issues.push({ pointer: `${pointer}/${field}`, detail: 'is not allowed' });
    }
  }
}

function readString(
  value: unknown,
  pointer: string,
  minimumLength: number,
  maximumLength: number,
  issues: ValidationIssue[],
  pattern?: RegExp,
): string | undefined {
  if (typeof value !== 'string') {
    issues.push({ pointer, detail: 'must be a string' });
    return undefined;
  }

  if (value.length < minimumLength || value.length > maximumLength) {
    issues.push({
      pointer,
      detail: `length must be between ${String(minimumLength)} and ${String(maximumLength)}`,
    });
  } else if (pattern && !pattern.test(value)) {
    issues.push({ pointer, detail: 'has an invalid format' });
  }

  return value;
}

function readTimestamp(
  value: unknown,
  pointer: string,
  issues: ValidationIssue[],
): string | undefined {
  const timestamp = readString(value, pointer, 1, 50, issues);
  if (timestamp === undefined) {
    return undefined;
  }

  try {
    return new Date(timestamp).toISOString();
  } catch {
    issues.push({ pointer, detail: 'must be a valid date-time' });
    return undefined;
  }
}

function readFailure(value: unknown, issues: ValidationIssue[]): FailureDetails | undefined {
  if (!isRecord(value)) {
    issues.push({ pointer: '#/failure', detail: 'must be an object' });
    return undefined;
  }

  addUnknownFieldIssues(value, FAILURE_FIELDS, '#/failure', issues);
  const stage = value['stage'];
  if (stage !== 'SUBMISSION' && stage !== 'DELIVERY') {
    issues.push({ pointer: '#/failure/stage', detail: 'must be SUBMISSION or DELIVERY' });
  }
  const reasonCode = readString(
    value['reasonCode'],
    '#/failure/reasonCode',
    1,
    100,
    issues,
    REASON_CODE_PATTERN,
  );
  const summary = readString(value['summary'], '#/failure/summary', 1, 500, issues);
  const occurredAt = readTimestamp(value['occurredAt'], '#/failure/occurredAt', issues);

  return (stage !== 'SUBMISSION' && stage !== 'DELIVERY') ||
    reasonCode === undefined ||
    summary === undefined ||
    occurredAt === undefined
    ? undefined
    : { stage, reasonCode, summary, occurredAt };
}

export function validateChangeOrderStatusRequest(
  value: unknown,
): ValidationResult<ChangeOrderStatusRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: [{ pointer: '#', detail: 'must be an object' }] };
  }

  addUnknownFieldIssues(value, TOP_LEVEL_FIELDS, '#', issues);
  const targetStatus = OPERATOR_TARGET_STATUSES.find(
    (candidate) => candidate === value['targetStatus'],
  );
  if (targetStatus === undefined) {
    issues.push({ pointer: '#/targetStatus', detail: 'must be an operator-controlled status' });
  }
  const reason = readString(value['reason'], '#/reason', 3, 500, issues);
  const deliveryProviderOrderId =
    value['deliveryProviderOrderId'] === undefined
      ? undefined
      : readString(value['deliveryProviderOrderId'], '#/deliveryProviderOrderId', 1, 128, issues);
  const failure =
    value['failure'] === undefined ? undefined : readFailure(value['failure'], issues);

  if (targetStatus === 'DELIVERY_FAILED' && value['failure'] === undefined) {
    issues.push({ pointer: '#/failure', detail: 'is required for DELIVERY_FAILED' });
  } else if (
    targetStatus !== undefined &&
    targetStatus !== 'DELIVERY_FAILED' &&
    value['failure'] !== undefined
  ) {
    issues.push({ pointer: '#/failure', detail: 'is only allowed for DELIVERY_FAILED' });
  }

  if (issues.length > 0 || targetStatus === undefined || reason === undefined) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    value: {
      targetStatus,
      reason,
      ...(deliveryProviderOrderId === undefined ? {} : { deliveryProviderOrderId }),
      ...(failure === undefined ? {} : { failure }),
    },
  };
}
