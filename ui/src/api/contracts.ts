export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface DeliveryLocation {
  readonly addressLine: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export interface OrderLine {
  readonly itemReference: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
}

export interface CreateOrderRequest {
  readonly merchantOrderId: string;
  readonly items: readonly OrderLine[];
  readonly pickup: DeliveryLocation;
  readonly dropoff: DeliveryLocation;
}

export interface CreatedOrder {
  readonly orderId: string;
  readonly merchantOrderId: string;
  readonly status: 'AWAITING_PAYMENT';
  readonly version: number;
  readonly total: Money;
  readonly payment: {
    readonly status: 'NOT_STARTED';
    readonly amount: Money;
  };
}

export interface ProblemDetails {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}
