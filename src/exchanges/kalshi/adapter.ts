import { randomUUID } from "node:crypto";

import { Decimal } from "decimal.js";
import pLimit from "p-limit";

import type { AccountSnapshot } from "../../domain/account.js";
import type { AccountActivity, ActivityQuery } from "../../domain/activity.js";
import type { ExecutionResult } from "../../domain/execution.js";
import type {
  Market,
  MarketBbo,
  MarketGroupQuery,
  MarketHistory,
  MarketHistoryQuery,
  MarketQuery,
  OrderBook,
  SettlementStatus,
} from "../../domain/market.js";
import type {
  ExchangeOrder,
  ImmediateOrder,
  OrderPreview,
  OrderPreviewPurpose,
} from "../../domain/order.js";
import type { Position } from "../../domain/position.js";
import type { MarketId, Page } from "../../domain/primitives.js";
import { estimateKalshiTakerFeeUpperBound } from "../../risk/edge.js";
import { ExchangeError, type PredictionExchange } from "../exchange.js";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../memory-scope.js";
import {
  createKalshiClient,
  KalshiHttpError,
  KalshiRequestGate,
  readWithRetry,
  type KalshiClient,
  type KalshiClientOptions,
  type KalshiCreateOrderParams,
  type ReadRetryOptions,
} from "./client.js";
import {
  isValidKalshiYesPrice,
  mapBbo,
  mapCreateOrderResult,
  mapDeposit,
  mapFill,
  mapMarket,
  mapOrder,
  mapOrderBook,
  mapPosition,
  mapResolution,
  mapSettlement,
  mapWithdrawal,
} from "./mappers.js";
import {
  KalshiBalanceResponseSchema,
  KalshiCancelOrderResponseSchema,
  KalshiCreateOrderResponseSchema,
  KalshiDepositsResponseSchema,
  KalshiEventFeeChangesResponseSchema,
  KalshiEventResponseSchema,
  KalshiFillsResponseSchema,
  KalshiHistoricalCutoffSchema,
  KalshiHistoricalFillsResponseSchema,
  KalshiHistoricalMarketCandlesticksResponseSchema,
  KalshiHistoricalMarketResponseSchema,
  KalshiHistoricalMarketsResponseSchema,
  KalshiMarketResponseSchema,
  KalshiMarketCandlesticksResponseSchema,
  KalshiMarketsResponseSchema,
  KalshiOrderBookResponseSchema,
  KalshiOrderResponseSchema,
  KalshiOrdersResponseSchema,
  KalshiPositionsResponseSchema,
  KalshiSettlementsResponseSchema,
  KalshiSeriesFeeChangesResponseSchema,
  KalshiSeriesListResponseSchema,
  KalshiSeriesResponseSchema,
  KalshiWithdrawalsResponseSchema,
  parseKalshiResponse,
  type KalshiCandlestick,
  type KalshiMarket,
} from "./schemas.js";
import { canonicalOrderToKalshi } from "./side-conversion.js";

export const KALSHI_EXCHANGE_ID = "kalshi" as const;

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 1_000;
const DEFAULT_MAXIMUM_PAGES = 1_000;
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 4;
const DEFAULT_TARGET_REQUESTS_PER_SECOND = 8;
const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 30;
const DEFAULT_FEE_PREVIEW_VALIDITY_MILLISECONDS = 30_000;
const FEE_CHANGE_GUARD_MILLISECONDS = 30_000;
const ZERO = new Decimal(0);
const CONTRACT_GRANULARITY = new Decimal("0.01");
const ARCHIVED_CURSOR_PREFIX = "kalshi-archived-v1:";

interface ArchivedMarketCursor {
  readonly tier: "live" | "historical";
  readonly cursor?: string;
}

function encodeArchivedMarketCursor(
  tier: ArchivedMarketCursor["tier"],
  cursor?: string,
): string {
  return `${ARCHIVED_CURSOR_PREFIX}${tier}:${encodeURIComponent(cursor ?? "")}`;
}

function decodeArchivedMarketCursor(
  cursor: string | undefined,
): ArchivedMarketCursor {
  if (cursor === undefined) return { tier: "live" };
  if (!cursor.startsWith(ARCHIVED_CURSOR_PREFIX)) {
    throw new ExchangeError(
      "Archived Kalshi market cursor is invalid",
      "INVALID_REQUEST",
    );
  }
  const encoded = cursor.slice(ARCHIVED_CURSOR_PREFIX.length);
  const separator = encoded.indexOf(":");
  const tier = encoded.slice(0, separator);
  if (separator < 0 || (tier !== "live" && tier !== "historical")) {
    throw new ExchangeError(
      "Archived Kalshi market cursor is invalid",
      "INVALID_REQUEST",
    );
  }
  try {
    const value = decodeURIComponent(encoded.slice(separator + 1));
    return {
      tier,
      ...(value.length === 0 ? {} : { cursor: value }),
    };
  } catch {
    throw new ExchangeError(
      "Archived Kalshi market cursor is invalid",
      "INVALID_REQUEST",
    );
  }
}

export interface KalshiExchangeOptions {
  readonly client?: KalshiClient;
  readonly clientOptions?: KalshiClientOptions;
  readonly memoryScope?: string;
  readonly readRetry?: ReadRetryOptions;
  readonly pageSize?: number;
  readonly maximumPaginationPages?: number;
  readonly maximumConcurrentRequests?: number;
  readonly targetRequestsPerSecond?: number;
  readonly activityLookbackDays?: number;
  readonly feePreviewValidityMilliseconds?: number;
  readonly now?: () => Date;
  readonly createClientOrderId?: () => string;
}

interface PreparedOrder {
  readonly request: KalshiCreateOrderParams;
  readonly market: Market;
  readonly feeTerms: EffectiveFeeTerms;
}

type SupportedKalshiFeeType = "quadratic" | "quadratic_with_maker_fees";

interface EffectiveFeeTerms {
  readonly type: SupportedKalshiFeeType;
  readonly multiplier: Decimal;
  readonly validUntilMilliseconds?: number;
}

interface PreviewedFeeTerms extends EffectiveFeeTerms {
  readonly expiresAtMilliseconds: number;
}

function feePreviewKey(order: ImmediateOrder): string {
  return JSON.stringify([
    order.marketId.exchange,
    order.marketId.value,
    order.marketSlug,
    order.side,
    order.action,
    order.canonicalLimitPrice.toFixed(),
    order.quantity.toFixed(),
  ]);
}

function rejectedExecution(reason: string): ExecutionResult {
  return {
    status: "REJECTED",
    filledQuantity: ZERO,
    fees: ZERO,
    finalState: "REJECTED",
    rejectionReason: reason,
  };
}

function supportedFeeType(value: string): SupportedKalshiFeeType {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "quadratic" ||
    normalized === "quadratic_with_maker_fees"
  ) {
    return normalized;
  }
  throw new ExchangeError(
    `Kalshi fee type '${value}' is not supported for safe IOC estimation`,
    "UNSUPPORTED",
  );
}

