import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CreatedOrder, PreparedPaymentIntent } from '../src/api/contracts.js';
import type { OrdersApiClient } from '../src/api/orders-api-client.js';
import { App } from '../src/App.js';

vi.mock('../src/stripe-payment-form.js', () => ({
  StripePaymentForm: ({
    amountLabel,
    onConfirmed,
  }: {
    readonly amountLabel: string;
    readonly onConfirmed: (status: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onConfirmed('SUCCEEDED');
      }}
    >
      Confirm test payment for {amountLabel}
    </button>
  ),
}));

const CREATED_ORDER: CreatedOrder = {
  orderId: 'ord_12345678',
  merchantOrderId: 'pos-order-10042',
  status: 'AWAITING_PAYMENT',
  version: 1,
  total: { amountMinor: 1299, currency: 'RON' },
  payment: {
    status: 'NOT_STARTED',
    amount: { amountMinor: 1299, currency: 'RON' },
  },
};

const PREPARED_PAYMENT: PreparedPaymentIntent = {
  orderId: 'ord_12345678',
  orderVersion: 2,
  stripePaymentIntentId: 'pi_12345678',
  status: 'REQUIRES_PAYMENT_METHOD',
  amount: { amountMinor: 1299, currency: 'RON' },
  clientSecret: 'pi_12345678_secret_do-not-render',
};

function client(
  createOrder = vi.fn<OrdersApiClient['createOrder']>(),
  preparePaymentIntent = vi.fn<OrdersApiClient['preparePaymentIntent']>(),
): OrdersApiClient {
  return { createOrder, preparePaymentIntent };
}

describe('App', () => {
  it('presents the learning journey and identifies the local authentication boundary', () => {
    render(<App ordersApiClient={client()} authMode="local-bypass" stripe={null} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Order Integration Lab' })).toBeVisible();
    expect(screen.getByText('Local auth bypass')).toBeVisible();
    expect(screen.getByText(/Cognito is not exercised locally/)).toBeVisible();

    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(5);
    const [firstStep, ...waitingSteps] = steps;
    if (firstStep === undefined) {
      throw new Error('The create-order step is missing.');
    }
    expect(within(firstStep).getByRole('heading', { name: 'Create order' })).toBeVisible();
    expect(within(firstStep).getByText('Ready')).toBeVisible();
    for (const step of waitingSteps) {
      expect(within(step).getByText('Waiting')).toBeVisible();
    }
  });

  it('creates an order and advances only the next journey step', async () => {
    const createOrder = vi.fn<OrdersApiClient['createOrder']>().mockResolvedValue(CREATED_ORDER);
    render(
      <App
        ordersApiClient={client(createOrder)}
        authMode="local-bypass"
        stripe={null}
        createId={() => 'operation-123'}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => {
      expect(screen.getByText('ord_12345678')).toBeVisible();
    });
    expect(screen.getByText(/at version 1/)).toBeVisible();
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'create-order:operation-123',
        correlationId: 'ui-create-order:operation-123',
      }),
    );
    expect(screen.getByRole('button', { name: 'Order created' })).toBeDisabled();

    const steps = screen.getAllByRole('listitem');
    const createStep = steps[0];
    const prepareStep = steps[1];
    const confirmStep = steps[2];
    if (createStep === undefined || prepareStep === undefined || confirmStep === undefined) {
      throw new Error('The expected payment journey steps are missing.');
    }
    expect(within(createStep).getByText('Complete')).toBeVisible();
    expect(within(prepareStep).getByText('Ready')).toBeVisible();
    expect(within(confirmStep).getByText('Waiting')).toBeVisible();
  });

  it('prepares the order payment without rendering the client secret', async () => {
    const createOrder = vi.fn<OrdersApiClient['createOrder']>().mockResolvedValue(CREATED_ORDER);
    const preparePaymentIntent = vi
      .fn<OrdersApiClient['preparePaymentIntent']>()
      .mockResolvedValue(PREPARED_PAYMENT);
    render(
      <App
        ordersApiClient={client(createOrder, preparePaymentIntent)}
        authMode="local-bypass"
        stripe={null}
        createId={() => 'operation-123'}
      />,
    );

    expect(screen.getByRole('button', { name: 'Create order first' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Prepare payment' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Prepare payment' }));
    await waitFor(() => {
      expect(screen.getByText('pi_12345678')).toBeVisible();
    });

    expect(preparePaymentIntent).toHaveBeenCalledWith({
      orderId: 'ord_12345678',
      correlationId: 'ui-prepare-payment:ord_12345678:operation-123',
    });
    const paymentPanel = screen
      .getByRole('heading', { name: 'Prepare the Stripe payment' })
      .closest('section');
    if (paymentPanel === null) {
      throw new Error('The payment preparation panel is missing.');
    }
    expect(within(paymentPanel).getByText('REQUIRES_PAYMENT_METHOD')).toBeVisible();
    expect(within(paymentPanel).getByText('12.99 RON')).toBeVisible();
    expect(screen.queryByText(PREPARED_PAYMENT.clientSecret)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PREPARED_PAYMENT.clientSecret);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm test payment for 12.99 RON' }));

    const steps = screen.getAllByRole('listitem');
    const prepareStep = steps[1];
    const confirmStep = steps[2];
    if (prepareStep === undefined || confirmStep === undefined) {
      throw new Error('The expected payment journey steps are missing.');
    }
    expect(within(prepareStep).getByText('Complete')).toBeVisible();
    expect(within(confirmStep).getByText('Complete')).toBeVisible();
  });
});
