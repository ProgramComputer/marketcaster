export interface RetryPolicy {
  readonly maximumRetries: number;
  readonly baseDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly isRetryable: (error: unknown) => boolean;
  readonly random?: () => number;
  readonly sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted", { cause: signal.reason });
}

export async function sleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}

export function fullJitterDelay(
  attempt: number,
  baseDelayMilliseconds: number,
  maximumDelayMilliseconds: number,
  random = Math.random,
): number {
  const cap = Math.min(
    maximumDelayMilliseconds,
    baseDelayMilliseconds * 2 ** attempt,
  );
  return Math.floor(random() * cap);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  const sleeper = policy.sleep ?? sleep;
  let attempt = 0;

  for (;;) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= policy.maximumRetries || !policy.isRetryable(error)) {
        throw error;
      }
      const delay = fullJitterDelay(
        attempt,
        policy.baseDelayMilliseconds,
        policy.maximumDelayMilliseconds,
        policy.random,
      );
      attempt += 1;
      await sleeper(delay, signal);
    }
  }
}
