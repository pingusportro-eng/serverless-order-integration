export type RetryableInitializer<T> = () => Promise<T>;

export function createRetryableInitializer<T>(
  initialize: () => Promise<T>,
): RetryableInitializer<T> {
  let currentAttempt: Promise<T> | undefined;

  return () => {
    if (currentAttempt !== undefined) {
      return currentAttempt;
    }

    const attempt = initialize();
    currentAttempt = attempt;
    void attempt.catch(() => {
      if (currentAttempt === attempt) {
        currentAttempt = undefined;
      }
    });
    return attempt;
  };
}
