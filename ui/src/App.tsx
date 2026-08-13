interface JourneyStep {
  readonly title: string;
  readonly description: string;
  readonly state: 'ready' | 'waiting';
}

const INITIAL_JOURNEY: readonly JourneyStep[] = [
  {
    title: 'Create order',
    description: 'Send one authenticated, idempotent order request.',
    state: 'ready',
  },
  {
    title: 'Prepare payment',
    description: 'Create or retrieve the order’s Stripe PaymentIntent.',
    state: 'waiting',
  },
  {
    title: 'Confirm payment',
    description: 'Enter a Stripe test card in the secure Payment Element.',
    state: 'waiting',
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

export function App() {
  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Stripe sandbox learning console</p>
        <h1>Order Integration Lab</h1>
        <p className="hero-copy">
          Create an order, confirm its payment, and observe the asynchronous delivery journey.
        </p>
      </header>

      <section className="journey" aria-labelledby="journey-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current exercise</p>
            <h2 id="journey-title">Payment and delivery journey</h2>
          </div>
          <span className="environment-badge">Local</span>
        </div>

        <ol className="journey-steps">
          {INITIAL_JOURNEY.map((step, index) => (
            <li className="journey-step" key={step.title}>
              <span className="step-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
              <span className={`step-state step-state--${step.state}`}>
                {step.state === 'ready' ? 'Ready' : 'Waiting'}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
