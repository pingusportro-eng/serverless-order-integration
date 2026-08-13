import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App.js';

describe('App', () => {
  it('presents the complete learning journey with only its first step ready', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1, name: 'Order Integration Lab' })).toBeVisible();
    expect(screen.getByText('Stripe sandbox learning console')).toBeVisible();

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
});
