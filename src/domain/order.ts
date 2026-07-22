import type { OrderStatus } from './order-status.js';

declare const brand: unique symbol;

type BrandedString<TName extends string> = string & { readonly [brand]: TName };

export type OrderId = BrandedString<'OrderId'>;
export type MerchantId = BrandedString<'MerchantId'>;

export function asOrderId(value: string): OrderId {
  return value as OrderId;
}

export function asMerchantId(value: string): MerchantId {
  return value as MerchantId;
}

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface OrderLine {
  readonly itemReference: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
}

export interface DeliveryLocation {
  readonly addressLine: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export interface ProviderAssignment {
  readonly providerCode: 'mock-delivery';
  readonly submissionKey: string;
  readonly providerOrderId?: string;
  readonly acceptedAt?: string;
}

export interface FailureDetails {
  readonly stage: 'SUBMISSION' | 'DELIVERY';
  readonly reasonCode: string;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface Order {
  readonly orderId: OrderId;
  readonly merchantId: MerchantId;
  readonly merchantOrderReference: string;
  readonly status: OrderStatus;
  readonly items: readonly OrderLine[];
  readonly total: Money;
  readonly pickup: DeliveryLocation;
  readonly dropoff: DeliveryLocation;
  readonly provider: ProviderAssignment;
  readonly failure?: FailureDetails;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}
