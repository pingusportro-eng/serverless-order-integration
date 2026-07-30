import type { DeliveryLocation, Money, OrderLine } from '../domain/order.js';
import type { ValidationIssue } from '../http/problem-details.js';

export interface CreateOrderRequest {
  readonly merchantOrderId: string;
  readonly items: readonly OrderLine[];
  readonly pickup: DeliveryLocation;
  readonly dropoff: DeliveryLocation;
}

export type ValidationResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

const TOP_LEVEL_FIELDS = new Set(['merchantOrderId', 'items', 'pickup', 'dropoff']);
const ORDER_LINE_FIELDS = new Set(['itemReference', 'description', 'quantity', 'unitPrice']);
const MONEY_FIELDS = new Set(['amountMinor', 'currency']);
const LOCATION_FIELDS = new Set(['addressLine', 'city', 'postalCode', 'countryCode']);

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

function readInteger(
  value: unknown,
  pointer: string,
  minimum: number,
  maximum: number,
  issues: ValidationIssue[],
): number | undefined {
  if (!Number.isSafeInteger(value)) {
    issues.push({ pointer, detail: 'must be a safe integer' });
    return undefined;
  }

  const integer = value as number;
  if (integer < minimum || integer > maximum) {
    issues.push({
      pointer,
      detail: `must be between ${String(minimum)} and ${String(maximum)}`,
    });
  }

  return integer;
}

function readMoney(value: unknown, pointer: string, issues: ValidationIssue[]): Money | undefined {
  if (!isRecord(value)) {
    issues.push({ pointer, detail: 'must be an object' });
    return undefined;
  }

  addUnknownFieldIssues(value, MONEY_FIELDS, pointer, issues);
  const amountMinor = readInteger(
    value['amountMinor'],
    `${pointer}/amountMinor`,
    0,
    Number.MAX_SAFE_INTEGER,
    issues,
  );
  const currency = readString(value['currency'], `${pointer}/currency`, 3, 3, issues, /^[A-Z]{3}$/);

  return amountMinor === undefined || currency === undefined
    ? undefined
    : { amountMinor, currency };
}

function readOrderLine(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): OrderLine | undefined {
  const pointer = `#/items/${String(index)}`;
  if (!isRecord(value)) {
    issues.push({ pointer, detail: 'must be an object' });
    return undefined;
  }

  addUnknownFieldIssues(value, ORDER_LINE_FIELDS, pointer, issues);
  const itemReference = readString(
    value['itemReference'],
    `${pointer}/itemReference`,
    1,
    100,
    issues,
  );
  const description = readString(value['description'], `${pointer}/description`, 1, 200, issues);
  const quantity = readInteger(value['quantity'], `${pointer}/quantity`, 1, 100, issues);
  const unitPrice = readMoney(value['unitPrice'], `${pointer}/unitPrice`, issues);

  return itemReference === undefined ||
    description === undefined ||
    quantity === undefined ||
    unitPrice === undefined
    ? undefined
    : { itemReference, description, quantity, unitPrice };
}

function readOrderLines(
  value: unknown,
  issues: ValidationIssue[],
): readonly OrderLine[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ pointer: '#/items', detail: 'must be an array' });
    return undefined;
  }

  if (value.length < 1 || value.length > 50) {
    issues.push({ pointer: '#/items', detail: 'must contain between 1 and 50 lines' });
  }

  const lines = value.map((line, index) => readOrderLine(line, index, issues));
  return lines.some((line) => line === undefined) ? undefined : (lines as readonly OrderLine[]);
}

function readLocation(
  value: unknown,
  pointer: '#/pickup' | '#/dropoff',
  issues: ValidationIssue[],
): DeliveryLocation | undefined {
  if (!isRecord(value)) {
    issues.push({ pointer, detail: 'must be an object' });
    return undefined;
  }

  addUnknownFieldIssues(value, LOCATION_FIELDS, pointer, issues);
  const addressLine = readString(value['addressLine'], `${pointer}/addressLine`, 1, 200, issues);
  const city = readString(value['city'], `${pointer}/city`, 1, 100, issues);
  const postalCode = readString(value['postalCode'], `${pointer}/postalCode`, 1, 20, issues);
  const countryCode = readString(
    value['countryCode'],
    `${pointer}/countryCode`,
    2,
    2,
    issues,
    /^[A-Z]{2}$/,
  );

  return addressLine === undefined ||
    city === undefined ||
    postalCode === undefined ||
    countryCode === undefined
    ? undefined
    : { addressLine, city, postalCode, countryCode };
}

function locationsAreEqual(first: DeliveryLocation, second: DeliveryLocation): boolean {
  return (
    first.addressLine === second.addressLine &&
    first.city === second.city &&
    first.postalCode === second.postalCode &&
    first.countryCode === second.countryCode
  );
}

function validateCurrenciesAndTotal(lines: readonly OrderLine[], issues: ValidationIssue[]): void {
  const expectedCurrency = lines[0]?.unitPrice.currency;
  let total = 0;

  for (const [index, line] of lines.entries()) {
    if (line.unitPrice.currency !== expectedCurrency) {
      issues.push({
        pointer: `#/items/${String(index)}/unitPrice/currency`,
        detail: 'must match the currency used by every other line',
      });
    }

    const lineTotal = line.quantity * line.unitPrice.amountMinor;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(total + lineTotal)) {
      issues.push({
        pointer: '#/items',
        detail: 'calculated total exceeds the safe integer range',
      });
      return;
    }

    total += lineTotal;
  }
}

export function validateCreateOrderRequest(value: unknown): ValidationResult<CreateOrderRequest> {
  const issues: ValidationIssue[] = [];

  if (!isRecord(value)) {
    return { valid: false, issues: [{ pointer: '#', detail: 'must be an object' }] };
  }

  addUnknownFieldIssues(value, TOP_LEVEL_FIELDS, '#', issues);
  const merchantOrderId = readString(value['merchantOrderId'], '#/merchantOrderId', 1, 100, issues);
  const items = readOrderLines(value['items'], issues);
  const pickup = readLocation(value['pickup'], '#/pickup', issues);
  const dropoff = readLocation(value['dropoff'], '#/dropoff', issues);

  if (items) {
    validateCurrenciesAndTotal(items, issues);
  }

  if (pickup && dropoff && locationsAreEqual(pickup, dropoff)) {
    issues.push({ pointer: '#/dropoff', detail: 'must be different from pickup' });
  }

  if (
    issues.length > 0 ||
    merchantOrderId === undefined ||
    items === undefined ||
    pickup === undefined ||
    dropoff === undefined
  ) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    value: { merchantOrderId, items, pickup, dropoff },
  };
}

export function calculateOrderTotal(request: CreateOrderRequest): Money {
  return {
    amountMinor: request.items.reduce(
      (total, line) => total + line.quantity * line.unitPrice.amountMinor,
      0,
    ),
    currency: request.items[0]?.unitPrice.currency ?? '',
  };
}
