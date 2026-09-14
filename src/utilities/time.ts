export class StageTimeoutError extends Error {
  public constructor(public readonly stage: string) {
    super(`Stage '${stage}' exceeded its time budget`);
    this.name = "StageTimeoutError";
  }
}

export async function withStageTimeout<T>(
  stage: string,
  timeoutMilliseconds: number | null,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const timeout =
    timeoutMilliseconds === null
      ? undefined
      : setTimeout(
          () => controller.abort(new StageTimeoutError(stage)),
          timeoutMilliseconds,
        );
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && error === controller.signal.reason) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function isFresh(
  observedAt: Date,
  maximumAgeSeconds: number,
  now = new Date(),
): boolean {
  const age = now.getTime() - observedAt.getTime();
  return age >= 0 && age <= maximumAgeSeconds * 1000;
}