function feeTermsEqual(
  left: EffectiveFeeTerms,
  right: EffectiveFeeTerms,
): boolean {
  return left.type === right.type && left.multiplier.eq(right.multiplier);
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function mapCandlesticks(candles: readonly KalshiCandlestick[]) {
  return candles
    .map((candle) => ({
      endedAt: new Date(candle.end_period_ts * 1_000),
      ...optional("open", candle.price.open_dollars),
      ...optional("high", candle.price.high_dollars),
      ...optional("low", candle.price.low_dollars),
      ...optional("close", candle.price.close_dollars),
      ...optional("previousClose", candle.price.previous_dollars),
      ...optional("volume", candle.volume_fp),
      ...optional("openInterest", candle.open_interest_fp),
    }))
    .toSorted(
      (left, right) => left.endedAt.getTime() - right.endedAt.getTime(),
    );
}

function historicalCandlestickInterval(intervalMinutes: number): 1 | 60 | 1440 {
  if (intervalMinutes <= 1) return 1;
  if (intervalMinutes < 1440) return 60;
  return 1440;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExchangeError(
      `${fieldName} must be a positive safe integer`,
      "INVALID_REQUEST",
    );
  }
  return value;
}

function positiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ExchangeError(
      `${fieldName} must be positive and finite`,
      "INVALID_REQUEST",
    );
  }
  return value;
}

function assertKalshiId(id: MarketId): void {
  if (id.exchange !== KALSHI_EXCHANGE_ID) {
    throw new ExchangeError(
      `Expected a kalshi market ID, received ${id.exchange}`,
      "INVALID_REQUEST",
    );
  }
  if (id.value.trim().length === 0) {
    throw new ExchangeError("Market ID cannot be empty", "INVALID_REQUEST");
  }
}

function transientErrorCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const direct =
    "code" in error && typeof error.code === "string"
      ? error.code.toUpperCase()
      : undefined;
  if (
    direct !== undefined &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENETUNREACH",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(direct)
  ) {
    return true;
  }
  return "cause" in error && transientErrorCode(error.cause);
}

export function normalizeKalshiError(
  error: unknown,
  operation: string,
): ExchangeError {
  if (error instanceof ExchangeError) return error;
  const options = { cause: error };
  if (error instanceof KalshiHttpError) {
    if (error.status === 401 || error.status === 403) {
      return new ExchangeError(
        `${operation}: authentication failed`,
        "AUTHENTICATION",
        options,
      );
    }
    if (error.status === 404) {
      return new ExchangeError(
        `${operation}: resource not found`,
        "NOT_FOUND",
        options,
      );
    }
    if (error.status === 429) {
      return new ExchangeError(
        `${operation}: rate limited`,
        "RATE_LIMITED",
        options,
      );
    }
    if (error.status === 408 || error.status >= 500) {
      return new ExchangeError(
        `${operation}: exchange unavailable`,
        "TRANSIENT",
        options,
      );
    }
    if (error.status >= 400 && error.status < 500) {
      return new ExchangeError(
        `${operation}: invalid request`,
        "INVALID_REQUEST",
        options,
      );
    }
  }
  if (
    transientErrorCode(error) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return new ExchangeError(
      `${operation}: transient connection failure`,
      "TRANSIENT",
      options,
    );
  }
  return new ExchangeError(
    `${operation}: unknown exchange failure`,
    "UNKNOWN",
    options,
  );
}

function dateForActivity(activity: AccountActivity): Date {
  return activity.kind === "TRADE"
    ? activity.createdAt
    : activity.kind === "RESOLUTION"
      ? activity.resolvedAt
      : activity.createdAt;
}

export class KalshiExchange implements PredictionExchange {
  public readonly id = KALSHI_EXCHANGE_ID;
  public readonly memoryScope: string;

  private readonly client: KalshiClient;
  private readonly readRetry: ReadRetryOptions;
  private readonly pageSize: number;
  private readonly maximumPaginationPages: number;
  private readonly maximumConcurrentRequests: number;
  private readonly requestGate: KalshiRequestGate;
  private readonly activityLookbackDays: number;
  private readonly feePreviewValidityMilliseconds: number;
  private readonly now: () => Date;
  private readonly createClientOrderId: () => string;
  private readonly marketByTicker = new Map<string, Market>();
  private readonly tagMarketSlugs = new Map<
    string,
    Promise<readonly string[]>
  >();
  private readonly orderBookInFlight = new Map<string, Promise<OrderBook>>();
  private readonly feeTermsInFlight = new Map<
    string,
    Promise<EffectiveFeeTerms>
  >();
  private readonly previewedFeeTermsByOrder = new Map<
    string,
    PreviewedFeeTerms
  >();

