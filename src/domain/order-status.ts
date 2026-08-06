export const ORDER_STATUSES = [
  'AWAITING_PAYMENT',
  'PENDING_SUBMISSION',
  'SUBMISSION_FAILED',
  'SUBMITTED',
  'PICKED_UP',
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'DELIVERED',
  'DELIVERY_FAILED',
  'CANCELLED',
]);

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}
