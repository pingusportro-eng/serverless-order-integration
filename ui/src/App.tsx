import { useRef, useState } from 'react';

import type { OrdersApiClient } from './api/orders-api-client.js';
import {
  CreateOrderSubmission,
  type CreateOrderSubmissionSnapshot,
} from './create-order-submission.js';
import { defaultCreateOrderRequest } from './default-order.js';
import { PreparePaymentIntent, type PaymentPreparationSnapshot } from './prepare-payment-intent.js';

interface JourneyStep {
  readonly title: string;
  readonly description: string;
  readonly state: 'complete' | 'ready' | 'waiting';
}

export interface AppProps {
  readonly ordersApiClient: OrdersApiClient;
  readonly authMode: 'local-bypass' | 'cognito';
  readonly createId?: () => string;
}

function journey(orderCreated: boolean, paymentPrepared: boolean): readonly JourneyStep[] {
  return [
    {
      title: 'Create order',
      description: 'Send one authenticated, idempotent order request.',
      state: orderCreated ? 'complete' : 'ready',
    },
    {
      title: 'Prepare payment',
      description: 'Create or retrieve the order’s Stripe PaymentIntent.',
      state: paymentPrepared ? 'complete' : orderCreated ? 'ready' : 'waiting',
    },
    {
      title: 'Confirm payment',
      description: 'Enter a Stripe test card in the secure Payment Element.',
      state: paymentPrepared ? 'ready' : 'waiting',
    },
    {
      title: 'Verify payment',
      description: 'Observe the signed webhook update the stored order.',
      state: 'waiting',
    },
    {
      title: 'Track delivery',
      description: 'Follow the asynchronous provider journey to completion.',
      state: 'waiting',
    },
  ];
}

function paymentActionLabel(state: PaymentPreparationSnapshot['state']): string {
  switch (state) {
    case 'NOT_STARTED':
      return 'Prepare payment';
    case 'IN_FLIGHT':
      return 'Preparing payment…';
    case 'RETRYABLE':
      return 'Retry payment preparation';
    case 'SUCCEEDED':
      return 'Payment prepared';
    case 'REJECTED':
      return 'Preparation rejected';
  }
}

function actionLabel(state: CreateOrderSubmissionSnapshot['state']): string {
  switch (state) {
    case 'NOT_STARTED':
    case 'READY':
      return 'Create order';
    case 'IN_FLIGHT':
      return 'Creating order…';
    case 'OUTCOME_UNKNOWN':
      return 'Retry same operation';
    case 'SUCCEEDED':
      return 'Order created';
    case 'REJECTED':
      return 'Request rejected';
  }
}

