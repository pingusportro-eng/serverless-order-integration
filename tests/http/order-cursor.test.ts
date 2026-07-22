import { describe, expect, it } from 'vitest';

import { asMerchantId, asOrderId } from '../../src/domain/order.js';
import { createOrderCursorCodec, InvalidOrderCursorError } from '../../src/http/order-cursor.js';

const SIGNING_SECRET = 'cursor-test-secret-with-at-least-thirty-two-bytes';
const merchantId = asMerchantId('mrc_cursor_test');
const position = {
  createdAt: '2026-07-21T12:30:00.000Z',
  orderId: asOrderId('ord_12345678'),
};

describe('order cursor codec', () => {
  it('round-trips a signed logical list position', () => {
    const codec = createOrderCursorCodec(SIGNING_SECRET);

    const token = codec.encode({ merchantId, status: 'SUBMITTED' }, position);

    expect(codec.decode(token, { merchantId, status: 'SUBMITTED' })).toEqual(position);
  });

  it('contains no DynamoDB key attribute names', () => {
    const codec = createOrderCursorCodec(SIGNING_SECRET);
    const token = codec.encode({ merchantId }, position);
    const encodedPayload = token.split('.')[0];
    if (encodedPayload === undefined) {
      throw new Error('Expected an encoded cursor payload.');
    }
    const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');

    expect(payload).not.toMatch(/\b(?:pk|sk|gsi1pk|gsi1sk|gsi2pk|gsi2sk)\b/);
  });

  it('rejects tampering', () => {
    const codec = createOrderCursorCodec(SIGNING_SECRET);
    const token = codec.encode({ merchantId }, position);
    const finalCharacter = token.at(-1);
    const tamperedToken = `${token.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`;

    expect(() => codec.decode(tamperedToken, { merchantId })).toThrow(InvalidOrderCursorError);
  });

  it('rejects reuse for another merchant or status filter', () => {
    const codec = createOrderCursorCodec(SIGNING_SECRET);
    const token = codec.encode({ merchantId, status: 'SUBMITTED' }, position);

    expect(() =>
      codec.decode(token, {
        merchantId: asMerchantId('mrc_another_merchant'),
        status: 'SUBMITTED',
      }),
    ).toThrow(InvalidOrderCursorError);
    expect(() => codec.decode(token, { merchantId, status: 'DELIVERED' })).toThrow(
      InvalidOrderCursorError,
    );
    expect(() => codec.decode(token, { merchantId })).toThrow(InvalidOrderCursorError);
  });

  it('rejects malformed cursors and weak signing secrets', () => {
    const codec = createOrderCursorCodec(SIGNING_SECRET);

    expect(() => codec.decode('not-a-cursor', { merchantId })).toThrow(InvalidOrderCursorError);
    expect(() => createOrderCursorCodec('too-short')).toThrow(RangeError);
  });
});
