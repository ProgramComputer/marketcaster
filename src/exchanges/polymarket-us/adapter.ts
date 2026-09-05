import { Decimal } from "decimal.js";
import pLimit from "p-limit";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  type ActivityType,
  type CreateOrderParams,
  type GetActivitiesParams,
  type MarketsListParams,
  type PolymarketUSOptions,
} from "polymarket-us";

import type { AccountSnapshot } from "../../domain/account.js";
import type { AccountActivity, ActivityQuery } from "../../domain/activity.js";
import type { ExecutionResult } from "../../domain/execution.js";
import type {
  Market,
  MarketBbo,
  MarketGroupQuery,
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
import { estimateTakerFeeUpperBound } from "../../risk/edge.js";
import { ExchangeError, type PredictionExchange } from "../exchange.js";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../memory-scope.js";
import {
  createPolymarketUsClient,
  isRetryableReadError,
  PolymarketRequestGate,
  readWithRetry,
  type PolymarketUsClient,
  type ReadRetryOptions,
} from "./client.js";
import {
  mapActivity,
  mapBalance,
  mapBbo,
  mapCreateOrderResult,
  mapMarket,
  mapOrder,
  mapOrderBook,
  mapPosition,
  mapPreview,
  mapSettlement,
  type MappedBalance,
} from "./mappers.js";
import {
  ActivitiesResponseSchema,
  BalancesResponseSchema,
  BboResponseSchema,
  CreateOrderResponseSchema,
  EventsResponseSchema,
  MarketResponseSchema,
  MarketsResponseSchema,
  OrderBookResponseSchema,
  OrderResponseSchema,
  OrdersResponseSchema,
  PositionsResponseSchema,
  PreviewResponseSchema,
  SeriesResponseSchema,
  SettlementResponseSchema,
  parseSdkResponse,
  type PolymarketOrder,
  type PolymarketPosition,
} from "./schemas.js";
import { canonicalOrderToPolymarket } from "./side-conversion.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_PAGES = 1_000;
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 4;
const DEFAULT_TARGET_REQUESTS_PER_SECOND = 8;
const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 30;
const MAXIMUM_MANAGED_GTD_LIFETIME_MILLISECONDS = 15 * 60_000;

export interface PolymarketUsExchangeOptions {
  readonly client?: PolymarketUsClient;
  readonly clientOptions?: PolymarketUSOptions;
  readonly memoryScope?: string;
  readonly readRetry?: ReadRetryOptions;
  readonly pageSize?: number;
  readonly maximumPaginationPages?: number;
  readonly maximumConcurrentRequests?: number;
  readonly targetRequestsPerSecond?: number;
  readonly activityLookbackDays?: number;
  readonly now?: () => Date;
}

interface PreparedOrder {
  readonly request: CreateOrderParams;
  readonly submittedYesPrice: Decimal;
  readonly executionPolicy: "IOC" | "GTD";
}

type ExchangeMarketsListParams = MarketsListParams & {
  readonly volumeNumMin?: string;
};

function looksLikeClient(
  value: PolymarketUsExchangeOptions | PolymarketUsClient,
): value is PolymarketUsClient {
  return "markets" in value && "orders" in value && "portfolio" in value;
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

function exchangeDecimalString(value: Decimal, fieldName: string): string {
  if (!value.isFinite() || value.lt(0)) {
    throw new ExchangeError(
      `${fieldName} must be a non-negative finite decimal`,
      "INVALID_REQUEST",
    );
  }
  return value.toString();
}

function assertPolymarketId(id: MarketId): void {
  if (id.exchange !== "polymarket-us") {
    throw new ExchangeError(
      `Expected a polymarket-us market ID, received ${id.exchange}`,
      "INVALID_REQUEST",
    );
  }
  if (id.value.trim().length === 0) {
    throw new ExchangeError("Market ID cannot be empty", "INVALID_REQUEST");
  }
}

export function normalizePolymarketError(
  error: unknown,
  operation: string,
): ExchangeError {
  if (error instanceof ExchangeError) return error;
  const options = { cause: error };
  if (error instanceof AuthenticationError) {
    return new ExchangeError(
      `${operation}: authentication failed`,
      "AUTHENTICATION",
      options,
    );
  }
  if (error instanceof NotFoundError) {
    return new ExchangeError(
      `${operation}: resource not found`,
      "NOT_FOUND",
      options,
    );
  }
  if (error instanceof RateLimitError) {
    return new ExchangeError(
      `${operation}: rate limited`,
      "RATE_LIMITED",
      options,
    );
  }
  if (error instanceof BadRequestError) {
    return new ExchangeError(
      `${operation}: invalid request`,
      "INVALID_REQUEST",
      options,
    );
  }
  if (error instanceof InternalServerError) {
    return new ExchangeError(
      `${operation}: exchange unavailable`,
      "TRANSIENT",
      options,
    );
  }
  if (error instanceof APIError) {
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
    if ([502, 503, 504].includes(error.status)) {
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
  if (isRetryableReadError(error)) {
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

export class PolymarketUsExchange implements PredictionExchange {
  public readonly id = "polymarket-us" as const;
  public readonly memoryScope: string;

  private readonly client: PolymarketUsClient;
  private readonly readRetry: ReadRetryOptions;
  private readonly pageSize: number;
  private readonly maximumPaginationPages: number;
  private readonly maximumConcurrentRequests: number;
  private readonly requestGate: PolymarketRequestGate;
  private readonly activityLookbackDays: number;
  private readonly now: () => Date;
  private readonly marketById = new Map<string, Market>();
  private readonly marketBySlug = new Map<string, Market>();
  private readonly pendingMarketBySlug = new Map<string, Promise<Market>>();
  private readonly seriesIdBySlug = new Map<string, number | null>();

  public constructor(
    clientOrOptions: PolymarketUsExchangeOptions | PolymarketUsClient = {},
  ) {
    const options = looksLikeClient(clientOrOptions) ? {} : clientOrOptions;
    this.memoryScope = assertSafeMemoryScope(
      options.memoryScope ?? UNSCOPED_MEMORY_SCOPE,
    );
    this.client = looksLikeClient(clientOrOptions)
      ? clientOrOptions
      : (options.client ?? createPolymarketUsClient(options.clientOptions));
    this.readRetry = options.readRetry ?? {};
    this.pageSize = positiveInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      "pageSize",
    );
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
    this.requestGate = new PolymarketRequestGate({
      maximumConcurrentRequests: this.maximumConcurrentRequests,
      targetRequestsPerSecond,
    });
    this.activityLookbackDays = positiveInteger(
      options.activityLookbackDays ?? DEFAULT_ACTIVITY_LOOKBACK_DAYS,
      "activityLookbackDays",
    );
    this.now = options.now ?? (() => new Date());
  }

  private async safeRead<T>(operation: () => Promise<T>): Promise<T> {
    return readWithRetry(() => this.requestGate.run(operation), this.readRetry);
  }

  private rememberMarket(market: Market): Market {
    this.marketById.set(market.id.value, market);
    this.marketBySlug.set(market.slug, market);
    return market;
  }

  private async marketForId(id: MarketId): Promise<Market> {
    assertPolymarketId(id);
    const cached =
      this.marketById.get(id.value) ?? this.marketBySlug.get(id.value);
    if (cached !== undefined) return cached;
    const numericId = Number(id.value);
    return Number.isSafeInteger(numericId) && numericId >= 0
      ? this.getMarket(id)
      : this.marketForSlug(id.value);
  }

  private async marketForSlug(slug: string): Promise<Market> {
    const cached = this.marketBySlug.get(slug);
    if (cached !== undefined) return cached;
    const pending = this.pendingMarketBySlug.get(slug);
    if (pending !== undefined) return pending;
    const lookup = this.getMarketBySlug(slug);
    this.pendingMarketBySlug.set(slug, lookup);
    try {
      return await lookup;
    } finally {
      if (this.pendingMarketBySlug.get(slug) === lookup) {
        this.pendingMarketBySlug.delete(slug);
      }
    }
  }

  private async mapPositionWithCanonicalId(
    slug: string,
    value: PolymarketPosition,
  ): Promise<Position | undefined> {
    const market = await this.marketForSlug(slug);
    return mapPosition(slug, value, market.id);
  }

  private async mapOrderWithCanonicalId(
    value: PolymarketOrder,
  ): Promise<ExchangeOrder> {
    const market = await this.marketForSlug(value.marketSlug);
    return mapOrder(value, market.id);
  }

  public async listMarkets(query: MarketQuery = {}): Promise<Page<Market>> {
    try {
      const limit = positiveInteger(
        query.limit ?? this.pageSize,
        "market limit",
      );
      const cursorOffset =
        query.cursor === undefined ? undefined : Number(query.cursor);
      if (
        cursorOffset !== undefined &&
        (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0)
      ) {
        throw new ExchangeError(
          "Market cursor must be a non-negative integer offset",
          "INVALID_REQUEST",
        );
      }
      if (
        query.offset !== undefined &&
        cursorOffset !== undefined &&
        query.offset !== cursorOffset
      ) {
        throw new ExchangeError(
          "Market offset contradicts cursor",
          "INVALID_REQUEST",
        );
      }
      const offset = query.offset ?? cursorOffset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new ExchangeError(
          "Market offset must be a non-negative safe integer",
          "INVALID_REQUEST",
        );
      }
      const params: ExchangeMarketsListParams = {
        limit,
        offset,
        ...(query.active === undefined ? {} : { active: query.active }),
        ...(query.closed === undefined ? {} : { closed: query.closed }),
        ...(query.archived === undefined ? {} : { archived: query.archived }),
        ...(query.orderBy === undefined ? {} : { orderBy: [...query.orderBy] }),
        ...(query.orderDirection === undefined
          ? {}
          : { orderDirection: query.orderDirection }),
        ...(query.minimumVolumeUsd === undefined
          ? {}
          : {
              volumeNumMin: exchangeDecimalString(
                query.minimumVolumeUsd,
                "minimum market volume",
              ),
            }),
      };
      const raw = await this.safeRead(() => this.client.markets.list(params));
      const page = parseSdkResponse(MarketsResponseSchema, raw, "market list");
      const items = page.markets.map((market) =>
        this.rememberMarket(mapMarket(market)),
      );
      const responseEof = "eof" in page ? page.eof : undefined;
      const responseNextCursor =
        "nextCursor" in page ? page.nextCursor : undefined;
      const eof = responseEof ?? items.length < limit;
      const computedNextOffset = offset + items.length;
      if (
        !eof &&
        computedNextOffset === offset &&
        responseNextCursor === undefined
      ) {
        throw new ExchangeError("Market pagination made no progress", "SCHEMA");
      }
      const nextCursor = eof
        ? undefined
        : (responseNextCursor ?? String(computedNextOffset));
      return {
        items,
        eof,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    } catch (error) {
      throw normalizePolymarketError(error, "list markets");
    }
  }

  private groupOffset(cursor: string | undefined): number {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ExchangeError(
        "Market group cursor must be a non-negative integer offset",
        "INVALID_REQUEST",
      );
    }
    return offset;
  }

  private async resolveSeriesId(slug: string): Promise<number | undefined> {
    const cached = this.seriesIdBySlug.get(slug);
    if (cached !== undefined) return cached ?? undefined;
    const raw = await this.safeRead(() =>
      this.client.series.list({ slug: [slug], limit: 2, offset: 0 }),
    );
    const response = parseSdkResponse(SeriesResponseSchema, raw, "series list");
    const matches = response.series.filter((series) => series.slug === slug);
    if (matches.length === 0) {
      this.seriesIdBySlug.set(slug, null);
      return undefined;
    }
    if (matches.length > 1) {
      throw new ExchangeError(
        `Series slug ${slug} did not resolve uniquely`,
        "SCHEMA",
      );
    }
    const id = Number(matches[0]?.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new ExchangeError("Series ID is not a safe integer", "SCHEMA");
    }
    this.seriesIdBySlug.set(slug, id);
    return id;
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
    const offset = this.groupOffset(query.cursor);
    try {
      if (query.kind === "EVENT") {
        const raw = await this.safeRead(() =>
          this.client.markets.list({
            eventSlug: [value],
            active: true,
            closed: false,
            archived: false,
            limit,
            offset,
          }),
        );
        const page = parseSdkResponse(
          MarketsResponseSchema,
          raw,
          "event market members",
        );
        const items = page.markets.map((market) => market.slug);
        const eof =
          ("eof" in page ? page.eof : undefined) ?? items.length < limit;
        const nextOffset = offset + items.length;
        return {
          items,
          eof,
          ...(eof ? {} : { nextCursor: String(nextOffset) }),
        };
      }

      let groupingFilter:
        { readonly tagSlug: string } | { readonly seriesId: number[] };
      if (query.kind === "TAG") {
        groupingFilter = { tagSlug: value };
      } else {
        const seriesId = await this.resolveSeriesId(value);
        if (seriesId === undefined) return { items: [], eof: true };
        groupingFilter = { seriesId: [seriesId] };
      }
      const raw = await this.safeRead(() =>
        this.client.events.list({
          active: true,
          closed: false,
          archived: false,
          limit,
          offset,
          ...groupingFilter,
        }),
      );
      const response = parseSdkResponse(
        EventsResponseSchema,
        raw,
        `${query.kind.toLowerCase()} event members`,
      );
      const items = [
        ...new Set(
          response.events.flatMap((event) =>
            (event.markets ?? []).map((market) => market.slug),
          ),
        ),
      ];
      const eof = response.events.length < limit;
      return {
        items,
        eof,
        ...(eof ? {} : { nextCursor: String(offset + response.events.length) }),
      };
    } catch (error) {
      throw normalizePolymarketError(error, "list market group members");
    }
  }

  public async getMarket(id: MarketId): Promise<Market> {
    assertPolymarketId(id);
    const numericId = Number(id.value);
    if (!Number.isSafeInteger(numericId) || numericId < 0) {
      throw new ExchangeError(
        `Polymarket SDK 0.1.1 requires a numeric market ID, received ${id.value}`,
        "INVALID_REQUEST",
      );
    }
    try {
      const raw = await this.safeRead(() =>
        this.client.markets.retrieve(numericId),
      );
      const market = this.rememberMarket(
        mapMarket(parseSdkResponse(MarketResponseSchema, raw, "market detail")),
      );
      if (Number(market.id.value) !== numericId) {
        throw new ExchangeError(
          "Market response ID contradicts requested ID",
          "SCHEMA",
        );
      }
      return market;
    } catch (error) {
      throw normalizePolymarketError(error, "get market");
    }
  }

  public async getMarketBySlug(slug: string): Promise<Market> {
    if (slug.trim().length === 0) {
      throw new ExchangeError("Market slug cannot be empty", "INVALID_REQUEST");
    }
    try {
      const raw = await this.safeRead(() =>
        this.client.markets.retrieveBySlug(slug),
      );
      const market = this.rememberMarket(
        mapMarket(parseSdkResponse(MarketResponseSchema, raw, "market detail")),
      );
      if (market.slug !== slug) {
        throw new ExchangeError(
          "Market response slug contradicts requested slug",
          "SCHEMA",
        );
      }
      return market;
    } catch (error) {
      throw normalizePolymarketError(error, "get market by slug");
    }
  }

  public async getBbo(id: MarketId): Promise<MarketBbo> {
    try {
      const market = await this.marketForId(id);
      const raw = await this.safeRead(() =>
        this.client.markets.bbo(market.slug),
      );
      const value = parseSdkResponse(BboResponseSchema, raw, "BBO");
      return mapBbo(value, market.id, market.slug, this.now());
    } catch (error) {
      throw normalizePolymarketError(error, "get BBO");
    }
  }

  public async getOrderBook(id: MarketId): Promise<OrderBook> {
    try {
      const market = await this.marketForId(id);
      const raw = await this.safeRead(() =>
        this.client.markets.book(market.slug),
      );
      const value = parseSdkResponse(
        OrderBookResponseSchema,
        raw,
        "order book",
      );
      return mapOrderBook(value, market.id, market.slug, this.now());
    } catch (error) {
      throw normalizePolymarketError(error, "get order book");
    }
  }

  public async getSettlement(id: MarketId): Promise<SettlementStatus> {
    try {
      const market = await this.marketForId(id);
      const raw = await this.safeRead(() =>
        this.client.markets.settlement(market.slug),
      );
      const value = parseSdkResponse(
        SettlementResponseSchema,
        raw,
        "settlement",
      );
      return mapSettlement(value, market.id, market.slug);
    } catch (error) {
      throw normalizePolymarketError(error, "get settlement");
    }
  }

  private async getBalance(): Promise<MappedBalance> {
    const raw = await this.safeRead(() => this.client.account.balances());
    const response = parseSdkResponse(BalancesResponseSchema, raw, "balances");
    if (response.balances.length !== 1) {
      throw new ExchangeError(
        "Expected exactly one USD balance in Polymarket response",
        "SCHEMA",
      );
    }
    const balance = response.balances[0];
    if (balance === undefined) {
      throw new ExchangeError("USD balance was missing", "SCHEMA");
    }
    return mapBalance(balance);
  }

  public async getPositions(): Promise<readonly Position[]> {
    try {
      const values = new Map<string, Position | undefined>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (
        let pageNumber = 0;
        pageNumber < this.maximumPaginationPages;
        pageNumber += 1
      ) {
        const raw = await this.safeRead(() =>
          this.client.portfolio.positions({
            limit: this.pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        const page = parseSdkResponse(
          PositionsResponseSchema,
          raw,
          "positions",
        );
        const resolved = await Promise.all(
          Object.entries(page.positions).map(async ([slug, position]) => {
            if (values.has(slug)) {
              throw new ExchangeError(
                `Position ${slug} was repeated across pagination pages`,
                "SCHEMA",
              );
            }
            return [
              slug,
              await this.mapPositionWithCanonicalId(slug, position),
            ] as const;
          }),
        );
        for (const [slug, position] of resolved) {
          if (values.has(slug)) {
            throw new ExchangeError(
              `Position ${slug} was repeated across pagination pages`,
              "SCHEMA",
            );
          }
          values.set(slug, position);
        }
        if (page.eof) {
          return [...values.values()].filter(
            (position): position is Position => position !== undefined,
          );
        }
        const nextCursor = page.nextCursor;
        if (nextCursor === undefined || seenCursors.has(nextCursor)) {
          throw new ExchangeError(
            "Position pagination cursor loop/incomplete page",
            "SCHEMA",
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new ExchangeError(
        "Position pagination exceeded its page guard",
        "SCHEMA",
      );
    } catch (error) {
      throw normalizePolymarketError(error, "get positions");
    }
  }

  private activityTypes(
    kinds: ActivityQuery["kinds"],
  ): readonly ActivityType[] | undefined {
    if (kinds === undefined) return undefined;
    const values: ActivityType[] = [];
    for (const kind of kinds) {
      if (kind === "TRADE") values.push("ACTIVITY_TYPE_TRADE");
      else if (kind === "RESOLUTION") {
        values.push("ACTIVITY_TYPE_POSITION_RESOLUTION");
      } else {
        values.push(
          "ACTIVITY_TYPE_ACCOUNT_DEPOSIT",
          "ACTIVITY_TYPE_ACCOUNT_ADVANCED_DEPOSIT",
          "ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL",
          "ACTIVITY_TYPE_REFERRAL_BONUS",
          "ACTIVITY_TYPE_TRANSFER",
        );
      }
    }
    return [...new Set(values)];
  }

  public async getActivities(
    query: ActivityQuery = {},
  ): Promise<Page<AccountActivity>> {
    try {
      if (query.kinds?.length === 0) {
        return { items: [], eof: true };
      }
      const pageLimit = positiveInteger(
        query.limit ?? this.pageSize,
        "activity limit",
      );
      const types = this.activityTypes(query.kinds);
      const params: Omit<GetActivitiesParams, "cursor"> = {
        limit: pageLimit,
        ...(query.marketSlug === undefined
          ? {}
          : { marketSlug: query.marketSlug }),
        ...(types === undefined ? {} : { types: [...types] }),
        ...(query.sortOrder === undefined
          ? {}
          : {
              sortOrder:
                query.sortOrder === "ASCENDING"
                  ? "SORT_ORDER_ASCENDING"
                  : "SORT_ORDER_DESCENDING",
            }),
      };
      const seenCursors = new Set<string>();
      const items: AccountActivity[] = [];
      let cursor = query.cursor;
      if (cursor !== undefined) seenCursors.add(cursor);
      for (
        let pageNumber = 0;
        pageNumber < this.maximumPaginationPages;
        pageNumber += 1
      ) {
        const raw = await this.safeRead(() =>
          this.client.portfolio.activities({
            ...params,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        const page = parseSdkResponse(
          ActivitiesResponseSchema,
          raw,
          "activities",
        );
        items.push(...page.activities.flatMap(mapActivity));
        if (page.eof) {
          const filtered = items.filter((activity) => {
            if (query.createdAfter === undefined) return true;
            const timestamp =
              activity.kind === "TRADE"
                ? activity.createdAt
                : activity.kind === "RESOLUTION"
                  ? activity.resolvedAt
                  : activity.createdAt;
            return timestamp > query.createdAfter;
          });
          return { items: filtered, eof: true };
        }
        const nextCursor = page.nextCursor;
        if (nextCursor === undefined || seenCursors.has(nextCursor)) {
          throw new ExchangeError(
            "Activity pagination cursor loop/incomplete page",
            "SCHEMA",
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new ExchangeError(
        "Activity pagination exceeded its page guard",
        "SCHEMA",
      );
    } catch (error) {
      throw normalizePolymarketError(error, "get activities");
    }
  }

  public async getOpenOrders(): Promise<readonly ExchangeOrder[]> {
    try {
      const raw = await this.safeRead(() => this.client.orders.list());
      const response = parseSdkResponse(
        OrdersResponseSchema,
        raw,
        "open orders",
      );
      return await Promise.all(
        response.orders.map((order) => this.mapOrderWithCanonicalId(order)),
      );
    } catch (error) {
      throw normalizePolymarketError(error, "get open orders");
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
      const [balance, positions, openOrders, activities] = await Promise.all([
        limit(() => this.getBalance()),
        limit(() => this.getPositions()),
        limit(() => this.getOpenOrders()),
        limit(() =>
          this.getActivities({
            limit: this.pageSize,
            sortOrder: "DESCENDING",
            createdAfter,
          }),
        ),
      ]);
      return {
        observedAt,
        currentBalance: balance.currentBalance,
        buyingPower: balance.buyingPower,
        assetNotional: balance.assetNotional,
        assetAvailable: balance.assetAvailable,
        openOrderValue: balance.openOrderValue,
        unsettledFunds: balance.unsettledFunds,
        marginRequirement: balance.marginRequirement,
        positions,
        openOrders,
        recentActivities: activities.items,
      };
    } catch (error) {
      throw normalizePolymarketError(error, "get account snapshot");
    }
  }

  private async prepareOrder(order: ImmediateOrder): Promise<PreparedOrder> {
    assertPolymarketId(order.marketId);
    if (order.marketSlug.trim().length === 0) {
      throw new ExchangeError(
        "Order market slug cannot be empty",
        "INVALID_REQUEST",
      );
    }
    if (!order.quantity.isFinite() || order.quantity.lte(0)) {
      throw new ExchangeError(
        "Order quantity must be positive and finite",
        "INVALID_REQUEST",
      );
    }
    if (
      !order.canonicalLimitPrice.isFinite() ||
      order.canonicalLimitPrice.lte(0) ||
      order.canonicalLimitPrice.gte(1)
    ) {
      throw new ExchangeError(
        "Order limit price must be strictly between 0 and 1",
        "INVALID_REQUEST",
      );
    }

    const executionPolicy = order.executionPolicy ?? "IOC";
    if (executionPolicy === "IOC" && order.restUntil !== undefined) {
      throw new ExchangeError(
        "IOC orders cannot specify restUntil",
        "INVALID_REQUEST",
      );
    }
    let goodTillTime: string | undefined;
    if (executionPolicy === "GTD") {
      if (order.action !== "BUY") {
        throw new ExchangeError(
          "Managed GTD orders currently support BUY orders only",
          "UNSUPPORTED",
        );
      }
      if (
        !(order.restUntil instanceof Date) ||
        Number.isNaN(order.restUntil.getTime())
      ) {
        throw new ExchangeError(
          "GTD orders require a valid restUntil",
          "INVALID_REQUEST",
        );
      }
      const remainingLifetime =
        order.restUntil.getTime() - this.now().getTime();
      if (
        remainingLifetime <= 0 ||
        remainingLifetime > MAXIMUM_MANAGED_GTD_LIFETIME_MILLISECONDS
      ) {
        throw new ExchangeError(
          "GTD lifetime must be positive and no longer than 15 minutes",
          "INVALID_REQUEST",
        );
      }
      goodTillTime = order.restUntil.toISOString();
    }

    const market = await this.getMarketBySlug(order.marketSlug);
    if (
      order.marketId.value !== market.id.value &&
      order.marketId.value !== market.slug
    ) {
      throw new ExchangeError(
        "Order market ID contradicts market slug",
        "INVALID_REQUEST",
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
    if (!order.quantity.mod(market.minimumTradeQuantity).isZero()) {
      throw new ExchangeError(
        "Order quantity is not aligned to the market increment",
        "INVALID_REQUEST",
      );
    }

    const conversion = canonicalOrderToPolymarket(order);
    if (
      conversion.submittedYesPrice.lt("0.01") ||
      conversion.submittedYesPrice.gt("0.99")
    ) {
      throw new ExchangeError(
        "Submitted YES price is outside exchange bounds",
        "INVALID_REQUEST",
      );
    }
    if (!conversion.submittedYesPrice.mod(market.priceTick).isZero()) {
      throw new ExchangeError(
        "Order price is not aligned to the market tick",
        "INVALID_REQUEST",
      );
    }
    const quantityNumber = order.quantity.toNumber();
    if (
      !Number.isFinite(quantityNumber) ||
      !new Decimal(quantityNumber).eq(order.quantity)
    ) {
      throw new ExchangeError(
        "Order quantity cannot be represented exactly at the SDK number boundary",
        "INVALID_REQUEST",
      );
    }
    const request: CreateOrderParams = {
      marketSlug: order.marketSlug,
      intent: conversion.intent,
      type: "ORDER_TYPE_LIMIT",
      price: {
        value: conversion.submittedYesPrice.toFixed(),
        currency: "USD",
      },
      quantity: quantityNumber,
      tif:
        executionPolicy === "GTD"
          ? "TIME_IN_FORCE_GOOD_TILL_DATE"
          : "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
      participateDontInitiate: false,
      ...(goodTillTime === undefined ? {} : { goodTillTime }),
      manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
      ...(executionPolicy === "GTD"
        ? { synchronousExecution: false }
        : { synchronousExecution: true, maxBlockTime: "5" }),
    };
    return {
      request,
      submittedYesPrice: conversion.submittedYesPrice,
      executionPolicy,
    };
  }

  public async previewImmediateOrder(
    order: ImmediateOrder,
    purpose: OrderPreviewPurpose,
  ): Promise<OrderPreview> {
    void purpose;
    const prepared = await this.prepareOrder(order);
    try {
      // SDK 0.1.1 requires the documented request envelope.
      const raw = await this.requestGate.run(() =>
        this.client.orders.preview({ request: prepared.request }),
      );
      const response = parseSdkResponse(
        PreviewResponseSchema,
        raw,
        "order preview",
      );
      return {
        ...mapPreview(response),
        basis: "EXCHANGE",
        observedAt: this.now(),
      };
    } catch (error) {
      throw normalizePolymarketError(error, "preview order");
    }
  }

  public createImmediateOrderFeeReserveEstimator(
    order: ImmediateOrder,
  ): Promise<(quantity: Decimal) => Decimal> {
    return Promise.resolve((quantity: Decimal) =>
      estimateTakerFeeUpperBound(
        quantity,
        order.canonicalLimitPrice,
        order.action,
      ),
    );
  }

  public async placeImmediateOrder(
    order: ImmediateOrder,
  ): Promise<ExecutionResult> {
    const prepared = await this.prepareOrder(order);
    let raw: unknown;
    try {
      // Deliberately one attempt: a create request is never passed through read retry.
      raw = await this.requestGate.run(() =>
        this.client.orders.create(prepared.request),
      );
    } catch (error) {
      if (error instanceof BadRequestError) {
        return {
          status: "REJECTED",
          filledQuantity: new Decimal(0),
          fees: new Decimal(0),
          finalState: "REJECTED",
          rejectionReason: error.message,
        };
      }
      if (
        error instanceof AuthenticationError ||
        error instanceof NotFoundError ||
        error instanceof RateLimitError ||
        (error instanceof APIError && error.status >= 400 && error.status < 500)
      ) {
        throw normalizePolymarketError(error, "create order");
      }
      return {
        status: "AMBIGUOUS",
        filledQuantity: new Decimal(0),
        fees: new Decimal(0),
        finalState: "UNKNOWN",
        ambiguousReason:
          error instanceof Error
            ? `Create request outcome is unknown: ${error.message}`
            : "Create request outcome is unknown",
      };
    }

    try {
      const response = parseSdkResponse(
        CreateOrderResponseSchema,
        raw,
        "create order",
      );
      return mapCreateOrderResult(
        response,
        order.marketSlug,
        order.quantity,
        order.side,
        prepared.executionPolicy === "GTD",
      );
    } catch (error) {
      return {
        status: "AMBIGUOUS",
        filledQuantity: new Decimal(0),
        fees: new Decimal(0),
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
      const raw = await this.safeRead(() =>
        this.client.orders.retrieve(orderId),
      );
      const value = parseSdkResponse(OrderResponseSchema, raw, "order detail");
      const order = await this.mapOrderWithCanonicalId(value);
      if (order.id !== orderId) {
        throw new ExchangeError(
          "Order response ID contradicts requested ID",
          "SCHEMA",
        );
      }
      return order;
    } catch (error) {
      throw normalizePolymarketError(error, "get order");
    }
  }

  public async cancelOrder(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    try {
      // Cancel is mutating and therefore is never automatically retried.
      await this.requestGate.run(() =>
        this.client.orders.cancel(orderId, { marketSlug: order.marketSlug }),
      );
    } catch (error) {
      throw normalizePolymarketError(error, "cancel order");
    }
  }
}

export { PolymarketUsExchange as PolymarketUSExchange };

export function createPolymarketUsExchange(
  options: PolymarketUsExchangeOptions = {},
): PolymarketUsExchange {
  return new PolymarketUsExchange(options);
}
