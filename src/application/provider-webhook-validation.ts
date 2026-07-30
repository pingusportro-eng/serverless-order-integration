import type { FailureDetails } from '../domain/order.js';
import type { ValidationIssue } from '../http/problem-details.js';
import type { ValidationResult } from './create-order-validation.js';

const EVENT_TYPES = [
  'DELIVERY_PICKED_UP',
  'DELIVERY_DELIVERED',
  'DELIVERY_FAILED',
  'DELIVERY_CANCELLED',
] as const;
const TOP_LEVEL_FIELDS = new Set([
  'eventId',
  'eventType',
  'occurredAt',
  'deliveryProviderOrderId',
  'failure',
]);
const FAILURE_FIELDS = new Set(['stage', 'reasonCode', 'summary', 'occurredAt']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export type ProviderWebhookEventType = (typeof EVENT_TYPES)[number];

export interface ProviderWebhookEvent {
  readonly eventId: string;
  readonly eventType: ProviderWebhookEventType;
  readonly occurredAt: string;
  readonly deliveryProviderOrderId: string;
  readonly failure?: FailureDetails & { readonly stage: 'DELIVERY' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  pointer: string,
  issues: ValidationIssue[],
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      issues.push({ pointer: `${pointer}/${field}`, detail: 'is not allowed' });
    }
  }
}

function stringValue(
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

function timestampValue(
  value: unknown,
  pointer: string,
  issues: ValidationIssue[],
): string | undefined {
  const timestamp = stringValue(value, pointer, 1, 50, issues);
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

function deliveryFailure(
  value: unknown,
  issues: ValidationIssue[],
): (FailureDetails & { readonly stage: 'DELIVERY' }) | undefined {
  if (!isRecord(value)) {
    issues.push({ pointer: '#/failure', detail: 'must be an object' });
    return undefined;
  }

  unknownFields(value, FAILURE_FIELDS, '#/failure', issues);
  if (value['stage'] !== 'DELIVERY') {
    issues.push({ pointer: '#/failure/stage', detail: 'must be DELIVERY' });
  }
  const reasonCode = stringValue(
    value['reasonCode'],
    '#/failure/reasonCode',
    1,
    100,
    issues,
    REASON_CODE_PATTERN,
  );
  const summary = stringValue(value['summary'], '#/failure/summary', 1, 500, issues);
  const occurredAt = timestampValue(value['occurredAt'], '#/failure/occurredAt', issues);

  return value['stage'] !== 'DELIVERY' ||
    reasonCode === undefined ||
    summary === undefined ||
    occurredAt === undefined
    ? undefined
    : { stage: 'DELIVERY', reasonCode, summary, occurredAt };
}

export function validateProviderWebhookEvent(
  value: unknown,
): ValidationResult<ProviderWebhookEvent> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: [{ pointer: '#', detail: 'must be an object' }] };
  }

  unknownFields(value, TOP_LEVEL_FIELDS, '#', issues);
  const eventId = stringValue(value['eventId'], '#/eventId', 8, 128, issues, IDENTIFIER_PATTERN);
  const eventType = EVENT_TYPES.find((candidate) => candidate === value['eventType']);
  if (eventType === undefined) {
    issues.push({ pointer: '#/eventType', detail: 'must be a supported delivery event type' });
  }
  const occurredAt = timestampValue(value['occurredAt'], '#/occurredAt', issues);
  const deliveryProviderOrderId = stringValue(
    value['deliveryProviderOrderId'],
    '#/deliveryProviderOrderId',
    1,
    128,
    issues,
  );
  const failure =
    value['failure'] === undefined ? undefined : deliveryFailure(value['failure'], issues);

  if (eventType === 'DELIVERY_FAILED' && value['failure'] === undefined) {
    issues.push({ pointer: '#/failure', detail: 'is required for DELIVERY_FAILED' });
  } else if (
    eventType !== undefined &&
    eventType !== 'DELIVERY_FAILED' &&
    value['failure'] !== undefined
  ) {
    issues.push({ pointer: '#/failure', detail: 'is only allowed for DELIVERY_FAILED' });
  }

  if (
    issues.length > 0 ||
    eventId === undefined ||
    eventType === undefined ||
    occurredAt === undefined ||
    deliveryProviderOrderId === undefined
  ) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    value: {
      eventId,
      eventType,
      occurredAt,
      deliveryProviderOrderId,
      ...(failure === undefined ? {} : { failure }),
    },
  };
}
