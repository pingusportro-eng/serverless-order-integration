import { describe, expect, it } from 'vitest';

import { isTerminalOrderStatus, type OrderStatus } from '../../src/index.js';

describe('isTerminalOrderStatus', () => {
  it.each<OrderStatus>(['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'])(
    'recognizes %s as terminal',
    (status) => {
      expect(isTerminalOrderStatus(status)).toBe(true);
    },
  );

  it.each<OrderStatus>([
    'AWAITING_PAYMENT',
    'PENDING_SUBMISSION',
    'SUBMISSION_FAILED',
    'SUBMITTED',
    'PICKED_UP',
  ])('recognizes %s as non-terminal', (status) => {
    expect(isTerminalOrderStatus(status)).toBe(false);
  });
});
