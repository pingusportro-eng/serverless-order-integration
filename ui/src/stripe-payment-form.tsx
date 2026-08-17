import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { useMemo, useState } from 'react';

export interface StripePaymentFormProps {
  readonly clientSecret: string;
  readonly amountLabel: string;
  readonly stripe: PromiseLike<Stripe | null> | Stripe | null;
  readonly returnUrl?: string;
  readonly onConfirmed: (status: string) => void;
}

interface ConfirmationFormProps {
  readonly amountLabel: string;
  readonly returnUrl: string;
  readonly onConfirmed: (status: string) => void;
}

function defaultReturnUrl(): string {
  const url = new URL(globalThis.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('payment_return', '1');
  return url.href;
}

function safeStripeErrorMessage(message: string | undefined): string {
  return message?.trim() || 'Stripe could not confirm the payment. Review the details and retry.';
}

export function ConfirmationForm({ amountLabel, returnUrl, onConfirmed }: ConfirmationFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [elementReady, setElementReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmedStatus, setConfirmedStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function confirmPayment(): Promise<void> {
    if (stripe === null || elements === null || submitting || confirmedStatus !== undefined) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });
      if (result.error !== undefined) {
        setError(safeStripeErrorMessage(result.error.message));
        return;
      }
      const status = result.paymentIntent.status.toUpperCase();
      setConfirmedStatus(status);
      onConfirmed(status);
    } catch {
      setError('Stripe payment confirmation has an unknown outcome. Check Stripe before retrying.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stripe-payment-form"
      onSubmit={(event) => {
        event.preventDefault();
        void confirmPayment();
      }}
    >
      <div className="stripe-element-shell">
        <PaymentElement
          options={{ layout: 'tabs' }}
          onReady={() => {
            setElementReady(true);
          }}
          onLoadError={() => {
            setError('Stripe’s secure payment fields could not be loaded.');
          }}
        />
      </div>
      <button
        type="submit"
        disabled={
          stripe === null ||
          elements === null ||
          !elementReady ||
          submitting ||
          confirmedStatus !== undefined
        }
      >
        {confirmedStatus !== undefined
          ? 'Payment confirmed'
          : submitting
            ? 'Confirming with Stripe…'
            : elementReady
              ? `Pay ${amountLabel}`
              : 'Loading secure payment fields…'}
      </button>
      {error === undefined ? null : (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {confirmedStatus === undefined ? null : (
        <p className="success-message" role="status">
          Stripe accepted the confirmation with status <strong>{confirmedStatus}</strong>. The
          signed webhook remains authoritative for the stored order.
        </p>
      )}
    </form>
  );
}

export function StripePaymentForm({
  clientSecret,
  amountLabel,
  stripe,
  returnUrl = defaultReturnUrl(),
  onConfirmed,
}: StripePaymentFormProps) {
  const options = useMemo<StripeElementsOptions>(
    () => ({
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#27685d',
          colorText: '#17212b',
          colorDanger: '#8a2929',
          borderRadius: '10px',
        },
      },
    }),
    [clientSecret],
  );

  return (
    <Elements key={clientSecret} stripe={stripe} options={options}>
      <ConfirmationForm amountLabel={amountLabel} returnUrl={returnUrl} onConfirmed={onConfirmed} />
    </Elements>
  );
}
