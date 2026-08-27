import { describe, expect, it, vi } from 'vitest';

import { createRetryableInitializer } from '../../src/lambda/retryable-initializer.js';

describe('retryable Lambda initializer', () => {
  it('shares an in-flight attempt and retains its warm result', async () => {
    const handler = vi.fn();
    let resolveAttempt: ((value: typeof handler) => void) | undefined;
    const initialize = vi.fn(
      () =>
        new Promise<typeof handler>((resolve) => {
          resolveAttempt = resolve;
        }),
    );
    const getInitialized = createRetryableInitializer(initialize);

    const first = getInitialized();
    const second = getInitialized();
    resolveAttempt?.(handler);

    await expect(Promise.all([first, second])).resolves.toEqual([handler, handler]);
    await expect(getInitialized()).resolves.toBe(handler);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('permits another attempt after initialization fails', async () => {
    let attempts = 0;
    const initialize = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('temporary initialization failure'))
        : Promise.resolve('initialized');
    });
    const getInitialized = createRetryableInitializer(initialize);

    await expect(getInitialized()).rejects.toThrow('temporary initialization failure');
    await expect(getInitialized()).resolves.toBe('initialized');
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
