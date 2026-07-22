import { createHmac, timingSafeEqual } from 'node:crypto';

import type { OrderListPosition } from '../application/order-repository.js';
import { asOrderId, type MerchantId } from '../domain/order.js';
import { ORDER_STATUSES, type OrderStatus } from '../domain/order-status.js';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const MINIMUM_SECRET_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{8,60}$/;

interface CursorPayload {
  readonly version: typeof CURSOR_VERSION;
  readonly merchantId: string;
  readonly status: OrderStatus | null;
  readonly createdAt: string;
  readonly orderId: string;
}

export interface OrderCursorScope {
  readonly merchantId: MerchantId;
  readonly status?: OrderStatus;
}

export interface OrderCursorCodec {
  encode(scope: OrderCursorScope, position: OrderListPosition): string;
  decode(token: string, scope: OrderCursorScope): OrderListPosition;
}

export class InvalidOrderCursorError extends Error {
  override readonly name = 'InvalidOrderCursorError';

  constructor() {
    super('The order cursor is invalid or does not belong to this query.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && ORDER_STATUSES.some((status) => status === value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function readPayload(value: unknown): CursorPayload {
  if (
    !isRecord(value) ||
    value['version'] !== CURSOR_VERSION ||
    typeof value['merchantId'] !== 'string' ||
    !(value['status'] === null || isOrderStatus(value['status'])) ||
    !isCanonicalTimestamp(value['createdAt']) ||
    typeof value['orderId'] !== 'string' ||
    !ORDER_ID_PATTERN.test(value['orderId'])
  ) {
    throw new InvalidOrderCursorError();
  }

  return value as unknown as CursorPayload;
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new InvalidOrderCursorError();
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new InvalidOrderCursorError();
  }

  return decoded;
}

export function createOrderCursorCodec(signingSecret: string): OrderCursorCodec {
  if (Buffer.byteLength(signingSecret, 'utf8') < MINIMUM_SECRET_BYTES) {
    throw new RangeError('The cursor signing secret must contain at least 32 bytes.');
  }

  const secret = Buffer.from(signingSecret, 'utf8');

  return {
    encode(scope, position) {
      const payload: CursorPayload = {
        version: CURSOR_VERSION,
        merchantId: scope.merchantId,
        status: scope.status ?? null,
        createdAt: position.createdAt,
        orderId: position.orderId,
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const signature = createHmac('sha256', secret)
        .update(encodedPayload)
        .digest()
        .toString('base64url');
      return `${encodedPayload}.${signature}`;
    },

    decode(token, scope) {
      if (token.length < 1 || token.length > MAX_CURSOR_LENGTH) {
        throw new InvalidOrderCursorError();
      }

      const parts = token.split('.');
      const encodedPayload = parts[0];
      const encodedSignature = parts[1];
      if (parts.length !== 2 || !encodedPayload || !encodedSignature) {
        throw new InvalidOrderCursorError();
      }

      const signature = decodeCanonicalBase64Url(encodedSignature);
      const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest();
      if (
        signature.length !== expectedSignature.length ||
        !timingSafeEqual(signature, expectedSignature)
      ) {
        throw new InvalidOrderCursorError();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeCanonicalBase64Url(encodedPayload).toString('utf8')) as unknown;
      } catch (error) {
        if (error instanceof InvalidOrderCursorError) {
          throw error;
        }
        throw new InvalidOrderCursorError();
      }

      const payload = readPayload(parsed);
      if (payload.merchantId !== scope.merchantId || payload.status !== (scope.status ?? null)) {
        throw new InvalidOrderCursorError();
      }

      return { createdAt: payload.createdAt, orderId: asOrderId(payload.orderId) };
    },
  };
}
