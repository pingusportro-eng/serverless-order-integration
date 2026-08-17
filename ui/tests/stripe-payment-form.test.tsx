import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Stripe, StripeElements } from '@stripe/stripe-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePaymentElementProps {
  readonly onReady?: () => void;
  readonly onLoadError?: () => void;
}

const runtime = vi.hoisted(() => ({
  stripe: null as Stripe | null,
  elements: null as StripeElements | null,
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { readonly children: React.ReactNode }) => children,
  PaymentElement: ({ onReady, onLoadError }: FakePaymentElementProps) => (
    <div aria-label="Stripe hosted payment fields">
      <button type="button" onClick={onReady}>
        Finish loading fields
      </button>
      <button type="button" onClick={onLoadError}>
        Fail loading fields
      </button>
    </div>
  ),
  useElements: () => runtime.elements,
  useStripe: () => runtime.stripe,
}));

import { StripePaymentForm } from '../src/stripe-payment-form.js';

function stripeWithConfirmPayment(confirmPayment: ReturnType<typeof vi.fn>): Stripe {
  return { confirmPayment } as unknown as Stripe;
}

function renderForm(onConfirmed = vi.fn<(status: string) => void>()) {
  render(
    <StripePaymentForm
      clientSecret="pi_example_secret_never-render"
      amountLabel="37.42 RON"
      stripe={runtime.stripe}
      returnUrl="https://shop.example.test/payment-return"
      onConfirmed={onConfirmed}
    />,
  );
  return onConfirmed;
}

describe('StripePaymentForm', () => {
  beforeEach(() => {
    runtime.elements = {} as StripeElements;
    runtime.stripe = null;
  });

  it('keeps the client secret out of rendered text and waits for Stripe.js', () => {
    renderForm();

    expect(document.body.textContent).not.toContain('pi_example_secret_never-render');
    expect(screen.getByRole('button', { name: 'Loading secure payment fields…' })).toBeDisabled();
  });

  it('confirms through Stripe.js without redirect when one is not required', async () => {
    const confirmPayment = vi.fn().mockResolvedValue({
      paymentIntent: { status: 'succeeded' },
    });
    runtime.stripe = stripeWithConfirmPayment(confirmPayment);
    const onConfirmed = renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Finish loading fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay 37.42 RON' }));

    await waitFor(() => {
      expect(confirmPayment).toHaveBeenCalledWith({
        elements: runtime.elements,
        confirmParams: { return_url: 'https://shop.example.test/payment-return' },
        redirect: 'if_required',
      });
    });
    expect(onConfirmed).toHaveBeenCalledWith('SUCCEEDED');
    expect(screen.getByText(/signed webhook remains authoritative/)).toBeVisible();
  });

  it('shows a safe Stripe-declared failure and permits a retry', async () => {
    const confirmPayment = vi.fn().mockResolvedValue({
      error: { message: 'Your test card was declined.' },
    });
    runtime.stripe = stripeWithConfirmPayment(confirmPayment);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Finish loading fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay 37.42 RON' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your test card was declined.');
    expect(screen.getByRole('button', { name: 'Pay 37.42 RON' })).toBeEnabled();
  });

  it('treats a thrown confirmation request as an ambiguous outcome', async () => {
    const confirmPayment = vi.fn().mockRejectedValue(new Error('connection reset'));
    runtime.stripe = stripeWithConfirmPayment(confirmPayment);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Finish loading fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay 37.42 RON' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stripe payment confirmation has an unknown outcome. Check Stripe before retrying.',
    );
  });

  it('reports that Stripe hosted fields could not load', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Fail loading fields' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Stripe’s secure payment fields could not be loaded.',
    );
  });
});
