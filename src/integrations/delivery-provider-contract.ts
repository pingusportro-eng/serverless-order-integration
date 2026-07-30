import type { DeliveryLocation } from '../domain/order.js';

export interface DeliveryProviderLine {
  readonly itemReference: string;
  readonly quantity: number;
}

export interface DeliveryProviderSubmission {
  readonly platformOrderId: string;
  readonly merchantOrderId: string;
  readonly items: readonly DeliveryProviderLine[];
  readonly pickup: DeliveryLocation;
  readonly dropoff: DeliveryLocation;
}

export interface DeliveryProviderAcceptance {
  readonly deliveryProviderOrderId: string;
  readonly status: 'ACCEPTED';
  readonly acceptedAt: string;
}
