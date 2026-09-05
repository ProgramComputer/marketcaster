import {
  APIError,
  InternalServerError,
  PolymarketUS,
  RateLimitError,
  type CancelOrderParams,
  type CreateOrderParams,
  type EventsListParams,
  type GetActivitiesParams,
  type GetOpenOrdersParams,
  type GetUserPositionsParams,
  type MarketsListParams,
  type PolymarketUSOptions,
  type PreviewOrderParams,
  type SeriesListParams,
} from "polymarket-us";
import pLimit, { type LimitFunction } from "p-limit";

export interface PolymarketUsClient {
  readonly events: {
    list(params?: EventsListParams): Promise<unknown>;
    retrieveBySlug(slug: string): Promise<unknown>;
  };
  readonly markets: {
    list(params?: MarketsListParams): Promise<unknown>;
    retrieve(id: number): Promise<unknown>;
    retrieveBySlug(slug: string): Promise<unknown>;
    book(slug: string): Promise<unknown>;
    bbo(slug: string): Promise<unknown>;
    settlement(slug: string): Promise<unknown>;
  };
  readonly orders: {
    create(params: CreateOrderParams): Promise<unknown>;
    list(params?: GetOpenOrdersParams): Promise<unknown>;
    retrieve(orderId: string): Promise<unknown>;
    cancel(orderId: string, params: CancelOrderParams): Promise<void>;
    preview(params: PreviewOrderParams): Promise<unknown>;
  };
  readonly portfolio: {
    positions(params?: GetUserPositionsParams): Promise<unknown>;
    activities(params?: GetActivitiesParams): Promise<unknown>;
  };
  readonly account: {
    balances(): Promise<unknown>;
  };
  readonly series: {
    list(params?: SeriesListParams): Promise<unknown>;
  };
}

export interface ReadRetryOptions {
  readonly maximumRetries?: number;
  readonly baseDelayMilliseconds?: number;
  readonly maximumDelayMilliseconds?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RequestGateOptions {
  readonly maximumConcurrentRequests: number;
  readonly targetRequestsPerSecond: number;
  readonly nowMilliseconds?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * A per-client start-rate and concurrency gate. Each retry must call run again so
 * failed attempts consume capacity just like successful requests.
 */
export class PolymarketRequestGate {
  private readonly concurrency: LimitFunction;
  private readonly intervalMilliseconds: number;
  private readonly nowMilliseconds: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private startQueue: Promise<void> = Promise.resolve();
  private nextStartMilliseconds = 0;

  public constructor(options: RequestGateOptions) {
    this.concurrency = pLimit(options.maximumConcurrentRequests);
    this.intervalMilliseconds = 1_000 / options.targetRequestsPerSecond;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async reserveStart(): Promise<void> {
    const reservation = this.startQueue.then(async () => {
      const delay = Math.max(
        0,
        this.nextStartMilliseconds - this.nowMilliseconds(),
      );
      if (delay > 0) await this.sleep(delay);
      const startedAt = this.nowMilliseconds();
      this.nextStartMilliseconds = Math.max(
        this.nextStartMilliseconds + this.intervalMilliseconds,
        startedAt + this.intervalMilliseconds,
      );
    });
    this.startQueue = reservation.catch(() => undefined);
    await reservation;
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    return this.concurrency(async () => {
      await this.reserveStart();
      return operation();
    });
  }
}

export function createPolymarketUsClient(
  options: PolymarketUSOptions = {},
): PolymarketUsClient {
  // All SDK return values deliberately cross the adapter boundary as unknown.
  return new PolymarketUS(options);
}

function errorChain(error: unknown): readonly object[] {
  const chain: object[] = [];
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return chain;
}

function errorCode(error: unknown): string | undefined {
  for (const item of errorChain(error)) {
    if (!("code" in item)) continue;
    const value = item.code;
    if (typeof value === "string") return value.toUpperCase();
  }
  return undefined;
}

export function isRetryableReadError(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof InternalServerError) {
    return true;
  }
  if (
    error instanceof APIError &&
    [429, 502, 503, 504].includes(error.status)
  ) {
    return true;
  }
  const code = errorCode(error);
  return (
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    errorChain(error).some(
      (item) =>
        item instanceof Error &&
        (item.name === "AbortError" || item.message === "fetch failed"),
    )
  );
}

export async function readWithRetry<T>(
  operation: () => Promise<T>,
  options: ReadRetryOptions = {},
): Promise<T> {
  const maximumRetries = options.maximumRetries ?? 3;
  const baseDelayMilliseconds = options.baseDelayMilliseconds ?? 500;
  const maximumDelayMilliseconds = options.maximumDelayMilliseconds ?? 4_000;
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maximumRetries || !isRetryableReadError(error)) {
        throw error;
      }
      const ceiling = Math.min(
        maximumDelayMilliseconds,
        baseDelayMilliseconds * 2 ** attempt,
      );
      await sleep(Math.floor(random() * ceiling));
    }
  }
}
