import { constants, sign as cryptoSign } from "node:crypto";

import pLimit, { type LimitFunction } from "p-limit";

export const DEFAULT_KALSHI_BASE_URL =
  "https://external-api.kalshi.com/trade-api/v2";
const OFFICIAL_KALSHI_API_HOSTS = new Set([
  "external-api.kalshi.com",
  "api.elections.kalshi.com",
  "external-api.demo.kalshi.co",
  "demo-api.kalshi.co",
]);

type QueryValue = string | number | boolean | undefined;
type QueryParameters = Readonly<Record<string, QueryValue>>;

export interface KalshiMarketListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly event_ticker?: string;
  readonly series_ticker?: string;
  readonly status?: "unopened" | "open" | "paused" | "closed" | "settled";
  readonly tickers?: string;
  readonly mve_filter?: "only" | "exclude";
  readonly min_created_ts?: number;
  readonly max_created_ts?: number;
  readonly min_close_ts?: number;
  readonly max_close_ts?: number;
  readonly min_settled_ts?: number;
  readonly max_settled_ts?: number;
  readonly min_updated_ts?: number;
}

export interface KalshiHistoricalMarketListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly tickers?: string;
  readonly event_ticker?: string;
  readonly series_ticker?: string;
  readonly mve_filter?: "exclude";
}

export interface KalshiMarketCandlesticksParams extends QueryParameters {
  readonly market_tickers: string;
  readonly start_ts: number;
  readonly end_ts: number;
  readonly period_interval: number;
  readonly include_latest_before_start?: boolean;
}

export interface KalshiHistoricalMarketCandlesticksParams extends QueryParameters {
  readonly start_ts: number;
  readonly end_ts: number;
  readonly period_interval: 1 | 60 | 1440;
}

export interface KalshiSeriesListParams extends QueryParameters {
  readonly category?: string;
  readonly tags?: string;
  readonly include_product_metadata?: boolean;
  readonly include_volume?: boolean;
  readonly min_updated_ts?: number;
}

export interface KalshiSeriesFeeChangeParams extends QueryParameters {
  readonly series_ticker?: string;
  readonly show_historical?: boolean;
}

export interface KalshiEventFeeChangeParams extends QueryParameters {
  readonly event_ticker?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface KalshiPositionListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly count_filter?: string;
  readonly ticker?: string;
  readonly event_ticker?: string;
  readonly subaccount?: number;
}

export interface KalshiOrderListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly ticker?: string;
  readonly event_ticker?: string;
  readonly status?: "resting" | "canceled" | "executed";
  readonly min_ts?: number;
  readonly max_ts?: number;
  readonly subaccount?: number;
}

export interface KalshiFillListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly ticker?: string;
  readonly order_id?: string;
  readonly min_ts?: number;
  readonly max_ts?: number;
  readonly subaccount?: number;
}

export interface KalshiHistoricalFillListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly ticker?: string;
  readonly max_ts?: number;
}

export interface KalshiTransferListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface KalshiSettlementListParams extends QueryParameters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly ticker?: string;
  readonly event_ticker?: string;
  readonly min_ts?: number;
  readonly max_ts?: number;
  readonly subaccount?: number;
}

export interface KalshiCreateOrderParams {
  readonly ticker: string;
  readonly client_order_id: string;
  readonly side: "bid" | "ask";
  readonly count: string;
  readonly price: string;
  readonly time_in_force:
    "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel";
  readonly self_trade_prevention_type: "taker_at_cross" | "maker";
  readonly expiration_time?: number;
  readonly post_only?: boolean;
  readonly cancel_order_on_pause?: boolean;
  readonly reduce_only?: boolean;
  readonly subaccount?: number;
  readonly order_group_id?: string;
  readonly exchange_index?: number;
}

export interface KalshiCancelOrderParams extends QueryParameters {
  readonly subaccount?: number;
  readonly exchange_index?: number;
}

export interface KalshiClient {
  listMarkets(params?: KalshiMarketListParams): Promise<unknown>;
  getMarket(ticker: string): Promise<unknown>;
  getEvent(eventTicker: string): Promise<unknown>;
  listSeries(params?: KalshiSeriesListParams): Promise<unknown>;
  getSeries(seriesTicker: string): Promise<unknown>;
  getSeriesFeeChanges(params?: KalshiSeriesFeeChangeParams): Promise<unknown>;
  getEventFeeChanges(params?: KalshiEventFeeChangeParams): Promise<unknown>;
  listHistoricalMarkets(
    params?: KalshiHistoricalMarketListParams,
  ): Promise<unknown>;
  getHistoricalMarket(ticker: string): Promise<unknown>;
  getOrderBook(ticker: string, depth?: number): Promise<unknown>;
  getMarketCandlesticks(
    params: KalshiMarketCandlesticksParams,
  ): Promise<unknown>;
  getHistoricalMarketCandlesticks(
    ticker: string,
    params: KalshiHistoricalMarketCandlesticksParams,
  ): Promise<unknown>;
  getBalance(subaccount?: number, exchangeIndex?: number): Promise<unknown>;
  getPositions(params?: KalshiPositionListParams): Promise<unknown>;
  getOrders(params?: KalshiOrderListParams): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  getFills(params?: KalshiFillListParams): Promise<unknown>;
  getHistoricalCutoff(): Promise<unknown>;
  getHistoricalFills(params?: KalshiHistoricalFillListParams): Promise<unknown>;
  getDeposits(params?: KalshiTransferListParams): Promise<unknown>;
  getWithdrawals(params?: KalshiTransferListParams): Promise<unknown>;
  getSettlements(params?: KalshiSettlementListParams): Promise<unknown>;
  createOrder(params: KalshiCreateOrderParams): Promise<unknown>;
  cancelOrder(
    orderId: string,
    params?: KalshiCancelOrderParams,
  ): Promise<unknown>;
}

