export const STRIPE_EVENT_ALLOWLIST: readonly string[];

export function stripeListenArguments(): readonly string[];

export function redactStripeOutput(value: string): string;