export function App({ ordersApiClient, authMode, createId }: AppProps) {
  const submission = useRef<CreateOrderSubmission | undefined>(undefined);
  submission.current ??= new CreateOrderSubmission(ordersApiClient, createId);
  const paymentPreparation = useRef<PreparePaymentIntent | undefined>(undefined);
  paymentPreparation.current ??= new PreparePaymentIntent(ordersApiClient, createId);
  const [snapshot, setSnapshot] = useState<CreateOrderSubmissionSnapshot>(() => {
    const currentSubmission = submission.current;
    if (currentSubmission === undefined) {
      throw new Error('The create-order controller is missing.');
    }
    return currentSubmission.snapshot();
  });
  const [paymentSnapshot, setPaymentSnapshot] = useState<PaymentPreparationSnapshot>(() => {
    const currentPreparation = paymentPreparation.current;
    if (currentPreparation === undefined) {
      throw new Error('The payment-preparation controller is missing.');
    }
    return currentPreparation.snapshot();
  });
  const [merchantOrderId, setMerchantOrderId] = useState('pos-order-10042');

  const orderCreated = snapshot.order !== undefined;
  const paymentPrepared = paymentSnapshot.state === 'SUCCEEDED';
  const steps = journey(orderCreated, paymentPrepared);
  const canEdit = snapshot.state === 'NOT_STARTED';
  const canSubmit = snapshot.state === 'NOT_STARTED' || snapshot.state === 'OUTCOME_UNKNOWN';

  async function runCreateOrder(): Promise<void> {
    const currentSubmission = submission.current;
    if (currentSubmission === undefined) {
      return;
    }
    try {
      const pending =
        snapshot.state === 'OUTCOME_UNKNOWN'
          ? currentSubmission.retry()
          : currentSubmission.submit(defaultCreateOrderRequest(merchantOrderId));
      setSnapshot(currentSubmission.snapshot());
      await pending;
    } catch {
      // The controller exposes a safe message without leaking the response body.
    } finally {
      setSnapshot(currentSubmission.snapshot());
    }
  }

  function resetDraft(): void {
    submission.current?.reset();
    setSnapshot(submission.current?.snapshot() ?? { state: 'NOT_STARTED', attemptCount: 0 });
  }

  async function runPreparePayment(): Promise<void> {
    const currentPreparation = paymentPreparation.current;
    const order = snapshot.order;
    if (currentPreparation === undefined || order === undefined) {
      return;
    }
    try {
      const pending =
        paymentSnapshot.state === 'RETRYABLE'
          ? currentPreparation.retry()
          : currentPreparation.prepare(order.orderId);
      setPaymentSnapshot(currentPreparation.snapshot());
      await pending;
    } catch {
      // The controller exposes a safe message and never exposes the client secret in its snapshot.
    } finally {
      setPaymentSnapshot(currentPreparation.snapshot());
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Stripe sandbox learning console</p>
        <h1>Order Integration Lab</h1>
        <p className="hero-copy">
          Create an order, confirm its payment, and observe the asynchronous delivery journey.
        </p>
      </header>

      {authMode === 'local-bypass' ? (
        <aside className="auth-banner" role="status">
          <strong>Local auth bypass</strong>
          <span>
            Requests use the fixed <code>mrc_demo</code> identity. Cognito is not exercised locally.
          </span>
        </aside>
      ) : null}

      <section className="order-panel" aria-labelledby="create-order-title">
        <div>
          <p className="eyebrow">Step one</p>
          <h2 id="create-order-title">Create a synthetic order</h2>
          <p className="panel-copy">
            An ambiguous retry preserves both the request body and its idempotency key.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runCreateOrder();
          }}
        >
          <label htmlFor="merchant-order-id">Merchant order ID</label>
          <input
            id="merchant-order-id"
            value={merchantOrderId}
            disabled={!canEdit}
            minLength={1}
            maxLength={100}
            required
            onChange={(event) => {
              setMerchantOrderId(event.target.value);
            }}
          />

          <div className="order-summary">
            <span>Synthetic margherita pizza × 1</span>
            <strong>12.99 RON</strong>
          </div>

          <button type="submit" disabled={!canSubmit}>
            {actionLabel(snapshot.state)}
          </button>
          {snapshot.state === 'REJECTED' ? (
            <button className="secondary-button" type="button" onClick={resetDraft}>
              Reset rejected draft
            </button>
          ) : null}
        </form>

        <div className="operation-status" aria-live="polite">
          <dl>
            <div>
              <dt>Operation state</dt>
              <dd>{snapshot.state}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{snapshot.attemptCount}</dd>
            </div>
            {snapshot.idempotencyKey === undefined ? null : (
              <div>
                <dt>Idempotency key</dt>
                <dd>{snapshot.idempotencyKey}</dd>
              </div>
            )}
            {snapshot.correlationId === undefined ? null : (
              <div>
                <dt>Correlation ID</dt>
                <dd>{snapshot.correlationId}</dd>
              </div>
            )}
          </dl>
          {snapshot.error === undefined ? null : <p className="error-message">{snapshot.error}</p>}
          {snapshot.order === undefined ? null : (
            <p className="success-message">
              Created <strong>{snapshot.order.orderId}</strong> at version {snapshot.order.version}.
            </p>
          )}
        </div>
      </section>

      <section className="order-panel payment-panel" aria-labelledby="prepare-payment-title">
        <div>
          <p className="eyebrow">Step two</p>
          <h2 id="prepare-payment-title">Prepare the Stripe payment</h2>
          <p className="panel-copy">
            The server derives the amount and reuses one PaymentIntent for this order.
          </p>
        </div>

        <div className="payment-action">
          <button
            type="button"
            disabled={
              !orderCreated ||
              (paymentSnapshot.state !== 'NOT_STARTED' && paymentSnapshot.state !== 'RETRYABLE')
            }
            onClick={() => {
              void runPreparePayment();
            }}
          >
            {orderCreated ? paymentActionLabel(paymentSnapshot.state) : 'Create order first'}
          </button>
          <p>
            No browser idempotency key is needed: the order and server-derived Stripe key identify
            this operation.
          </p>
        </div>

        <div className="operation-status" aria-live="polite">
          <dl>
            <div>
              <dt>Preparation state</dt>
              <dd>{paymentSnapshot.state}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{paymentSnapshot.attemptCount}</dd>
            </div>
            {paymentSnapshot.stripePaymentIntentId === undefined ? null : (
              <div>
                <dt>PaymentIntent ID</dt>
                <dd>{paymentSnapshot.stripePaymentIntentId}</dd>
              </div>
            )}
            {paymentSnapshot.status === undefined ? null : (
              <div>
                <dt>Stripe status</dt>
                <dd>{paymentSnapshot.status}</dd>
              </div>
            )}
            {paymentSnapshot.amountLabel === undefined ? null : (
              <div>
                <dt>Amount</dt>
                <dd>{paymentSnapshot.amountLabel}</dd>
              </div>
            )}
            {paymentSnapshot.orderVersion === undefined ? null : (
              <div>
                <dt>Order version</dt>
                <dd>{paymentSnapshot.orderVersion}</dd>
              </div>
            )}
            {paymentSnapshot.correlationId === undefined ? null : (
              <div>
                <dt>Correlation ID</dt>
                <dd>{paymentSnapshot.correlationId}</dd>
              </div>
            )}
          </dl>
          {paymentSnapshot.error === undefined ? null : (
            <p className="error-message">{paymentSnapshot.error}</p>
          )}
          {paymentPrepared ? (
            <p className="success-message">Payment is ready for Stripe’s secure Payment Element.</p>
          ) : null}
        </div>
      </section>

      <section className="journey" aria-labelledby="journey-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current exercise</p>
            <h2 id="journey-title">Payment and delivery journey</h2>
          </div>
          <span className="environment-badge">
            {authMode === 'local-bypass' ? 'Local' : 'Cognito'}
          </span>
        </div>

        <ol className="journey-steps">
          {steps.map((step, index) => (
            <li className="journey-step" key={step.title}>
              <span className="step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
              <span className={`step-state step-state--${step.state}`}>
                {step.state === 'complete'
                  ? 'Complete'
                  : step.state === 'ready'
                    ? 'Ready'
                    : 'Waiting'}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