  public constructor(options: KalshiExchangeOptions) {
    this.memoryScope = assertSafeMemoryScope(
      options.memoryScope ?? UNSCOPED_MEMORY_SCOPE,
    );
    if (options.client !== undefined && options.clientOptions !== undefined) {
      throw new ExchangeError(
        "Provide either a Kalshi client or client options, not both",
        "INVALID_REQUEST",
      );
    }
    if (options.client === undefined && options.clientOptions === undefined) {
      throw new ExchangeError(
        "Kalshi client options are required",
        "AUTHENTICATION",
      );
    }
    this.client =
      options.client ??
      createKalshiClient(
        options.clientOptions ??
          (() => {
            throw new ExchangeError(
              "Kalshi client options are required",
              "AUTHENTICATION",
            );
          })(),
      );
    this.readRetry = options.readRetry ?? {};
    this.pageSize = positiveInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      "pageSize",
    );
    if (this.pageSize > MAXIMUM_PAGE_SIZE) {
      throw new ExchangeError(
        `pageSize cannot exceed ${MAXIMUM_PAGE_SIZE}`,
        "INVALID_REQUEST",
      );
    }
    this.maximumPaginationPages = positiveInteger(
      options.maximumPaginationPages ?? DEFAULT_MAXIMUM_PAGES,
      "maximumPaginationPages",
    );
    this.maximumConcurrentRequests = positiveInteger(
      options.maximumConcurrentRequests ?? DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
      "maximumConcurrentRequests",
    );
    const targetRequestsPerSecond = positiveFinite(
      options.targetRequestsPerSecond ?? DEFAULT_TARGET_REQUESTS_PER_SECOND,
      "targetRequestsPerSecond",
    );
    this.requestGate = new KalshiRequestGate({
      maximumConcurrentRequests: this.maximumConcurrentRequests,
      targetRequestsPerSecond,
    });
    this.activityLookbackDays = positiveInteger(
      options.activityLookbackDays ?? DEFAULT_ACTIVITY_LOOKBACK_DAYS,
      "activityLookbackDays",
    );
    this.feePreviewValidityMilliseconds = positiveInteger(
      options.feePreviewValidityMilliseconds ??
        DEFAULT_FEE_PREVIEW_VALIDITY_MILLISECONDS,
      "feePreviewValidityMilliseconds",
    );
    this.now = options.now ?? (() => new Date());
    this.createClientOrderId = options.createClientOrderId ?? randomUUID;
  }

  private async safeRead<T>(operation: () => Promise<T>): Promise<T> {
    return readWithRetry(() => this.requestGate.run(operation), this.readRetry);
  }

  private rememberMarket(value: KalshiMarket): Market {
    const market = mapMarket(value);
    this.marketByTicker.set(value.ticker, market);
    return market;
  }

  private async loadRawMarket(ticker: string): Promise<KalshiMarket> {
    // Market state is safety-sensitive. Always refresh this endpoint; the
    // mapped cache below is for identity handoff, not freshness.
    let raw: unknown;
    let historical = false;
    try {
      raw = await this.safeRead(() => this.client.getMarket(ticker));
    } catch (error) {
      if (!(error instanceof KalshiHttpError) || error.status !== 404) {
        throw error;
      }
      historical = true;
      raw = await this.safeRead(() => this.client.getHistoricalMarket(ticker));
    }
    const response = parseKalshiResponse(
      historical
        ? KalshiHistoricalMarketResponseSchema
        : KalshiMarketResponseSchema,
      raw,
      "market detail",
    );
    if (response.market.ticker !== ticker) {
      throw new ExchangeError(
        "Kalshi market response ticker contradicts request",
        "SCHEMA",
      );
    }
    this.rememberMarket(response.market);
    return response.market;
  }

  private async readEffectiveFeeTerms(
    market: KalshiMarket,
  ): Promise<EffectiveFeeTerms> {
    const resolutionStartedAt = this.now().getTime();
    if (!Number.isFinite(resolutionStartedAt)) {
      throw new ExchangeError(
        "Kalshi fee observation time is invalid",
        "SCHEMA",
      );
    }
    const rawEvent = await this.safeRead(() =>
      this.client.getEvent(market.event_ticker),
    );
    const event = parseKalshiResponse(
      KalshiEventResponseSchema,
      rawEvent,
      "event fee terms",
    ).event;
    if (event.event_ticker !== market.event_ticker) {
      throw new ExchangeError(
        "Kalshi event response ticker contradicts market",
        "SCHEMA",
      );
    }
    if (
      event.exchange_index !== undefined &&
      event.exchange_index !== (market.exchange_index ?? 0)
    ) {
      throw new ExchangeError(
        "Kalshi event exchange index contradicts market",
        "SCHEMA",
      );
    }

    const [rawSeries, rawSeriesChanges, eventChangeTimes] = await Promise.all([
      this.safeRead(() => this.client.getSeries(event.series_ticker)),
      this.safeRead(() =>
        this.client.getSeriesFeeChanges({
          series_ticker: event.series_ticker,
          show_historical: false,
        }),
      ),
      this.readEventFeeChangeTimes(event.event_ticker, event.series_ticker),
    ]);
    const series = parseKalshiResponse(
      KalshiSeriesResponseSchema,
      rawSeries,
      "series fee terms",
    ).series;
    if (series.ticker !== event.series_ticker) {
      throw new ExchangeError(
        "Kalshi series response ticker contradicts event",
        "SCHEMA",
      );
    }
    if (
      series.exchange_index !== undefined &&
      series.exchange_index !== (market.exchange_index ?? 0)
    ) {
      throw new ExchangeError(
        "Kalshi series exchange index contradicts market",
        "SCHEMA",
      );
    }

    const seriesChanges = parseKalshiResponse(
      KalshiSeriesFeeChangesResponseSchema,
      rawSeriesChanges,
      "series fee changes",
    ).series_fee_change_arr;
    for (const change of seriesChanges) {
      if (change.series_ticker !== series.ticker) {
        throw new ExchangeError(
          "Kalshi series fee change contradicts requested series",
          "SCHEMA",
        );
      }
    }

    const overrideType = event.fee_type_override;
    const type = supportedFeeType(overrideType ?? series.fee_type);
    const multiplier =
      overrideType == null
        ? series.fee_multiplier
        : event.fee_multiplier_override;
    if (multiplier == null || !multiplier.isFinite() || multiplier.lt(0)) {
      throw new ExchangeError(
        "Kalshi effective fee multiplier is invalid",
        "SCHEMA",
      );
    }
    const observedAt = this.now().getTime();
    if (!Number.isFinite(observedAt)) {
      throw new ExchangeError(
        "Kalshi fee observation time is invalid",
        "SCHEMA",
      );
    }
    const futureChangeTimes = [
      ...seriesChanges.map((change) => change.scheduled_ts.getTime()),
      ...eventChangeTimes,
    ].filter((scheduledAt) => scheduledAt > resolutionStartedAt);
    const earliestChange =
      futureChangeTimes.length === 0
        ? undefined
        : Math.min(...futureChangeTimes);
    const validUntilMilliseconds =
      earliestChange === undefined
        ? undefined
        : earliestChange - FEE_CHANGE_GUARD_MILLISECONDS;
    if (
      validUntilMilliseconds !== undefined &&
      validUntilMilliseconds <= observedAt
    ) {
      throw new ExchangeError(
        "Kalshi fee schedule is too close to a transition for safe placement",
        "TRANSIENT",
      );
    }
    return {
      type,
      multiplier,
      ...(validUntilMilliseconds === undefined
        ? {}
        : { validUntilMilliseconds }),
    };
  }

  private async readEventFeeChangeTimes(
    eventTicker: string,
    seriesTicker: string,
  ): Promise<number[]> {
    const scheduledTimes: number[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getEventFeeChanges({
          event_ticker: eventTicker,
          limit: this.pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(
        KalshiEventFeeChangesResponseSchema,
        raw,
        "event fee changes",
      );
      for (const change of page.event_fee_changes) {
        if (
          change.event_ticker !== eventTicker ||
          change.series_ticker !== seriesTicker
        ) {
          throw new ExchangeError(
            "Kalshi event fee change contradicts requested event",
            "SCHEMA",
          );
        }
        scheduledTimes.push(change.scheduled_ts.getTime());
      }
      if (page.cursor.length === 0) return scheduledTimes;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi event fee cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi event fee pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  private async loadEffectiveFeeTerms(
    market: KalshiMarket,
  ): Promise<EffectiveFeeTerms> {
    const existing = this.feeTermsInFlight.get(market.event_ticker);
    if (existing !== undefined) return existing;
    const operation = this.readEffectiveFeeTerms(market);
    this.feeTermsInFlight.set(market.event_ticker, operation);
    try {
      return await operation;
    } finally {
      if (this.feeTermsInFlight.get(market.event_ticker) === operation) {
        this.feeTermsInFlight.delete(market.event_ticker);
      }
    }
  }

  private statusForQuery(
    query: MarketQuery,
  ): "open" | "closed" | "settled" | undefined {
    if (query.archived === true) return "settled";
    if (query.active === true && query.closed !== true) return "open";
    if (query.closed === true) return "closed";
    return undefined;
  }

  private marketMatchesQuery(market: Market, query: MarketQuery): boolean {
    return (
      (query.active === undefined || market.active === query.active) &&
      (query.closed === undefined || market.closed === query.closed) &&
      (query.archived === undefined || market.archived === query.archived)
    );
  }

  private async readArchivedMarketTier(
    tier: ArchivedMarketCursor["tier"],
    cursor: string | undefined,
    limit: number,
    query: MarketQuery,
  ): Promise<{ readonly items: Market[]; readonly cursor: string }> {
    const raw = await this.safeRead(() =>
      tier === "live"
        ? this.client.listMarkets({
            limit,
            status: "settled",
            mve_filter: "exclude",
            ...(cursor === undefined ? {} : { cursor }),
          })
        : this.client.listHistoricalMarkets({
            limit,
            mve_filter: "exclude",
            ...(cursor === undefined ? {} : { cursor }),
          }),
    );
    const response = parseKalshiResponse(
      tier === "historical"
        ? KalshiHistoricalMarketsResponseSchema
        : KalshiMarketsResponseSchema,
      raw,
      `${tier} archived market list`,
    );
    if (response.cursor.length > 0 && response.cursor === cursor) {
      throw new ExchangeError(
        "Kalshi market cursor made no progress",
        "SCHEMA",
      );
    }
    return {
      items: response.markets
        .filter((market) => (market.exchange_index ?? 0) === 0)
        .map((market) => this.rememberMarket(market))
        .filter((market) => this.marketMatchesQuery(market, query)),
      cursor: response.cursor,
    };
  }

  private async listArchivedMarkets(
    query: MarketQuery,
    limit: number,
  ): Promise<Page<Market>> {
    const decoded = decodeArchivedMarketCursor(query.cursor);
    if (decoded.tier === "historical") {
      const historical = await this.readArchivedMarketTier(
        "historical",
        decoded.cursor,
        limit,
        query,
      );
      const eof = historical.cursor.length === 0;
      return {
        items: historical.items,
        eof,
        ...(eof
          ? {}
          : {
              nextCursor: encodeArchivedMarketCursor(
                "historical",
                historical.cursor,
              ),
            }),
      };
    }

    const live = await this.readArchivedMarketTier(
      "live",
      decoded.cursor,
      limit,
      query,
    );
    if (live.cursor.length > 0) {
      return {
        items: live.items,
        eof: false,
        nextCursor: encodeArchivedMarketCursor("live", live.cursor),
      };
    }
    if (live.items.length >= limit) {
      return {
        items: live.items,
        eof: false,
        nextCursor: encodeArchivedMarketCursor("historical"),
      };
    }

    const historical = await this.readArchivedMarketTier(
      "historical",
      undefined,
      limit - live.items.length,
      query,
    );
    const eof = historical.cursor.length === 0;
    return {
      items: [...live.items, ...historical.items],
      eof,
      ...(eof
        ? {}
        : {
            nextCursor: encodeArchivedMarketCursor(
              "historical",
              historical.cursor,
            ),
          }),
    };
  }

  public async listMarkets(query: MarketQuery = {}): Promise<Page<Market>> {
    try {
      const limit = positiveInteger(
        query.limit ?? this.pageSize,
        "market limit",
      );
      if (limit > MAXIMUM_PAGE_SIZE) {
        throw new ExchangeError(
          `Market limit cannot exceed ${MAXIMUM_PAGE_SIZE}`,
          "INVALID_REQUEST",
        );
      }
      if (query.orderBy !== undefined || query.orderDirection !== undefined) {
        throw new ExchangeError(
          "Kalshi market discovery does not support caller-defined sorting",
          "UNSUPPORTED",
        );
      }
      if (query.closed === true && query.archived === undefined) {
        throw new ExchangeError(
          "Kalshi closed-market queries must specify the archived predicate",
          "UNSUPPORTED",
        );
      }
      if (query.offset !== undefined && query.offset !== 0) {
        throw new ExchangeError(
          "Kalshi market pagination is cursor-based and does not support offsets",
          "UNSUPPORTED",
        );
      }
      if (query.archived === true) {
        return await this.listArchivedMarkets(query, limit);
      }
      const raw = await this.safeRead(() =>
        this.client.listMarkets({
          limit,
          mve_filter: "exclude",
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...optional("status", this.statusForQuery(query)),
        }),
      );
      const response = parseKalshiResponse(
        KalshiMarketsResponseSchema,
        raw,
        "market list",
      );
      if (
        response.cursor.length > 0 &&
        query.cursor !== undefined &&
        response.cursor === query.cursor
      ) {
        throw new ExchangeError(
          "Kalshi market cursor made no progress",
          "SCHEMA",
        );
      }
      const items = response.markets
        .filter((market) => (market.exchange_index ?? 0) === 0)
        .map((market) => this.rememberMarket(market))
        .filter((market) => this.marketMatchesQuery(market, query));
      const eof = response.cursor.length === 0;
      return {
        items,
        eof,
        ...(eof ? {} : { nextCursor: response.cursor }),
      };
    } catch (error) {
      throw normalizeKalshiError(error, "list markets");
    }
  }

  private resolveTagMarketSlugs(tag: string): Promise<readonly string[]> {
    const cached = this.tagMarketSlugs.get(tag);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<readonly string[]> => {
      const rawSeries = await this.safeRead(() =>
        this.client.listSeries({ tags: tag }),
      );
      const seriesResponse = parseKalshiResponse(
        KalshiSeriesListResponseSchema,
        rawSeries,
        "tagged series",
      );
      const normalizedTag = tag.toLocaleLowerCase("en-US");
      const seriesTickers = seriesResponse.series
        .filter((series) =>
          (series.tags ?? []).some(
            (candidate) =>
              candidate.toLocaleLowerCase("en-US") === normalizedTag,
          ),
        )
        .map((series) => series.ticker);
      const slugs = new Set<string>();
      for (const seriesTicker of seriesTickers) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (
          let pageNumber = 0;
          pageNumber < this.maximumPaginationPages;
          pageNumber += 1
        ) {
          const rawMarkets = await this.safeRead(() =>
            this.client.listMarkets({
              limit: this.pageSize,
              status: "open",
              mve_filter: "exclude",
              series_ticker: seriesTicker,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          const marketResponse = parseKalshiResponse(
            KalshiMarketsResponseSchema,
            rawMarkets,
            "tagged-series market members",
          );
          for (const market of marketResponse.markets) {
            if ((market.exchange_index ?? 0) === 0) {
              slugs.add(this.rememberMarket(market).slug);
            }
          }
          if (marketResponse.cursor.length === 0) break;
          if (cursors.has(marketResponse.cursor)) {
            throw new ExchangeError(
              "Tagged-series market pagination entered a cursor loop",
              "SCHEMA",
            );
          }
          cursors.add(marketResponse.cursor);
          cursor = marketResponse.cursor;
          if (pageNumber === this.maximumPaginationPages - 1) {
            throw new ExchangeError(
              "Tagged-series market pagination exceeded its page guard",
              "SCHEMA",
            );
          }
        }
      }
      return [...slugs];
    })();
    this.tagMarketSlugs.set(tag, pending);
    void pending.catch(() => this.tagMarketSlugs.delete(tag));
    return pending;
  }

  public async listMarketGroupMembers(
    query: MarketGroupQuery,
  ): Promise<Page<string>> {
    const value = query.value.trim();
    if (value.length === 0) {
      throw new ExchangeError(
        "Market group value cannot be empty",
        "INVALID_REQUEST",
      );
    }
    const limit = positiveInteger(
      query.limit ?? this.pageSize,
      "market group limit",
    );
    if (limit > MAXIMUM_PAGE_SIZE) {
      throw new ExchangeError(
        `Market group limit cannot exceed ${MAXIMUM_PAGE_SIZE}`,
        "INVALID_REQUEST",
      );
    }
    try {
      if (query.kind === "TAG") {
        const offset = query.cursor === undefined ? 0 : Number(query.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new ExchangeError(
            "Tag-group cursor must be a non-negative integer offset",
            "INVALID_REQUEST",
          );
        }
        const allSlugs = await this.resolveTagMarketSlugs(value);
        const items = allSlugs.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        const eof = nextOffset >= allSlugs.length;
        return {
          items,
          eof,
          ...(eof ? {} : { nextCursor: String(nextOffset) }),
        };
      }
      const raw = await this.safeRead(() =>
        this.client.listMarkets({
          limit,
          status: "open",
          mve_filter: "exclude",
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.kind === "EVENT"
            ? { event_ticker: value }
            : { series_ticker: value }),
        }),
      );
      const response = parseKalshiResponse(
        KalshiMarketsResponseSchema,
        raw,
        "market group members",
      );
      const items = response.markets
        .filter((market) => (market.exchange_index ?? 0) === 0)
        .map((market) => this.rememberMarket(market).slug);
      const eof = response.cursor.length === 0;
      return {
        items,
        eof,
        ...(eof ? {} : { nextCursor: response.cursor }),
      };
    } catch (error) {
      throw normalizeKalshiError(error, "list market group members");
    }
  }

  public async getMarket(id: MarketId): Promise<Market> {
    assertKalshiId(id);
    try {
      await this.loadRawMarket(id.value);
      return (
        this.marketByTicker.get(id.value) ??
        (() => {
          throw new ExchangeError(
            "Kalshi market cache was incomplete",
            "SCHEMA",
          );
        })()
      );
    } catch (error) {
      throw normalizeKalshiError(error, "get market");
    }
  }

  public async getMarketBySlug(slug: string): Promise<Market> {
    if (slug.trim().length === 0) {
      throw new ExchangeError("Market slug cannot be empty", "INVALID_REQUEST");
    }
    return this.getMarket({ exchange: KALSHI_EXCHANGE_ID, value: slug });
  }

  private async loadOrderBook(id: MarketId): Promise<OrderBook> {
    assertKalshiId(id);
    const existing = this.orderBookInFlight.get(id.value);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const raw = await this.safeRead(() => this.client.getOrderBook(id.value));
      const response = parseKalshiResponse(
        KalshiOrderBookResponseSchema,
        raw,
        "order book",
      );
      return mapOrderBook(response, id, this.now());
    })();
    this.orderBookInFlight.set(id.value, operation);
    try {
      return await operation;
    } finally {
      if (this.orderBookInFlight.get(id.value) === operation) {
        this.orderBookInFlight.delete(id.value);
      }
    }
  }

  public async getBbo(id: MarketId): Promise<MarketBbo> {
    try {
      return mapBbo(await this.loadOrderBook(id));
    } catch (error) {
      throw normalizeKalshiError(error, "get BBO");
    }
  }

  public async getOrderBook(id: MarketId): Promise<OrderBook> {
    try {
      return await this.loadOrderBook(id);
    } catch (error) {
      throw normalizeKalshiError(error, "get order book");
    }
  }

  public async getMarketHistory(
    id: MarketId,
    query: MarketHistoryQuery,
  ): Promise<MarketHistory> {
    assertKalshiId(id);
    const startsAtSeconds = Math.floor(query.startsAt.getTime() / 1_000);
    const endsAtSeconds = Math.floor(query.endsAt.getTime() / 1_000);
    if (
      !Number.isSafeInteger(startsAtSeconds) ||
      !Number.isSafeInteger(endsAtSeconds) ||
      startsAtSeconds >= endsAtSeconds ||
      !Number.isSafeInteger(query.intervalMinutes) ||
      query.intervalMinutes <= 0
    ) {
      throw new ExchangeError(
        "Market history query is invalid",
        "INVALID_REQUEST",
      );
    }
    try {
      const readHistorical = async (): Promise<MarketHistory> => {
        const periodInterval = historicalCandlestickInterval(
          query.intervalMinutes,
        );
        const raw = await this.safeRead(() =>
          this.client.getHistoricalMarketCandlesticks(id.value, {
            start_ts: startsAtSeconds,
            end_ts: endsAtSeconds,
            period_interval: periodInterval,
          }),
        );
        const response = parseKalshiResponse(
          KalshiHistoricalMarketCandlesticksResponseSchema,
          raw,
          "historical market candlesticks",
        );
        if (response.ticker !== id.value) {
          throw new ExchangeError(
            `Historical candlestick ticker contradicts ${id.value}`,
            "SCHEMA",
          );
        }
        return {
          source: "KALSHI_CANDLESTICKS",
          candles: mapCandlesticks(response.candlesticks),
          warnings:
            periodInterval === query.intervalMinutes
              ? []
              : [
                  `Kalshi historical candles use the supported ${periodInterval}-minute interval instead of ${query.intervalMinutes} minutes`,
                ],
        };
      };

      let raw: unknown;
      try {
        raw = await this.safeRead(() =>
          this.client.getMarketCandlesticks({
            market_tickers: id.value,
            start_ts: startsAtSeconds,
            end_ts: endsAtSeconds,
            period_interval: query.intervalMinutes,
            include_latest_before_start: true,
          }),
        );
      } catch (error) {
        if (error instanceof KalshiHttpError && error.status === 404) {
          return await readHistorical();
        }
        throw error;
      }
      const response = parseKalshiResponse(
        KalshiMarketCandlesticksResponseSchema,
        raw,
        "market candlesticks",
      );
      const matches = response.markets.filter(
        (market) => market.market_ticker === id.value,
      );
      // Archived candles may be represented by an empty batch result rather
      // than a 404, so both signals route to Kalshi's historical tier.
      if (matches.length === 0) return await readHistorical();
      if (matches.length > 1) {
        throw new ExchangeError(
          `Expected one candlestick series for ${id.value}`,
          "SCHEMA",
        );
      }
      const candles = matches[0]?.candlesticks ?? [];
      return {
        source: "KALSHI_CANDLESTICKS",
        candles: mapCandlesticks(candles),
        warnings: [],
      };
    } catch (error) {
      throw normalizeKalshiError(error, "get market history");
    }
  }

  public async getSettlement(id: MarketId): Promise<SettlementStatus> {
    assertKalshiId(id);
    try {
      return mapSettlement(await this.loadRawMarket(id.value), id);
    } catch (error) {
      throw normalizeKalshiError(error, "get settlement");
    }
  }

  public async getPositions(): Promise<readonly Position[]> {
    try {
      const positions: Position[] = [];
      const tickers = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (
        let pageNumber = 0;
        pageNumber < this.maximumPaginationPages;
        pageNumber += 1
      ) {
        const raw = await this.safeRead(() =>
          this.client.getPositions({
            limit: this.pageSize,
            count_filter: "position",
            subaccount: 0,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        const page = parseKalshiResponse(
          KalshiPositionsResponseSchema,
          raw,
          "positions",
        );
        for (const value of page.market_positions) {
          if (tickers.has(value.ticker)) {
            throw new ExchangeError(
              `Kalshi position ${value.ticker} repeated across pages`,
              "SCHEMA",
            );
          }
          tickers.add(value.ticker);
          const position = mapPosition(value);
          if (position !== undefined) positions.push(position);
        }
        if (page.cursor.length === 0) return positions;
        if (seenCursors.has(page.cursor)) {
          throw new ExchangeError("Kalshi position cursor loop", "SCHEMA");
        }
        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }
      throw new ExchangeError(
        "Kalshi position pagination exceeded its page guard",
        "SCHEMA",
      );
    } catch (error) {
      throw normalizeKalshiError(error, "get positions");
    }
  }

  public async getOpenOrders(): Promise<readonly ExchangeOrder[]> {
    try {
      const orders: ExchangeOrder[] = [];
      const orderIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (
        let pageNumber = 0;
        pageNumber < this.maximumPaginationPages;
        pageNumber += 1
      ) {
        const raw = await this.safeRead(() =>
          this.client.getOrders({
            limit: this.pageSize,
            status: "resting",
            subaccount: 0,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        const page = parseKalshiResponse(
          KalshiOrdersResponseSchema,
          raw,
          "open orders",
        );
        for (const value of page.orders) {
          if (orderIds.has(value.order_id)) {
            throw new ExchangeError(
              `Kalshi order ${value.order_id} repeated across pages`,
              "SCHEMA",
            );
          }
          orderIds.add(value.order_id);
          if (
            value.exchange_index === undefined ||
            value.exchange_index === 0
          ) {
            orders.push(mapOrder(value));
          }
        }
        if (page.cursor.length === 0) return orders;
        if (seenCursors.has(page.cursor)) {
          throw new ExchangeError("Kalshi order cursor loop", "SCHEMA");
        }
        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }
      throw new ExchangeError(
        "Kalshi order pagination exceeded its page guard",
        "SCHEMA",
      );
    } catch (error) {
      throw normalizeKalshiError(error, "get open orders");
    }
  }

  private async readFillActivities(
    query: ActivityQuery,
    pageLimit: number,
  ): Promise<AccountActivity[]> {
    const activities: AccountActivity[] = [];
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = query.cursor;
    if (cursor !== undefined) seenCursors.add(cursor);
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getFills({
          limit: pageLimit,
          subaccount: 0,
          ...(query.marketSlug === undefined
            ? {}
            : { ticker: query.marketSlug }),
          ...(query.createdAfter === undefined
            ? {}
            : { min_ts: Math.floor(query.createdAfter.getTime() / 1_000) }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(KalshiFillsResponseSchema, raw, "fills");
      for (const value of page.fills) {
        if (ids.has(value.fill_id)) {
          throw new ExchangeError(
            `Kalshi fill ${value.fill_id} repeated across pages`,
            "SCHEMA",
          );
        }
        ids.add(value.fill_id);
        activities.push(mapFill(value));
      }
      if (page.cursor.length === 0) return activities;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi fill cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi fill pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  private async readHistoricalFillActivities(
    query: ActivityQuery,
    pageLimit: number,
    cutoff: Date,
  ): Promise<AccountActivity[]> {
    const activities: AccountActivity[] = [];
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getHistoricalFills({
          limit: pageLimit,
          max_ts: Math.floor(cutoff.getTime() / 1_000),
          ...(query.marketSlug === undefined
            ? {}
            : { ticker: query.marketSlug }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(
        KalshiHistoricalFillsResponseSchema,
        raw,
        "historical fills",
      );
      for (const value of page.fills) {
        if (ids.has(value.fill_id)) {
          throw new ExchangeError(
            `Kalshi historical fill ${value.fill_id} repeated across pages`,
            "SCHEMA",
          );
        }
        ids.add(value.fill_id);
        // Historical fills predate or explicitly identify subaccounts. An
        // omitted value is primary-account legacy data; exclude known
        // non-primary subaccounts from this primary-account adapter.
        if (
          value.subaccount_number === undefined ||
          value.subaccount_number === 0
        ) {
          activities.push(mapFill(value));
        }
      }
      if (page.cursor.length === 0) return activities;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi historical fill cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi historical fill pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  private async readTradeActivities(
    query: ActivityQuery,
    pageLimit: number,
  ): Promise<AccountActivity[]> {
    const rawCutoff = await this.safeRead(() =>
      this.client.getHistoricalCutoff(),
    );
    const cutoff = parseKalshiResponse(
      KalshiHistoricalCutoffSchema,
      rawCutoff,
      "historical cutoff",
    ).trades_created_ts;
    const needsHistorical =
      query.createdAfter === undefined || query.createdAfter < cutoff;
    if (query.cursor !== undefined && needsHistorical) {
      throw new ExchangeError(
        "A cursor cannot address both live and historical Kalshi fills",
        "INVALID_REQUEST",
      );
    }
    const [live, historical] = await Promise.all([
      this.readFillActivities(query, pageLimit),
      needsHistorical
        ? this.readHistoricalFillActivities(query, pageLimit, cutoff)
        : [],
    ]);
    const seen = new Set<string>();
    return [...live, ...historical].filter((activity) => {
      if (activity.kind !== "TRADE") return true;
      if (seen.has(activity.tradeId)) return false;
      seen.add(activity.tradeId);
      return true;
    });
  }

  private async readDepositActivities(
    pageLimit: number,
  ): Promise<AccountActivity[]> {
    const activities: AccountActivity[] = [];
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getDeposits({
          limit: Math.min(pageLimit, 500),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(
        KalshiDepositsResponseSchema,
        raw,
        "deposits",
      );
      for (const value of page.deposits) {
        if (ids.has(value.id)) {
          throw new ExchangeError(
            `Kalshi deposit ${value.id} repeated across pages`,
            "SCHEMA",
          );
        }
        ids.add(value.id);
        const activity = mapDeposit(value);
        if (activity !== undefined) activities.push(activity);
      }
      if (page.cursor.length === 0) return activities;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi deposit cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi deposit pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  private async readWithdrawalActivities(
    pageLimit: number,
  ): Promise<AccountActivity[]> {
    const activities: AccountActivity[] = [];
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getWithdrawals({
          limit: Math.min(pageLimit, 500),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(
        KalshiWithdrawalsResponseSchema,
        raw,
        "withdrawals",
      );
      for (const value of page.withdrawals) {
        if (ids.has(value.id)) {
          throw new ExchangeError(
            `Kalshi withdrawal ${value.id} repeated across pages`,
            "SCHEMA",
          );
        }
        ids.add(value.id);
        const activity = mapWithdrawal(value);
        if (activity !== undefined) activities.push(activity);
      }
      if (page.cursor.length === 0) return activities;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi withdrawal cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi withdrawal pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  private async readResolutionActivities(
    query: ActivityQuery,
    pageLimit: number,
  ): Promise<AccountActivity[]> {
    const activities: AccountActivity[] = [];
    const tickers = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = query.cursor;
    if (cursor !== undefined) seenCursors.add(cursor);
    for (
      let pageNumber = 0;
      pageNumber < this.maximumPaginationPages;
      pageNumber += 1
    ) {
      const raw = await this.safeRead(() =>
        this.client.getSettlements({
          limit: pageLimit,
          subaccount: 0,
          ...(query.marketSlug === undefined
            ? {}
            : { ticker: query.marketSlug }),
          ...(query.createdAfter === undefined
            ? {}
            : { min_ts: Math.floor(query.createdAfter.getTime() / 1_000) }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const page = parseKalshiResponse(
        KalshiSettlementsResponseSchema,
        raw,
        "settlements",
      );
      for (const value of page.settlements) {
        const identity = `${value.ticker}:${value.settled_time.toISOString()}`;
        if (tickers.has(identity)) {
          throw new ExchangeError(
            `Kalshi settlement ${value.ticker} repeated across pages`,
            "SCHEMA",
          );
        }
        tickers.add(identity);
        activities.push(mapResolution(value));
      }
      if (page.cursor.length === 0) return activities;
      if (seenCursors.has(page.cursor)) {
        throw new ExchangeError("Kalshi settlement cursor loop", "SCHEMA");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    throw new ExchangeError(
      "Kalshi settlement pagination exceeded its page guard",
      "SCHEMA",
    );
  }

  public async getActivities(
    query: ActivityQuery = {},
  ): Promise<Page<AccountActivity>> {
    try {
      if (query.kinds?.length === 0) return { items: [], eof: true };
      if (
        query.cursor !== undefined &&
        (query.kinds === undefined ||
          query.kinds.includes("BALANCE_CHANGE") ||
          (query.kinds.includes("TRADE") && query.kinds.includes("RESOLUTION")))
      ) {
        throw new ExchangeError(
          "A cursor cannot address both Kalshi fills and settlements",
          "INVALID_REQUEST",
        );
      }
      const pageLimit = positiveInteger(
        query.limit ?? this.pageSize,
        "activity limit",
      );
      if (pageLimit > MAXIMUM_PAGE_SIZE) {
        throw new ExchangeError(
          `Activity limit cannot exceed ${MAXIMUM_PAGE_SIZE}`,
          "INVALID_REQUEST",
        );
      }
      const includeTrades =
        query.kinds === undefined || query.kinds.includes("TRADE");
      const includeResolutions =
        query.kinds === undefined || query.kinds.includes("RESOLUTION");
      const includeBalanceChanges =
        query.marketSlug === undefined &&
        (query.kinds === undefined || query.kinds.includes("BALANCE_CHANGE"));
      const [trades, resolutions, deposits, withdrawals] = await Promise.all([
        includeTrades ? this.readTradeActivities(query, pageLimit) : [],
        includeResolutions
          ? this.readResolutionActivities(query, pageLimit)
          : [],
        includeBalanceChanges ? this.readDepositActivities(pageLimit) : [],
        includeBalanceChanges ? this.readWithdrawalActivities(pageLimit) : [],
      ]);
      const items = [...trades, ...resolutions, ...deposits, ...withdrawals]
        .filter(
          (activity) =>
            query.createdAfter === undefined ||
            dateForActivity(activity) > query.createdAfter,
        )
        .sort((left, right) => {
          const difference =
            dateForActivity(left).getTime() - dateForActivity(right).getTime();
          return query.sortOrder === "ASCENDING" ? difference : -difference;
        });
      return { items, eof: true };
    } catch (error) {
      throw normalizeKalshiError(error, "get activities");
    }
  }

  public async getAccountSnapshot(): Promise<AccountSnapshot> {
    try {
      const observedAt = this.now();
      if (Number.isNaN(observedAt.getTime())) {
        throw new ExchangeError("Snapshot time was invalid", "SCHEMA");
      }
      const createdAfter = new Date(
        observedAt.getTime() - this.activityLookbackDays * 86_400_000,
      );
      const limit = pLimit(this.maximumConcurrentRequests);
      const [rawBalance, positions, openOrders, activities] = await Promise.all(
        [
          limit(() => this.safeRead(() => this.client.getBalance(0, 0))),
          limit(() => this.getPositions()),
          limit(() => this.getOpenOrders()),
          limit(() =>
            this.getActivities({
              limit: this.pageSize,
              sortOrder: "DESCENDING",
              createdAfter,
            }),
          ),
        ],
      );
      const balance = parseKalshiResponse(
        KalshiBalanceResponseSchema,
        rawBalance,
        "balance",
      );
      const portfolioValue =
        balance.portfolio_value_dollars ??
        new Decimal(balance.portfolio_value).div(100);
      const cashBalance =
        balance.balance_dollars ?? new Decimal(balance.balance).div(100);
      if (balance.balance_breakdown !== undefined) {
        const seenExchangeIndices = new Set<number>();
        for (const entry of balance.balance_breakdown) {
          if (seenExchangeIndices.has(entry.exchange_index)) {
            throw new ExchangeError(
              "Kalshi balance breakdown repeated an exchange index",
              "SCHEMA",
            );
          }
          seenExchangeIndices.add(entry.exchange_index);
          if (entry.exchange_index === 0 && !entry.balance.eq(cashBalance)) {
            throw new ExchangeError(
              "Kalshi balance breakdown contradicts exchange index 0 balance",
              "SCHEMA",
            );
          }
        }
      }
      // Kalshi defines portfolio_value as the current value of positions only;
      // it does not include the member's available cash balance.
      const assetValue = portfolioValue;
      const openOrderValue = openOrders.reduce(
        (total, order) =>
          total.plus(
            (
              order.remainingQuantity ??
              order.quantity.minus(order.filledQuantity)
            ).mul(order.canonicalPrice),
          ),
        new Decimal(0),
      );
      return {
        observedAt,
        currentBalance: cashBalance,
        buyingPower: cashBalance,
        assetNotional: assetValue,
        assetAvailable: assetValue,
        openOrderValue,
        unsettledFunds: new Decimal(0),
        marginRequirement: new Decimal(0),
        positions,
        openOrders,
        recentActivities: activities.items,
      };
    } catch (error) {
      throw normalizeKalshiError(error, "get account snapshot");
    }
  }

  private async prepareOrder(order: ImmediateOrder): Promise<PreparedOrder> {
    if ((order.executionPolicy ?? "IOC") !== "IOC") {
      throw new ExchangeError(
        "Managed resting orders are not supported on Kalshi",
        "UNSUPPORTED",
      );
    }
    assertKalshiId(order.marketId);
    if (order.marketSlug.trim().length === 0) {
      throw new ExchangeError(
        "Order market slug cannot be empty",
        "INVALID_REQUEST",
      );
    }
    if (order.marketId.value !== order.marketSlug) {
      throw new ExchangeError(
        "Kalshi order market ID must equal its ticker slug",
        "INVALID_REQUEST",
      );
    }
    if (!order.quantity.isFinite() || order.quantity.lte(0)) {
      throw new ExchangeError(
        "Order quantity must be positive and finite",
        "INVALID_REQUEST",
      );
    }
    if (!order.quantity.mod(CONTRACT_GRANULARITY).isZero()) {
      throw new ExchangeError(
        "Order quantity must use Kalshi's 0.01-contract granularity",
        "INVALID_REQUEST",
      );
    }
    if (
      !order.canonicalLimitPrice.isFinite() ||
      order.canonicalLimitPrice.lte(0) ||
      order.canonicalLimitPrice.gte(1)
    ) {
      throw new ExchangeError(
        "Order limit price must be strictly between zero and one",
        "INVALID_REQUEST",
      );
    }
    const rawMarket = await this.loadRawMarket(order.marketSlug);
    if (rawMarket.market_type.toLowerCase() !== "binary") {
      throw new ExchangeError(
        "Kalshi trading does not support non-binary markets",
        "UNSUPPORTED",
      );
    }
    const market =
      this.marketByTicker.get(order.marketSlug) ??
      this.rememberMarket(rawMarket);
    if (
      rawMarket.mve_collection_ticker !== undefined ||
      (rawMarket.mve_selected_legs?.length ?? 0) > 0
    ) {
      throw new ExchangeError(
        "Kalshi multivariate markets are not supported for trading",
        "UNSUPPORTED",
      );
    }
    if ((rawMarket.exchange_index ?? 0) !== 0) {
      throw new ExchangeError(
        "Kalshi exchange shards other than index 0 are not supported",
        "UNSUPPORTED",
      );
    }
    if (!market.active || market.closed || market.archived) {
      throw new ExchangeError(
        "Market is not open for trading",
        "INVALID_REQUEST",
      );
    }
    if (market.settlementRules.trim().length === 0) {
      throw new ExchangeError(
        "Market settlement rules are unavailable",
        "SCHEMA",
      );
    }
    if (order.quantity.lt(market.minimumTradeQuantity)) {
      throw new ExchangeError(
        "Order is below the market minimum quantity",
        "INVALID_REQUEST",
      );
    }
    const conversion = canonicalOrderToKalshi(order);
    if (!isValidKalshiYesPrice(rawMarket, conversion.yesPrice)) {
      throw new ExchangeError(
        "Order price is not on the Kalshi market's active price grid",
        "INVALID_REQUEST",
      );
    }
    const feeTerms = await this.loadEffectiveFeeTerms(rawMarket);
    const clientOrderId = this.createClientOrderId();
    if (clientOrderId.trim().length === 0) {
      throw new ExchangeError(
        "Generated Kalshi client order ID was empty",
        "SCHEMA",
      );
    }
    return {
      market,
      feeTerms,
      request: {
        ticker: order.marketSlug,
        client_order_id: clientOrderId,
        side: conversion.bookSide,
        count: order.quantity.toFixed(2),
        price: conversion.yesPrice.toFixed(4),
        time_in_force: "immediate_or_cancel",
        self_trade_prevention_type: "taker_at_cross",
        post_only: false,
        cancel_order_on_pause: true,
        reduce_only: order.action === "SELL",
        subaccount: 0,
        exchange_index: 0,
      },
    };
  }

  public async previewImmediateOrder(
    order: ImmediateOrder,
    purpose: OrderPreviewPurpose,
  ): Promise<OrderPreview> {
    const prepared = await this.prepareOrder(order);
    const estimatedPrincipal = order.quantity.mul(order.canonicalLimitPrice);
    // Kalshi has no preview endpoint. Resolve the current event-over-series
    // schedule and bound per-fill rounding at the minimum fill granularity.
    const estimatedFees = estimateKalshiTakerFeeUpperBound(
      order.quantity,
      order.canonicalLimitPrice,
      order.action,
      prepared.feeTerms.multiplier,
    );
    const previewedAt = this.now().getTime();
    if (!Number.isFinite(previewedAt)) {
      throw new ExchangeError("Kalshi preview time is invalid", "SCHEMA");
    }
    if (purpose === "PLACEMENT") {
      this.previewedFeeTermsByOrder.set(feePreviewKey(order), {
        ...prepared.feeTerms,
        expiresAtMilliseconds: Math.min(
          previewedAt + this.feePreviewValidityMilliseconds,
          prepared.feeTerms.validUntilMilliseconds ?? Number.POSITIVE_INFINITY,
        ),
      });
    }
    return {
      accepted: true,
      estimatedFees,
      estimatedPrincipal,
      estimatedCollateral:
        order.action === "BUY" ? estimatedPrincipal.plus(estimatedFees) : ZERO,
      warnings: [],
      rejectionReasons: [],
      rawStatus: `LOCAL_VALIDATION:${prepared.market.slug}`,
      basis: "LOCAL_CONSERVATIVE",
      observedAt: new Date(previewedAt),
    };
  }

  public async createImmediateOrderFeeReserveEstimator(
    order: ImmediateOrder,
  ): Promise<(quantity: Decimal) => Decimal> {
    const prepared = await this.prepareOrder(order);
    return (quantity: Decimal) =>
      estimateKalshiTakerFeeUpperBound(
        quantity,
        order.canonicalLimitPrice,
        order.action,
        prepared.feeTerms.multiplier,
      );
  }

  public async placeImmediateOrder(
    order: ImmediateOrder,
  ): Promise<ExecutionResult> {
    const prepared = await this.prepareOrder(order);
    const previewKey = feePreviewKey(order);
    const previewedTerms = this.previewedFeeTermsByOrder.get(previewKey);
    this.previewedFeeTermsByOrder.delete(previewKey);
    const placementTime = this.now().getTime();
    if (!Number.isFinite(placementTime)) {
      return rejectedExecution("Kalshi placement time is invalid");
    }
    if (previewedTerms === undefined) {
      return rejectedExecution(
        "A fresh single-use Kalshi fee preview is required before placement",
      );
    }
    if (previewedTerms.expiresAtMilliseconds < placementTime) {
      return rejectedExecution(
        "The Kalshi fee preview expired before placement",
      );
    }
    if (!feeTermsEqual(previewedTerms, prepared.feeTerms)) {
      return rejectedExecution(
        "Kalshi fee terms changed after preview; placement was not attempted",
      );
    }
    let raw: unknown;
    try {
      // Deliberately exactly one attempt: order creation is never read-retried.
      raw = await this.requestGate.run(() =>
        this.client.createOrder(prepared.request),
      );
    } catch (error) {
      if (
        error instanceof KalshiHttpError &&
        [400, 422].includes(error.status)
      ) {
        return {
          status: "REJECTED",
          filledQuantity: ZERO,
          fees: ZERO,
          finalState: "REJECTED",
          rejectionReason: error.message,
        };
      }
      if (
        error instanceof KalshiHttpError &&
        [401, 403, 404, 429].includes(error.status)
      ) {
        throw normalizeKalshiError(error, "create order");
      }
      return {
        status: "AMBIGUOUS",
        filledQuantity: ZERO,
        fees: ZERO,
        finalState: "UNKNOWN",
        ambiguousReason:
          error instanceof Error
            ? `Create request outcome is unknown: ${error.message}`
            : "Create request outcome is unknown",
      };
    }
    let parsedOrderId =
      typeof raw === "object" &&
      raw !== null &&
      "order_id" in raw &&
      typeof raw.order_id === "string" &&
      raw.order_id.trim().length > 0
        ? raw.order_id
        : undefined;
    try {
      const response = parseKalshiResponse(
        KalshiCreateOrderResponseSchema,
        raw,
        "create order",
      );
      parsedOrderId = response.order_id;
      if (
        response.client_order_id !== undefined &&
        response.client_order_id !== prepared.request.client_order_id
      ) {
        throw new ExchangeError(
          "Kalshi create response client order ID contradicts request",
          "SCHEMA",
        );
      }
      return mapCreateOrderResult(response, order);
    } catch (error) {
      return {
        status: "AMBIGUOUS",
        ...(parsedOrderId === undefined ? {} : { orderId: parsedOrderId }),
        filledQuantity: ZERO,
        fees: ZERO,
        finalState: "UNKNOWN",
        ambiguousReason:
          error instanceof Error
            ? `Create response could not be reconciled: ${error.message}`
            : "Create response could not be reconciled",
      };
    }
  }

  public async getOrder(orderId: string): Promise<ExchangeOrder> {
    if (orderId.trim().length === 0) {
      throw new ExchangeError("Order ID cannot be empty", "INVALID_REQUEST");
    }
    try {
      const raw = await this.safeRead(() => this.client.getOrder(orderId));
      const response = parseKalshiResponse(
        KalshiOrderResponseSchema,
        raw,
        "order detail",
      );
      if (response.order.order_id !== orderId) {
        throw new ExchangeError(
          "Kalshi order response ID contradicts request",
          "SCHEMA",
        );
      }
      if (
        response.order.exchange_index !== undefined &&
        response.order.exchange_index !== 0
      ) {
        throw new ExchangeError(
          "Kalshi order belongs to an unsupported exchange index",
          "INVALID_REQUEST",
        );
      }
      return mapOrder(response.order);
    } catch (error) {
      throw normalizeKalshiError(error, "get order");
    }
  }

  public async cancelOrder(orderId: string): Promise<void> {
    if (orderId.trim().length === 0) {
      throw new ExchangeError("Order ID cannot be empty", "INVALID_REQUEST");
    }
    try {
      // Cancel is mutating and therefore is never automatically retried.
      const raw = await this.requestGate.run(() =>
        this.client.cancelOrder(orderId, {
          subaccount: 0,
          exchange_index: 0,
        }),
      );
      const response = parseKalshiResponse(
        KalshiCancelOrderResponseSchema,
        raw,
        "cancel order",
      );
      if (response.order_id !== orderId) {
        throw new ExchangeError(
          "Kalshi cancel response ID contradicts request",
          "SCHEMA",
        );
      }
    } catch (error) {
      throw normalizeKalshiError(error, "cancel order");
    }
  }
}

export function createKalshiExchange(
  options: KalshiExchangeOptions,
): KalshiExchange {
  return new KalshiExchange(options);
}