export type KalshiSigner = (privateKey: string, message: string) => string;

export interface KalshiClientOptions {
  readonly apiKeyId: string;
  readonly privateKey: string;
  readonly baseUrl?: string;
  readonly allowUnsafeBaseUrl?: boolean;
  readonly fetch?: typeof fetch;
  readonly nowMilliseconds?: () => number;
  readonly requestTimeoutMilliseconds?: number;
  readonly signer?: KalshiSigner;
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

function nonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} cannot be empty`);
  }
  return normalized;
}

function normalizedBaseUrl(value: string, allowUnsafe: boolean): string {
  const withoutTrailingSlashes = value.replace(/\/+$/u, "");
  const url = new URL(withoutTrailingSlashes);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Kalshi baseUrl must use HTTP or HTTPS");
  }
  if (!url.pathname.endsWith("/trade-api/v2")) {
    throw new TypeError("Kalshi baseUrl must end with /trade-api/v2");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError("Kalshi baseUrl cannot contain a query or fragment");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("Kalshi baseUrl cannot contain authentication details");
  }
  if (
    !allowUnsafe &&
    (url.protocol !== "https:" ||
      url.port.length > 0 ||
      !OFFICIAL_KALSHI_API_HOSTS.has(url.hostname) ||
      url.pathname !== "/trade-api/v2")
  ) {
    throw new TypeError(
      "Kalshi baseUrl must be an official HTTPS Trade API v2 endpoint",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function defaultSigner(privateKey: string, message: string): string {
  return cryptoSign("sha256", Buffer.from(message, "utf8"), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

function errorDetails(body: unknown): {
  readonly code?: string;
  readonly message?: string;
} {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined;
  const code =
    (typeof nested?.code === "string" ? nested.code : undefined) ??
    (typeof record.code === "string" ? record.code : undefined);
  const message =
    (typeof nested?.message === "string" ? nested.message : undefined) ??
    (typeof record.message === "string" ? record.message : undefined);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

export class KalshiHttpError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: unknown,
    public readonly exchangeCode?: string,
  ) {
    super(message);
    this.name = "KalshiHttpError";
  }
}

function queryString(params: QueryParameters | undefined): string {
  if (params === undefined) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}

function parseBody(contents: string): unknown {
  if (contents.length === 0) return undefined;
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return contents;
  }
}

class FetchKalshiClient implements KalshiClient {
  private readonly apiKeyId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly nowMilliseconds: () => number;
  private readonly requestTimeoutMilliseconds: number;
  private readonly signer: KalshiSigner;

  public constructor(options: KalshiClientOptions) {
    this.apiKeyId = nonEmpty(options.apiKeyId, "apiKeyId");
    this.privateKey = nonEmpty(
      options.privateKey.replace(/\\n/gu, "\n"),
      "privateKey",
    );
    this.baseUrl = normalizedBaseUrl(
      options.baseUrl ?? DEFAULT_KALSHI_BASE_URL,
      options.allowUnsafeBaseUrl === true,
    );
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? 15_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMilliseconds) ||
      this.requestTimeoutMilliseconds <= 0
    ) {
      throw new RangeError(
        "requestTimeoutMilliseconds must be a positive safe integer",
      );
    }
    this.signer = options.signer ?? defaultSigner;
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      readonly query?: QueryParameters;
      readonly body?: unknown;
    } = {},
  ): Promise<unknown> {
    const pathWithQuery = `${path}${queryString(options.query)}`;
    const url = new URL(`${this.baseUrl}${pathWithQuery}`);
    const timestamp = String(Math.trunc(this.nowMilliseconds()));
    const signingPath = url.pathname;
    const signature = this.signer(
      this.privateKey,
      `${timestamp}${method}${signingPath}`,
    );
    const headers: Record<string, string> = {
      "KALSHI-ACCESS-KEY": this.apiKeyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await this.fetchImplementation(url, {
      method,
      headers,
      // Never forward signed Kalshi headers through an HTTP redirect.
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMilliseconds),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const responseBody = parseBody(await response.text());
    if (!response.ok) {
      const details = errorDetails(responseBody);
      const message =
        details.message ??
        `Kalshi request failed with HTTP status ${response.status}`;
      throw new KalshiHttpError(
        message,
        response.status,
        responseBody,
        details.code,
      );
    }
    return responseBody;
  }

  public listMarkets(params?: KalshiMarketListParams): Promise<unknown> {
    return this.request("GET", "/markets", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getMarket(ticker: string): Promise<unknown> {
    return this.request("GET", `/markets/${encodeURIComponent(ticker)}`);
  }

  public getEvent(eventTicker: string): Promise<unknown> {
    return this.request("GET", `/events/${encodeURIComponent(eventTicker)}`);
  }

  public listSeries(params?: KalshiSeriesListParams): Promise<unknown> {
    return this.request("GET", "/series", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getSeries(seriesTicker: string): Promise<unknown> {
    return this.request("GET", `/series/${encodeURIComponent(seriesTicker)}`);
  }

  public getSeriesFeeChanges(
    params?: KalshiSeriesFeeChangeParams,
  ): Promise<unknown> {
    return this.request("GET", "/series/fee_changes", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getEventFeeChanges(
    params?: KalshiEventFeeChangeParams,
  ): Promise<unknown> {
    return this.request("GET", "/events/fee_changes", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public listHistoricalMarkets(
    params?: KalshiHistoricalMarketListParams,
  ): Promise<unknown> {
    return this.request("GET", "/historical/markets", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getHistoricalMarket(ticker: string): Promise<unknown> {
    return this.request(
      "GET",
      `/historical/markets/${encodeURIComponent(ticker)}`,
    );
  }

  public getOrderBook(ticker: string, depth?: number): Promise<unknown> {
    return this.request(
      "GET",
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      {
        ...(depth === undefined ? {} : { query: { depth } }),
      },
    );
  }

  public getMarketCandlesticks(
    params: KalshiMarketCandlesticksParams,
  ): Promise<unknown> {
    return this.request("GET", "/markets/candlesticks", { query: params });
  }

  public getHistoricalMarketCandlesticks(
    ticker: string,
    params: KalshiHistoricalMarketCandlesticksParams,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/historical/markets/${encodeURIComponent(ticker)}/candlesticks`,
      { query: params },
    );
  }

  public getBalance(
    subaccount?: number,
    exchangeIndex?: number,
  ): Promise<unknown> {
    return this.request("GET", "/portfolio/balance", {
      ...(subaccount === undefined && exchangeIndex === undefined
        ? {}
        : {
            query: {
              subaccount,
              exchange_index: exchangeIndex,
            },
          }),
    });
  }

  public getPositions(params?: KalshiPositionListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/positions", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getOrders(params?: KalshiOrderListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/orders", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getOrder(orderId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/portfolio/orders/${encodeURIComponent(orderId)}`,
    );
  }

  public getFills(params?: KalshiFillListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/fills", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getHistoricalCutoff(): Promise<unknown> {
    return this.request("GET", "/historical/cutoff");
  }

  public getHistoricalFills(
    params?: KalshiHistoricalFillListParams,
  ): Promise<unknown> {
    return this.request("GET", "/historical/fills", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getDeposits(params?: KalshiTransferListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/deposits", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getWithdrawals(params?: KalshiTransferListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/withdrawals", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public getSettlements(params?: KalshiSettlementListParams): Promise<unknown> {
    return this.request("GET", "/portfolio/settlements", {
      ...(params === undefined ? {} : { query: params }),
    });
  }

  public createOrder(params: KalshiCreateOrderParams): Promise<unknown> {
    return this.request("POST", "/portfolio/events/orders", { body: params });
  }

  public cancelOrder(
    orderId: string,
    params?: KalshiCancelOrderParams,
  ): Promise<unknown> {
    return this.request(
      "DELETE",
      `/portfolio/events/orders/${encodeURIComponent(orderId)}`,
      { ...(params === undefined ? {} : { query: params }) },
    );
  }
}

export function createKalshiClient(options: KalshiClientOptions): KalshiClient {
  return new FetchKalshiClient(options);
}

export class KalshiRequestGate {
  private readonly concurrency: LimitFunction;
  private readonly intervalMilliseconds: number;
  private readonly nowMilliseconds: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private startQueue: Promise<void> = Promise.resolve();
  private nextStartMilliseconds = 0;

  public constructor(options: RequestGateOptions) {
    if (
      !Number.isSafeInteger(options.maximumConcurrentRequests) ||
      options.maximumConcurrentRequests <= 0
    ) {
      throw new RangeError(
        "maximumConcurrentRequests must be a positive integer",
      );
    }
    if (
      !Number.isFinite(options.targetRequestsPerSecond) ||
      options.targetRequestsPerSecond <= 0
    ) {
      throw new RangeError(
        "targetRequestsPerSecond must be positive and finite",
      );
    }
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    if (typeof error === "object" && error !== null && "cause" in error) {
      return error.cause === error ? undefined : errorCode(error.cause);
    }
    return undefined;
  }
  const value = error.code;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

export function isRetryableReadError(error: unknown): boolean {
  if (error instanceof KalshiHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const code = errorCode(error);
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
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

export const kalshiReadWithRetry = readWithRetry;
export const isRetryableKalshiReadError = isRetryableReadError;
