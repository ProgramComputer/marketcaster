import { Decimal } from "decimal.js";
import pLimit from "p-limit";
import type { AccountSnapshot } from "../domain/account.js";
import type {
  Market,
  MarketBbo,
  MarketMetricBasis,
  MarketMetricWindow,
  OrderBook,
} from "../domain/market.js";
import { serializeDecimal } from "../domain/primitives.js";
import {
  ExchangeError,
  type PredictionExchange,
} from "../exchanges/exchange.js";

export type MarketDiscoveryMode =
  | "ALL"
  | "KEYWORD"
  | "CATEGORY"
  | "TAG"
  | "EVENT"
  | "SERIES"
  | "VOLUME"
  | "VOLATILITY"
  | "TRENDING"
  | "EXPIRING";

export interface MarketDiscoveryRequest {
  readonly mode: MarketDiscoveryMode;
  readonly query?: string | undefined;
  readonly category?: string | undefined;
  readonly tag?: string | undefined;
  readonly event?: string | undefined;
  readonly series?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly closesAfter?: Date | undefined;
  readonly closesBefore?: Date | undefined;
  readonly minimumLiquidityUsd?: Decimal | undefined;
  readonly minimumVolumeUsd?: Decimal | undefined;
  readonly minimumPriceMovement?: Decimal | undefined;
  readonly maximumSpread?: Decimal | undefined;
  readonly minimumBookDepth?: Decimal | undefined;
  readonly bookDepthWithinPricePoints?: Decimal | undefined;
  readonly minimumOpenInterest?: Decimal | undefined;
  readonly minimumYesPrice?: Decimal | undefined;
  readonly maximumYesPrice?: Decimal | undefined;
  readonly yesPriceBasis?: "LAST_TRADE" | "BOOK_MIDPOINT" | undefined;
  readonly maximumDataAgeSeconds?: number | undefined;
}

export interface MarketCatalogRow {
  readonly exchangeRank: number;
  readonly slug: string;
  readonly title: string;
  readonly eventId?: string;
  readonly eventSlug?: string;
  readonly seriesId?: string;
  readonly seriesSlug?: string;
  readonly tags?: readonly string[];
  readonly category: string;
  readonly subcategory?: string;
  readonly closesAt?: string;
  readonly liquidityUsd?: string;
  readonly volumeUsd?: string;
  readonly volume24hUsd?: string;
  readonly minimumVolumeSatisfiedUsd?: string;
  readonly priceMovement?: string;
  readonly priceMovementWindow?: MarketMetricWindow;
  readonly priceMovementBasis?: MarketMetricBasis;
  readonly volatility?: string;
  readonly volatilityWindow?: MarketMetricWindow;
  readonly volatilityBasis?: MarketMetricBasis;
  readonly openInterest?: string;
  readonly yesPrice?: string;
  readonly yesPriceBasis?: "LAST_TRADE" | "CURRENT_PRICE" | "BOOK_MIDPOINT";
  readonly spread?: string;
  readonly bookDepth?: string;
  readonly bookDepthWithinPricePoints?: string;
  readonly dataObservedAt?: string;
  readonly dataAgeSeconds?: number;
  readonly dataObservationBasis?: "EXCHANGE_BOOK_TIMESTAMP";
  readonly held: boolean;
}

export interface MarketMetricCoverage {
  readonly candidateCount: number;
  readonly evaluatedCount: number;
  readonly availableCount: number;
  readonly truncated: boolean;
}

export interface MarketDiscoveryMetricCoverage {
  readonly priceMovement?: MarketMetricCoverage;
  readonly volatility?: MarketMetricCoverage;
  readonly spread?: MarketMetricCoverage;
  readonly bookDepth?: MarketMetricCoverage;
  readonly openInterest?: MarketMetricCoverage;
  readonly yesPrice?: MarketMetricCoverage;
  readonly dataAge?: MarketMetricCoverage;
}

export interface MarketDiscoveryAppliedMetricFilter {
  readonly metric: "totalVolumeUsd";
  readonly minimum: string;
  readonly basis: "EXCHANGE_VOLUME_NUM_MIN";
}

export interface MarketDiscoveryAppliedGroupFilter {
  readonly metric: "tag" | "event" | "series";
  readonly value: string;
  readonly basis: "EXCHANGE_GROUP_MEMBERSHIP";
}

export type MarketDiscoveryAppliedFilter =
  MarketDiscoveryAppliedMetricFilter | MarketDiscoveryAppliedGroupFilter;

export interface MarketDiscoveryPage {
  readonly mode: MarketDiscoveryMode;
  readonly catalogCount: number;
  readonly matchedCount: number;
  readonly items: readonly MarketCatalogRow[];
  readonly nextCursor?: string;
  readonly eof: boolean;
  readonly unavailableMetrics: readonly string[];
  readonly rankingBasis: string;
  readonly metricCoverage?: MarketDiscoveryMetricCoverage;
  readonly appliedFilters?: readonly MarketDiscoveryAppliedFilter[];
}

export type MarketFacetKind = "CATEGORY" | "TAG" | "SERIES" | "EVENT";

export interface MarketFacetRequest {
  readonly kind?: MarketFacetKind | undefined;
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MarketFacetItem {
  readonly kind: MarketFacetKind;
  readonly value: string;
  readonly label?: string;
  readonly marketCount: number;
}

export interface MarketFacetPage {
  readonly catalogCount: number;
  readonly matchedCount: number;
  readonly items: readonly MarketFacetItem[];
  readonly nextCursor?: string;
  readonly eof: boolean;
  readonly rankingBasis: "MARKET_COUNT_DESC_THEN_NAME_ASC";
}

export type MarketDiscoveryBookMetric =
  | "PRICE_MOVEMENT"
  | "SPREAD"
  | "BOOK_DEPTH"
  | "OPEN_INTEREST"
  | "YES_PRICE"
  | "DATA_AGE";

export interface MarketDiscoveryNarrowingRequired {
  readonly code: "MARKET_DISCOVERY_NARROWING_REQUIRED";
  readonly requestMode: MarketDiscoveryMode;
  readonly candidateCount: number;
  readonly bookEnrichmentCandidateCount: number;
  readonly cachedBookCandidateCount: number;
  readonly requiredNewBookRequestCount: number;
  readonly remainingNewBookRequestBudget: number;
  readonly maximumBookMetricCandidates: number;
  readonly requestedBookMetrics: readonly MarketDiscoveryBookMetric[];
  readonly suggestedModes: readonly (
    "KEYWORD" | "CATEGORY" | "TAG" | "EVENT" | "SERIES"
  )[];
  readonly suggestedCheapFilters: readonly (
    "closesAfter" | "closesBefore" | "minimumLiquidityUsd" | "minimumVolumeUsd"
  )[];
}

export class MarketDiscoveryNarrowingRequiredError extends Error {
  public readonly code = "MARKET_DISCOVERY_NARROWING_REQUIRED" as const;

  public constructor(
    public readonly details: MarketDiscoveryNarrowingRequired,
  ) {
    super(
      `Book-backed discovery requires ${details.requiredNewBookRequestCount} new market reads but only ${details.remainingNewBookRequestBudget} remain; narrow the candidate set first`,
    );
    this.name = "MarketDiscoveryNarrowingRequiredError";
  }

  public toJSON(): MarketDiscoveryNarrowingRequired {
    return this.details;
  }
}

export interface MarketCatalog {
  readonly markets: readonly Market[];
  readonly bySlug: ReadonlyMap<string, Market>;
  readonly exchangeRanks: ReadonlyMap<string, number>;
  readonly heldSlugs: ReadonlySet<string>;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly exchangeRankingBasis: "VOLUME_DESC" | "EXCHANGE_DEFAULT";
  readonly warnings: readonly string[];
}

export interface MarketCatalogOptions {
  readonly pageSize?: number;
  readonly maximumPages?: number;
  /** Offset-page concurrency. Only safe for exchanges with numeric offsets. */
  readonly maximumConcurrentPages?: number;
  readonly signal?: AbortSignal;
}

export interface ResolvedMarketDetails {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly held: boolean;
  readonly warnings: readonly string[];
}

function normalizedCategory(market: Market): string {
  const category = market.category?.trim();
  return category === undefined || category.length === 0
    ? "Uncategorized"
    : category;
}

function categoryCounts(
  markets: readonly Market[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const market of markets) {
    const category = normalizedCategory(market);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

const MARKET_FACET_KINDS: ReadonlySet<MarketFacetKind> = new Set([
  "CATEGORY",
  "TAG",
  "SERIES",
  "EVENT",
]);

interface MutableMarketFacet {
  readonly kind: MarketFacetKind;
  value: string;
  label?: string;
  readonly marketSlugs: Set<string>;
}

function parseFacetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) {
    throw new TypeError("Market facet cursor must be a non-negative offset");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new TypeError("Market facet cursor exceeds the safe integer range");
  }
  return offset;
}

function compareFacetName(left: string, right: string): number {
  const insensitive = left.localeCompare(right, "en-US", {
    sensitivity: "base",
  });
  return insensitive === 0 ? left.localeCompare(right, "en-US") : insensitive;
}

export function searchMarketFacets(
  catalog: MarketCatalog,
  request: MarketFacetRequest = {},
): MarketFacetPage {
  const limit = request.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new RangeError("Market facet limit must be an integer from 1 to 100");
  }
  if (request.kind !== undefined && !MARKET_FACET_KINDS.has(request.kind)) {
    throw new TypeError("Market facet kind is invalid");
  }
  const query = request.query?.trim().toLocaleLowerCase("en-US");
  if (query !== undefined && query.length > 200) {
    throw new RangeError("Market facet query cannot exceed 200 characters");
  }
  const offset = parseFacetCursor(request.cursor);
  const facets = new Map<string, MutableMarketFacet>();
  const addFacet = (
    market: Market,
    kind: MarketFacetKind,
    rawValue: string | undefined,
    rawLabel?: string,
  ): void => {
    const value = rawValue?.trim();
    if (value === undefined || value.length === 0) return;
    const label = rawLabel?.trim();
    const key = `${kind}:${value.toLocaleLowerCase("en-US")}`;
    const existing = facets.get(key);
    if (existing === undefined) {
      facets.set(key, {
        kind,
        value,
        ...(label === undefined || label.length === 0 ? {} : { label }),
        marketSlugs: new Set([market.slug]),
      });
      return;
    }
    existing.marketSlugs.add(market.slug);
    if (compareFacetName(value, existing.value) < 0) existing.value = value;
    if (
      label !== undefined &&
      label.length > 0 &&
      (existing.label === undefined ||
        compareFacetName(label, existing.label) < 0)
    ) {
      existing.label = label;
    }
  };

  for (const market of catalog.markets) {
    addFacet(market, "CATEGORY", normalizedCategory(market));
    for (const tag of market.tags ?? []) {
      addFacet(market, "TAG", tag.slug, tag.label);
    }
    addFacet(market, "SERIES", market.seriesSlug);
    addFacet(market, "EVENT", market.eventSlug);
  }

  const indexed = [...facets.values()]
    .filter(
      (facet) => request.kind === undefined || facet.kind === request.kind,
    )
    .filter((facet) => {
      if (query === undefined || query.length === 0) return true;
      return [facet.value, facet.label]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLocaleLowerCase("en-US").includes(query));
    })
    .map((facet): MarketFacetItem => ({
      kind: facet.kind,
      value: facet.value,
      ...(facet.label === undefined ? {} : { label: facet.label }),
      marketCount: facet.marketSlugs.size,
    }))
    .sort((left, right) => {
      const countOrder = right.marketCount - left.marketCount;
      if (countOrder !== 0) return countOrder;
      const nameOrder = compareFacetName(
        left.label ?? left.value,
        right.label ?? right.value,
      );
      if (nameOrder !== 0) return nameOrder;
      const valueOrder = compareFacetName(left.value, right.value);
      if (valueOrder !== 0) return valueOrder;
      return left.kind.localeCompare(right.kind, "en-US");
    });
  const matchedCount = indexed.length;
  const items = indexed.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const eof = nextOffset >= matchedCount;
  return {
    catalogCount: catalog.markets.length,
    matchedCount,
    items,
    ...(eof ? {} : { nextCursor: String(nextOffset) }),
    eof,
    rankingBasis: "MARKET_COUNT_DESC_THEN_NAME_ASC",
  };
}

async function listEntireUniverse(
  exchange: PredictionExchange,
  pageSize: number,
  maximumPages: number,
  minimumVolumeUsd?: Decimal,
  signal?: AbortSignal,
  maximumConcurrentPages = 1,
): Promise<readonly Market[]> {
  const markets: Market[] = [];
  const identities = new Map<string, string>();
  const append = (items: readonly Market[]): void => {
    for (const market of items) {
      const knownId = identities.get(market.slug);
      if (knownId !== undefined && knownId !== market.id.value) {
        throw new Error(`Conflicting identifiers for market ${market.slug}`);
      }
      if (knownId === undefined) {
        identities.set(market.slug, market.id.value);
        markets.push(market);
      }
    }
  };

  if (maximumConcurrentPages > 1) {
    if (exchange.id !== "polymarket-us") {
      throw new Error(
        "Concurrent catalog pagination requires a numeric-offset exchange",
      );
    }
    for (
      let batchStart = 0;
      batchStart < maximumPages;
      batchStart += maximumConcurrentPages
    ) {
      signal?.throwIfAborted();
      const pageNumbers = Array.from(
        {
          length: Math.min(maximumConcurrentPages, maximumPages - batchStart),
        },
        (_, index) => batchStart + index,
      );
      const pages = await Promise.all(
        pageNumbers.map((pageNumber) =>
          exchange.listMarkets({
            active: true,
            closed: false,
            archived: false,
            limit: pageSize,
            offset: pageNumber * pageSize,
            orderBy: ["volume"],
            orderDirection: "desc",
            ...(minimumVolumeUsd === undefined ? {} : { minimumVolumeUsd }),
          }),
        ),
      );
      signal?.throwIfAborted();
      for (const page of pages) {
        append(page.items);
        if (page.eof) return markets;
        if (page.items.length === 0) {
          throw new Error("Market offset pagination made no progress");
        }
      }
    }
    throw new Error(`Market discovery exceeded the ${maximumPages}-page guard`);
  }

  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    signal?.throwIfAborted();
    const page = await exchange.listMarkets({
      active: true,
      closed: false,
      archived: false,
      limit: pageSize,
      ...(exchange.id === "polymarket-us"
        ? { orderBy: ["volume"], orderDirection: "desc" as const }
        : {}),
      ...(minimumVolumeUsd === undefined ? {} : { minimumVolumeUsd }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    append(page.items);
    if (page.eof) return markets;
    if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
      throw new Error(
        "Market pagination was incomplete or entered a cursor loop",
      );
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`Market discovery exceeded the ${maximumPages}-page guard`);
}

export async function discoverMarketCatalog(
  exchange: PredictionExchange,
  snapshot: AccountSnapshot,
  options: MarketCatalogOptions = {},
): Promise<MarketCatalog> {
  const pageSize = options.pageSize ?? 100;
  const maximumPages = options.maximumPages ?? 1_000;
  const maximumConcurrentPages = options.maximumConcurrentPages ?? 1;
  if (
    !Number.isSafeInteger(maximumConcurrentPages) ||
    maximumConcurrentPages < 1
  ) {
    throw new RangeError("maximumConcurrentPages must be a positive integer");
  }
  const markets = [
    ...(await listEntireUniverse(
      exchange,
      pageSize,
      maximumPages,
      undefined,
      options.signal,
      maximumConcurrentPages,
    )),
  ];
  const bySlug = new Map(markets.map((market) => [market.slug, market]));
  const exchangeRanks = new Map(
    markets.map((market, index) => [market.slug, index + 1]),
  );
  const heldSlugs = new Set(
    snapshot.positions.map((position) => position.marketSlug),
  );
  const warnings: string[] = [];

  for (const slug of heldSlugs) {
    if (bySlug.has(slug)) continue;
    options.signal?.throwIfAborted();
    try {
      const market = await exchange.getMarketBySlug(slug);
      bySlug.set(slug, market);
      markets.push(market);
      exchangeRanks.set(slug, markets.length);
    } catch (error) {
      throw new Error(`Held market ${slug} could not be reconstructed`, {
        cause: error,
      });
    }
  }

  if (exchange.id === "polymarket-us") {
    warnings.push(
      "Catalog order requested exchange cumulative-volume ranking; exact numeric volume and liquidity may be omitted, while volume thresholds and bounded session-stat metrics are resolved on demand",
    );
  }

  return {
    markets: Object.freeze(markets),
    bySlug,
    exchangeRanks,
    heldSlugs,
    categoryCounts: categoryCounts(markets),
    exchangeRankingBasis:
      exchange.id === "polymarket-us" ? "VOLUME_DESC" : "EXCHANGE_DEFAULT",
    warnings: Object.freeze(warnings),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) {
    throw new TypeError("Discovery cursor must be a non-negative offset");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new TypeError("Discovery cursor exceeds the safe integer range");
  }
  return offset;
}

function keywordScore(market: Market, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const tokens = [
    ...new Set(
      normalizedQuery
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => token.length >= 2) ?? [],
    ),
  ];
  const searchable = [
    market.slug,
    market.eventId,
    market.eventSlug,
    market.seriesId,
    market.seriesSlug,
    ...(market.tags?.flatMap((tag) => [tag.slug, tag.label]) ?? []),
    market.title,
    market.description,
    market.settlementRules,
    market.category,
    market.subcategory,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLocaleLowerCase("en-US");
  const tokenScore = tokens.reduce(
    (score, token) => score + (searchable.includes(token) ? 1 : 0),
    0,
  );
  return searchable.includes(normalizedQuery)
    ? tokenScore + tokens.length + 1
    : tokenScore;
}

function volumeMetric(market: Market): Decimal | undefined {
  return market.volume;
}

interface MarketMetricCarrier {
  readonly priceMovement?: Decimal;
  readonly priceMovementWindow?: MarketMetricWindow;
  readonly priceMovementBasis?: MarketMetricBasis;
  readonly volatility?: Decimal;
  readonly volatilityWindow?: MarketMetricWindow;
  readonly volatilityBasis?: MarketMetricBasis;
}

interface PriceMovementMetricFields {
  readonly priceMovement: Decimal;
  readonly priceMovementWindow: MarketMetricWindow;
  readonly priceMovementBasis: MarketMetricBasis;
}

interface VolatilityMetricFields {
  readonly volatility: Decimal;
  readonly volatilityWindow: MarketMetricWindow;
  readonly volatilityBasis: MarketMetricBasis;
}

function priceMovementFields(
  market: MarketMetricCarrier,
): PriceMovementMetricFields | undefined {
  const { priceMovement, priceMovementWindow, priceMovementBasis } = market;
  return priceMovement === undefined ||
    !priceMovement.isFinite() ||
    priceMovement.lt(0) ||
    priceMovement.gt(1) ||
    priceMovementWindow === undefined ||
    priceMovementBasis === undefined
    ? undefined
    : { priceMovement, priceMovementWindow, priceMovementBasis };
}

function hasPriceMovementMetric(market: MarketMetricCarrier): boolean {
  return priceMovementFields(market) !== undefined;
}

function priceMovementMetric(market: MarketMetricCarrier): Decimal | undefined {
  return priceMovementFields(market)?.priceMovement;
}

function volatilityFields(
  market: MarketMetricCarrier,
): VolatilityMetricFields | undefined {
  const { volatility, volatilityWindow, volatilityBasis } = market;
  return volatility === undefined ||
    !volatility.isFinite() ||
    volatility.lt(0) ||
    volatility.gt(1) ||
    volatilityWindow === undefined ||
    volatilityBasis === undefined
    ? undefined
    : { volatility, volatilityWindow, volatilityBasis };
}

interface MarketQualitySnapshot {
  readonly spread?: Decimal;
  readonly bookDepth?: Decimal;
  readonly bookDepthWithinPricePoints?: Decimal;
  readonly openInterest?: Decimal;
  readonly lastTradePrice?: Decimal;
  readonly bookMidpoint?: Decimal;
  readonly dataObservedAt?: Date;
  readonly dataAgeSeconds?: number;
  readonly dataObservationBasis?: "EXCHANGE_BOOK_TIMESTAMP";
}

// Exchange clocks can differ slightly from the cycle clock. A timestamp more
// than five seconds in the future is not credible evidence of fresh data.
const MAXIMUM_EXCHANGE_CLOCK_SKEW_SECONDS = 5;

function sumQuantities(
  levels: readonly { readonly quantity: Decimal }[],
): Decimal {
  return levels.reduce(
    (total, level) => total.plus(level.quantity),
    new Decimal(0),
  );
}

function qualitySnapshot(
  market: Market,
  book: OrderBook | undefined,
  observedAt: Date,
  bookDepthWithinPricePoints: Decimal,
): MarketQualitySnapshot {
  const bestBid = book?.yesBids[0]?.price;
  const bestAsk = book?.yesAsks[0]?.price;
  const midpoint =
    bestBid === undefined || bestAsk === undefined
      ? undefined
      : bestBid.plus(bestAsk).div(2);
  const lastTradePrice = market.lastPrice ?? book?.lastPrice;
  const spread =
    bestBid === undefined || bestAsk === undefined
      ? undefined
      : bestAsk.minus(bestBid);
  const bookDepth =
    book === undefined || book.yesBids.length === 0 || book.yesAsks.length === 0
      ? undefined
      : Decimal.min(
          sumQuantities(
            book.yesBids.filter((level) =>
              bestBid === undefined
                ? false
                : level.price.gte(bestBid.minus(bookDepthWithinPricePoints)),
            ),
          ),
          sumQuantities(
            book.yesAsks.filter((level) =>
              bestAsk === undefined
                ? false
                : level.price.lte(bestAsk.plus(bookDepthWithinPricePoints)),
            ),
          ),
        );
  const exchangeBookTimestamp =
    book?.observationBasis === "EXCHANGE_TIMESTAMP"
      ? book.observedAt
      : undefined;
  const dataObservedAt = exchangeBookTimestamp;
  const dataObservationBasis =
    exchangeBookTimestamp === undefined
      ? undefined
      : ("EXCHANGE_BOOK_TIMESTAMP" as const);
  const rawDataAgeSeconds =
    dataObservedAt === undefined
      ? undefined
      : (observedAt.getTime() - dataObservedAt.getTime()) / 1_000;
  const dataAgeSeconds =
    rawDataAgeSeconds === undefined ||
    rawDataAgeSeconds < -MAXIMUM_EXCHANGE_CLOCK_SKEW_SECONDS
      ? undefined
      : Math.max(0, rawDataAgeSeconds);
  const openInterest = market.openInterest ?? book?.openInterest;
  return {
    ...(spread === undefined ? {} : { spread }),
    ...(bookDepth === undefined ? {} : { bookDepth }),
    ...(bookDepth === undefined ? {} : { bookDepthWithinPricePoints }),
    ...(openInterest === undefined ? {} : { openInterest }),
    ...(lastTradePrice === undefined ? {} : { lastTradePrice }),
    ...(midpoint === undefined ? {} : { bookMidpoint: midpoint }),
    ...(dataObservedAt === undefined ? {} : { dataObservedAt }),
    ...(dataAgeSeconds === undefined ? {} : { dataAgeSeconds }),
    ...(dataObservationBasis === undefined ? {} : { dataObservationBasis }),
  };
}

function selectedYesPrice(
  snapshot: MarketQualitySnapshot | undefined,
  basis: MarketDiscoveryRequest["yesPriceBasis"],
): Decimal | undefined {
  if (snapshot === undefined || basis === undefined) return undefined;
  return basis === "LAST_TRADE"
    ? snapshot.lastTradePrice
    : snapshot.bookMidpoint;
}

function hasVolatilityMetric(market: MarketMetricCarrier): boolean {
  return volatilityFields(market) !== undefined;
}

function marketRow(
  market: Market,
  exchangeRank: number,
  heldSlugs: ReadonlySet<string>,
  verifiedMinimumVolumeUsd?: Decimal,
  quality?: MarketQualitySnapshot,
  request?: MarketDiscoveryRequest,
): MarketCatalogRow {
  const priceMovement = priceMovementFields(market);
  const volatility = volatilityFields(market);
  const yesPrice = selectedYesPrice(quality, request?.yesPriceBasis);
  const openInterest = market.openInterest ?? quality?.openInterest;
  return {
    exchangeRank,
    slug: market.slug,
    title: market.title,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    ...(market.tags === undefined
      ? {}
      : { tags: market.tags.map((tag) => tag.slug) }),
    category: normalizedCategory(market),
    ...(market.subcategory === undefined
      ? {}
      : { subcategory: market.subcategory }),
    ...(market.closesAt === undefined
      ? {}
      : { closesAt: market.closesAt.toISOString() }),
    ...(market.liquidity === undefined
      ? {}
      : { liquidityUsd: serializeDecimal(market.liquidity) }),
    ...(market.volume === undefined
      ? verifiedMinimumVolumeUsd === undefined
        ? {}
        : {
            minimumVolumeSatisfiedUsd: serializeDecimal(
              verifiedMinimumVolumeUsd,
            ),
          }
      : { volumeUsd: serializeDecimal(market.volume) }),
    ...(market.volume24h === undefined
      ? {}
      : { volume24hUsd: serializeDecimal(market.volume24h) }),
    ...(priceMovement === undefined
      ? {}
      : {
          priceMovement: serializeDecimal(priceMovement.priceMovement),
          priceMovementWindow: priceMovement.priceMovementWindow,
          priceMovementBasis: priceMovement.priceMovementBasis,
        }),
    ...(volatility === undefined
      ? {}
      : {
          volatility: serializeDecimal(volatility.volatility),
          volatilityWindow: volatility.volatilityWindow,
          volatilityBasis: volatility.volatilityBasis,
        }),
    ...(openInterest === undefined
      ? {}
      : { openInterest: serializeDecimal(openInterest) }),
    ...(yesPrice === undefined || request?.yesPriceBasis === undefined
      ? {}
      : {
          yesPrice: serializeDecimal(yesPrice),
          yesPriceBasis: request.yesPriceBasis,
        }),
    ...(quality?.spread === undefined
      ? {}
      : { spread: serializeDecimal(quality.spread) }),
    ...(quality?.bookDepth === undefined ||
    quality.bookDepthWithinPricePoints === undefined
      ? {}
      : {
          bookDepth: serializeDecimal(quality.bookDepth),
          bookDepthWithinPricePoints: serializeDecimal(
            quality.bookDepthWithinPricePoints,
          ),
        }),
    ...(quality?.dataObservedAt === undefined
      ? {}
      : { dataObservedAt: quality.dataObservedAt.toISOString() }),
    ...(quality?.dataAgeSeconds === undefined
      ? {}
      : { dataAgeSeconds: quality.dataAgeSeconds }),
    ...(quality?.dataObservationBasis === undefined
      ? {}
      : { dataObservationBasis: quality.dataObservationBasis }),
    held: heldSlugs.has(market.slug),
  };
}

type IndexedMarket = readonly [market: Market, exchangeRank: number];

function compareOptionalMetric(
  metric: (market: Market) => Decimal | undefined,
  left: IndexedMarket,
  right: IndexedMarket,
): number {
  const leftMetric = metric(left[0]);
  const rightMetric = metric(right[0]);
  if (leftMetric !== undefined && rightMetric !== undefined) {
    const order = rightMetric.cmp(leftMetric);
    if (order !== 0) return order;
  } else if (leftMetric !== undefined) {
    return -1;
  } else if (rightMetric !== undefined) {
    return 1;
  }
  return left[1] - right[1];
}

interface SearchMarketCatalogOptions {
  readonly verifiedMinimumVolumeUsd?: Decimal;
  readonly catalogCount?: number;
  readonly metricCoverage?: MarketDiscoveryMetricCoverage;
  readonly appliedFilters?: readonly MarketDiscoveryAppliedFilter[];
  readonly rankingBasisOverride?: string;
  readonly qualityBySlug?: ReadonlyMap<string, MarketQualitySnapshot>;
  readonly unavailableMetrics?: readonly string[];
}

interface CatalogSearchState {
  readonly indexed: readonly IndexedMarket[];
  readonly unavailableMetrics: ReadonlySet<string>;
  readonly rankingBasis: string;
}

const MARKET_DISCOVERY_MODE_SELECTORS = [
  ["KEYWORD", "query"],
  ["CATEGORY", "category"],
  ["TAG", "tag"],
  ["EVENT", "event"],
  ["SERIES", "series"],
] as const satisfies readonly (readonly [
  MarketDiscoveryMode,
  "query" | "category" | "tag" | "event" | "series",
])[];

function validateDiscoveryRequest(request: MarketDiscoveryRequest): void {
  const limit = request.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 25) {
    throw new RangeError("Discovery limit must be an integer from 1 to 25");
  }
  parseCursor(request.cursor);
  for (const [fieldName, value] of [
    ["minimumLiquidityUsd", request.minimumLiquidityUsd],
    ["minimumVolumeUsd", request.minimumVolumeUsd],
    ["minimumPriceMovement", request.minimumPriceMovement],
    ["maximumSpread", request.maximumSpread],
    ["minimumBookDepth", request.minimumBookDepth],
    ["bookDepthWithinPricePoints", request.bookDepthWithinPricePoints],
    ["minimumOpenInterest", request.minimumOpenInterest],
    ["minimumYesPrice", request.minimumYesPrice],
    ["maximumYesPrice", request.maximumYesPrice],
  ] as const) {
    if (value !== undefined && (!value.isFinite() || value.lt(0))) {
      throw new RangeError(`${fieldName} must be non-negative and finite`);
    }
  }
  if (request.minimumPriceMovement?.gt(1) === true) {
    throw new RangeError(
      "minimumPriceMovement must be a probability-point delta from 0 to 1",
    );
  }
  for (const [fieldName, value] of [
    ["maximumSpread", request.maximumSpread],
    ["bookDepthWithinPricePoints", request.bookDepthWithinPricePoints],
    ["minimumYesPrice", request.minimumYesPrice],
    ["maximumYesPrice", request.maximumYesPrice],
  ] as const) {
    if (value?.gt(1) === true) {
      throw new RangeError(`${fieldName} must be from 0 to 1`);
    }
  }
  if (
    request.minimumYesPrice !== undefined &&
    request.maximumYesPrice !== undefined &&
    request.minimumYesPrice.gt(request.maximumYesPrice)
  ) {
    throw new RangeError("minimumYesPrice cannot exceed maximumYesPrice");
  }
  if (
    (request.minimumYesPrice !== undefined ||
      request.maximumYesPrice !== undefined) &&
    request.yesPriceBasis === undefined
  ) {
    throw new TypeError("Price-band filters require yesPriceBasis");
  }
  if (request.minimumBookDepth !== undefined) {
    if (request.bookDepthWithinPricePoints === undefined) {
      throw new TypeError(
        "minimumBookDepth requires bookDepthWithinPricePoints",
      );
    }
  } else if (request.bookDepthWithinPricePoints !== undefined) {
    throw new TypeError("bookDepthWithinPricePoints requires minimumBookDepth");
  }
  if (
    request.maximumDataAgeSeconds !== undefined &&
    (!Number.isSafeInteger(request.maximumDataAgeSeconds) ||
      request.maximumDataAgeSeconds < 0)
  ) {
    throw new RangeError(
      "maximumDataAgeSeconds must be a non-negative safe integer",
    );
  }
  for (const [mode, field] of MARKET_DISCOVERY_MODE_SELECTORS) {
    const selector = request[field];
    if (request.mode === mode) {
      if (selector === undefined || selector.trim().length === 0) {
        throw new TypeError(`${mode} discovery requires ${field}`);
      }
    } else if (selector !== undefined) {
      throw new TypeError(`${field} is only valid for ${mode} discovery`);
    }
  }
  if (
    request.closesAfter !== undefined &&
    request.closesBefore !== undefined &&
    request.closesAfter >= request.closesBefore
  ) {
    throw new RangeError("closesBefore must be later than closesAfter");
  }
}

function buildCatalogSearchState(
  catalog: MarketCatalog,
  request: MarketDiscoveryRequest,
  observedAt: Date,
  options: SearchMarketCatalogOptions,
): CatalogSearchState {
  const unavailableMetrics = new Set<string>();
  for (const metric of options.unavailableMetrics ?? []) {
    unavailableMetrics.add(metric);
  }
  const closesAfter =
    request.closesAfter ??
    (request.mode === "EXPIRING" ? observedAt : undefined);
  let rankingBasis = "EXCHANGE_ORDER";
  let indexed: IndexedMarket[] = catalog.markets.map((market, index) => [
    market,
    catalog.exchangeRanks.get(market.slug) ?? index + 1,
  ]);

  if (request.mode === "KEYWORD") {
    const query = request.query?.trim();
    if (query === undefined || query.length === 0) {
      throw new TypeError("KEYWORD discovery requires a query");
    }
    const scores = new Map(
      indexed.map(([market]) => [market.slug, keywordScore(market, query)]),
    );
    indexed = indexed
      .filter(([market]) => (scores.get(market.slug) ?? 0) > 0)
      .sort((left, right) => {
        const scoreOrder =
          (scores.get(right[0].slug) ?? 0) - (scores.get(left[0].slug) ?? 0);
        return scoreOrder === 0 ? left[1] - right[1] : scoreOrder;
      });
    rankingBasis = "KEYWORD_RELEVANCE_THEN_EXCHANGE_ORDER";
  }
  if (request.mode === "CATEGORY") {
    const category = request.category?.trim().toLocaleLowerCase("en-US");
    if (category === undefined || category.length === 0) {
      throw new TypeError("CATEGORY discovery requires a category");
    }
    indexed = indexed.filter(
      ([market]) =>
        normalizedCategory(market).toLocaleLowerCase("en-US") === category ||
        market.subcategory?.toLocaleLowerCase("en-US") === category,
    );
    rankingBasis = "CATEGORY_THEN_EXCHANGE_ORDER";
  }
  if (request.mode === "TAG") rankingBasis = "TAG_THEN_EXCHANGE_ORDER";
  if (request.mode === "EVENT") rankingBasis = "EVENT_THEN_EXCHANGE_ORDER";
  if (request.mode === "SERIES") rankingBasis = "SERIES_THEN_EXCHANGE_ORDER";

  indexed = indexed.filter(([market]) => {
    const quality = options.qualityBySlug?.get(market.slug);
    if (
      closesAfter !== undefined &&
      (market.closesAt === undefined || market.closesAt <= closesAfter)
    ) {
      return false;
    }
    if (
      request.closesBefore !== undefined &&
      (market.closesAt === undefined || market.closesAt >= request.closesBefore)
    ) {
      return false;
    }
    if (request.minimumLiquidityUsd !== undefined) {
      if (market.liquidity === undefined) {
        unavailableMetrics.add("liquidityUsd");
        return false;
      }
      if (market.liquidity.lt(request.minimumLiquidityUsd)) return false;
    }
    if (request.minimumVolumeUsd !== undefined) {
      const volume = volumeMetric(market);
      if (volume === undefined) {
        unavailableMetrics.add("volumeUsd");
        if (
          options.verifiedMinimumVolumeUsd === undefined ||
          options.verifiedMinimumVolumeUsd.lt(request.minimumVolumeUsd)
        ) {
          return false;
        }
      } else if (volume.lt(request.minimumVolumeUsd)) {
        return false;
      }
    }
    if (request.minimumPriceMovement !== undefined) {
      const priceMovement = priceMovementMetric(market);
      if (priceMovement === undefined) {
        unavailableMetrics.add("priceMovement");
        return false;
      }
      if (priceMovement.lt(request.minimumPriceMovement)) return false;
    }
    if (request.maximumSpread !== undefined) {
      if (quality?.spread === undefined) {
        unavailableMetrics.add("spread");
        return false;
      }
      if (quality.spread.gt(request.maximumSpread)) return false;
    }
    if (request.minimumBookDepth !== undefined) {
      if (quality?.bookDepth === undefined) {
        unavailableMetrics.add("bookDepth");
        return false;
      }
      if (quality.bookDepth.lt(request.minimumBookDepth)) return false;
    }
    if (request.minimumOpenInterest !== undefined) {
      const openInterest = market.openInterest ?? quality?.openInterest;
      if (openInterest === undefined) {
        unavailableMetrics.add("openInterest");
        return false;
      }
      if (openInterest.lt(request.minimumOpenInterest)) return false;
    }
    if (
      request.minimumYesPrice !== undefined ||
      request.maximumYesPrice !== undefined
    ) {
      const yesPrice = selectedYesPrice(quality, request.yesPriceBasis);
      if (yesPrice === undefined) {
        unavailableMetrics.add("yesPrice");
        return false;
      }
      if (request.minimumYesPrice?.gt(yesPrice) === true) return false;
      if (request.maximumYesPrice?.lt(yesPrice) === true) return false;
    }
    if (request.maximumDataAgeSeconds !== undefined) {
      if (quality?.dataAgeSeconds === undefined) {
        unavailableMetrics.add("dataAgeSeconds");
        return false;
      }
      if (quality.dataAgeSeconds > request.maximumDataAgeSeconds) return false;
    }
    return true;
  });

  if (request.mode === "VOLUME") {
    const hasReportedVolume = indexed.some(
      ([market]) => volumeMetric(market) !== undefined,
    );
    const hasMissingVolume = indexed.some(
      ([market]) => volumeMetric(market) === undefined,
    );
    if (hasReportedVolume) {
      if (hasMissingVolume) unavailableMetrics.add("volumeUsd");
      indexed.sort((left, right) =>
        compareOptionalMetric(volumeMetric, left, right),
      );
      rankingBasis = "REPORTED_TOTAL_VOLUME_DESC";
    } else if (catalog.exchangeRankingBasis === "VOLUME_DESC") {
      if (indexed.length > 0) unavailableMetrics.add("volumeUsd");
      rankingBasis = "EXCHANGE_TOTAL_VOLUME_ORDER";
    } else {
      if (indexed.length > 0) unavailableMetrics.add("volumeUsd");
      indexed = [];
      rankingBasis = "UNAVAILABLE";
    }
  } else if (request.mode === "VOLATILITY") {
    if (indexed.some(([market]) => priceMovementMetric(market) === undefined)) {
      unavailableMetrics.add("priceMovement");
    }
    indexed = indexed.filter(
      ([market]) => priceMovementMetric(market) !== undefined,
    );
    if (indexed.length === 0) {
      unavailableMetrics.add("priceMovement");
      rankingBasis = "UNAVAILABLE";
    } else {
      indexed.sort((left, right) =>
        compareOptionalMetric(priceMovementMetric, left, right),
      );
      rankingBasis = "REPORTED_ABSOLUTE_PRICE_MOVEMENT_DESC";
    }
  } else if (request.mode === "TRENDING") {
    if (catalog.exchangeRankingBasis === "VOLUME_DESC") {
      rankingBasis = "EXCHANGE_TOTAL_VOLUME_ORDER";
    } else if (indexed.some(([market]) => volumeMetric(market) !== undefined)) {
      indexed.sort((left, right) =>
        compareOptionalMetric(volumeMetric, left, right),
      );
      rankingBasis = "REPORTED_TOTAL_VOLUME_DESC";
    } else {
      unavailableMetrics.add("trending");
      indexed = [];
      rankingBasis = "UNAVAILABLE";
    }
  } else if (request.mode === "EXPIRING") {
    indexed = indexed
      .filter(([market]) => market.closesAt !== undefined)
      .sort((left, right) => {
        const timeOrder =
          (left[0].closesAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (right[0].closesAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
        return timeOrder === 0 ? left[1] - right[1] : timeOrder;
      });
    rankingBasis = "CLOSE_TIME_ASC";
  }

  return { indexed, unavailableMetrics, rankingBasis };
}

export function searchMarketCatalog(
  catalog: MarketCatalog,
  request: MarketDiscoveryRequest,
  observedAt = new Date(),
  options: SearchMarketCatalogOptions = {},
): MarketDiscoveryPage {
  validateDiscoveryRequest(request);
  const limit = request.limit ?? 20;
  const offset = parseCursor(request.cursor);
  const state = buildCatalogSearchState(catalog, request, observedAt, options);
  const matchedCount = state.indexed.length;
  const page = state.indexed.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const eof = nextOffset >= matchedCount;
  const rankingBasis =
    state.rankingBasis === "UNAVAILABLE"
      ? state.rankingBasis
      : (options.rankingBasisOverride ?? state.rankingBasis);
  return {
    mode: request.mode,
    catalogCount: options.catalogCount ?? catalog.markets.length,
    matchedCount,
    items: page.map(([market, rank]) =>
      marketRow(
        market,
        rank,
        catalog.heldSlugs,
        options.verifiedMinimumVolumeUsd,
        options.qualityBySlug?.get(market.slug),
        request,
      ),
    ),
    ...(eof ? {} : { nextCursor: String(nextOffset) }),
    eof,
    unavailableMetrics: [...state.unavailableMetrics].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    ),
    rankingBasis,
    ...(options.metricCoverage === undefined
      ? {}
      : { metricCoverage: options.metricCoverage }),
    ...(options.appliedFilters === undefined
      ? {}
      : { appliedFilters: options.appliedFilters }),
  };
}

export interface MarketDiscoveryResolverOptions {
  readonly pageSize?: number;
  readonly maximumPages?: number;
  readonly maximumMetricCandidates?: number;
  readonly maximumConcurrentMetricRequests?: number;
  readonly now?: () => Date;
}

interface VolumeCatalogResolution {
  readonly catalog: MarketCatalog;
  readonly verifiedMinimumVolumeUsd?: Decimal;
  readonly appliedFilters?: readonly MarketDiscoveryAppliedFilter[];
}

interface GroupCatalogResolution {
  readonly slugs?: ReadonlySet<string>;
  readonly appliedFilters?: readonly MarketDiscoveryAppliedFilter[];
  readonly unavailableMetrics?: readonly string[];
}

const DEFAULT_MAXIMUM_METRIC_CANDIDATES = 100;
const DEFAULT_MAXIMUM_CONCURRENT_METRIC_REQUESTS = 4;

export class MarketDiscoveryResolver {
  private readonly volumeCatalogCache = new Map<
    string,
    Promise<VolumeCatalogResolution>
  >();
  private readonly groupCatalogCache = new Map<
    string,
    Promise<GroupCatalogResolution>
  >();
  private readonly bookMetricCache = new Map<
    string,
    Promise<OrderBook | undefined>
  >();
  private readonly resolvedMetricMarkets = new Map<string, Market>();
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly maximumMetricCandidates: number;
  private readonly metricRequestLimit: ReturnType<typeof pLimit>;
  private readonly now: () => Date;

  public constructor(
    private readonly exchange: PredictionExchange,
    private readonly catalog: MarketCatalog,
    options: MarketDiscoveryResolverOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 100;
    this.maximumPages = options.maximumPages ?? 1_000;
    this.maximumMetricCandidates =
      options.maximumMetricCandidates ?? DEFAULT_MAXIMUM_METRIC_CANDIDATES;
    const maximumConcurrentMetricRequests =
      options.maximumConcurrentMetricRequests ??
      DEFAULT_MAXIMUM_CONCURRENT_METRIC_REQUESTS;
    if (
      !Number.isSafeInteger(this.maximumMetricCandidates) ||
      this.maximumMetricCandidates <= 0
    ) {
      throw new RangeError("maximumMetricCandidates must be positive");
    }
    if (
      !Number.isSafeInteger(maximumConcurrentMetricRequests) ||
      maximumConcurrentMetricRequests <= 0
    ) {
      throw new RangeError("maximumConcurrentMetricRequests must be positive");
    }
    this.metricRequestLimit = pLimit(maximumConcurrentMetricRequests);
    this.now = options.now ?? (() => new Date());
  }

  public get metricEnrichedMarkets(): readonly Market[] {
    return [...this.resolvedMetricMarkets.values()];
  }

  public applyResolvedMetrics(market: Market): Market {
    const resolved = this.resolvedMetricMarkets.get(market.slug);
    if (resolved === undefined) return market;
    if (resolved.id.value !== market.id.value) {
      throw new Error(`Conflicting identifiers for market ${market.slug}`);
    }
    const addPriceMovement =
      priceMovementFields(market) === undefined
        ? priceMovementFields(resolved)
        : undefined;
    const addVolatility =
      volatilityFields(market) === undefined
        ? volatilityFields(resolved)
        : undefined;
    if (addPriceMovement === undefined && addVolatility === undefined) {
      return market;
    }
    return {
      ...market,
      ...(addPriceMovement ?? {}),
      ...(addVolatility ?? {}),
    };
  }

  private groupSelector(
    request: MarketDiscoveryRequest,
  ):
    | { readonly kind: "TAG" | "EVENT" | "SERIES"; readonly value: string }
    | undefined {
    if (request.mode === "TAG" && request.tag !== undefined) {
      return { kind: "TAG", value: request.tag.trim() };
    }
    if (request.mode === "EVENT" && request.event !== undefined) {
      return { kind: "EVENT", value: request.event.trim() };
    }
    if (request.mode === "SERIES" && request.series !== undefined) {
      return { kind: "SERIES", value: request.series.trim() };
    }
    return undefined;
  }

  private resolveGroupCatalog(
    request: MarketDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<GroupCatalogResolution> {
    const selector = this.groupSelector(request);
    if (selector === undefined) return Promise.resolve({});
    const key = `${selector.kind}:${selector.value.toLocaleLowerCase("en-US")}`;
    const cached = this.groupCatalogCache.get(key);
    if (cached !== undefined) return cached;
    const listMarketGroupMembers = this.exchange.listMarketGroupMembers?.bind(
      this.exchange,
    );
    if (listMarketGroupMembers === undefined) {
      return Promise.resolve({
        slugs: new Set(),
        unavailableMetrics: [selector.kind.toLocaleLowerCase("en-US")],
      });
    }

    const pending = (async (): Promise<GroupCatalogResolution> => {
      const slugs = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (
          let pageNumber = 0;
          pageNumber < this.maximumPages;
          pageNumber += 1
        ) {
          signal?.throwIfAborted();
          const page = await listMarketGroupMembers({
            kind: selector.kind,
            value: selector.value,
            limit: this.pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          });
          signal?.throwIfAborted();
          for (const slug of page.items) {
            if (slug.trim().length > 0) slugs.add(slug);
          }
          if (page.eof) {
            return {
              slugs,
              appliedFilters: [
                {
                  metric: selector.kind.toLocaleLowerCase("en-US") as
                    "tag" | "event" | "series",
                  value: selector.value,
                  basis: "EXCHANGE_GROUP_MEMBERSHIP",
                },
              ],
            };
          }
          if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
            throw new Error("Market group pagination was incomplete or looped");
          }
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        throw new Error(
          `Market group discovery exceeded the ${this.maximumPages}-page guard`,
        );
      } catch (error) {
        if (error instanceof ExchangeError && error.code === "UNSUPPORTED") {
          return {
            slugs: new Set(),
            unavailableMetrics: [selector.kind.toLocaleLowerCase("en-US")],
          };
        }
        throw error;
      }
    })();
    this.groupCatalogCache.set(key, pending);
    void pending.catch(() => this.groupCatalogCache.delete(key));
    return pending;
  }

  private catalogForGroup(
    catalog: MarketCatalog,
    request: MarketDiscoveryRequest,
    resolution: GroupCatalogResolution,
  ): MarketCatalog {
    if (resolution.slugs === undefined) return catalog;
    const selector = this.groupSelector(request);
    const markets = catalog.markets
      .filter((market) => resolution.slugs?.has(market.slug) === true)
      .map((market): Market => {
        if (selector?.kind === "TAG") {
          const tags = market.tags ?? [];
          return tags.some(
            (tag) =>
              tag.slug.toLocaleLowerCase("en-US") ===
              selector.value.toLocaleLowerCase("en-US"),
          )
            ? market
            : { ...market, tags: [...tags, { slug: selector.value }] };
        }
        if (selector?.kind === "EVENT") {
          return market.eventSlug === undefined
            ? { ...market, eventSlug: selector.value }
            : market;
        }
        if (selector?.kind === "SERIES") {
          return market.seriesSlug === undefined
            ? { ...market, seriesSlug: selector.value }
            : market;
        }
        return market;
      });
    return {
      markets: Object.freeze(markets),
      bySlug: new Map(markets.map((market) => [market.slug, market])),
      exchangeRanks: catalog.exchangeRanks,
      heldSlugs: catalog.heldSlugs,
      categoryCounts: categoryCounts(markets),
      exchangeRankingBasis: catalog.exchangeRankingBasis,
      warnings: catalog.warnings,
    };
  }

  private resolveVolumeCatalog(
    request: MarketDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<VolumeCatalogResolution> {
    const minimum = request.minimumVolumeUsd;
    if (
      minimum === undefined ||
      this.exchange.id !== "polymarket-us" ||
      this.catalog.markets.every((market) => market.volume !== undefined)
    ) {
      return Promise.resolve({ catalog: this.catalog });
    }
    const key = serializeDecimal(minimum);
    const cached = this.volumeCatalogCache.get(key);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<VolumeCatalogResolution> => {
      signal?.throwIfAborted();
      const exchangeMarkets = await listEntireUniverse(
        this.exchange,
        this.pageSize,
        this.maximumPages,
        minimum,
        signal,
      );
      const exchangeBySlug = new Map(
        exchangeMarkets.map((market) => [market.slug, market]),
      );
      const qualified: Market[] = [];
      for (const catalogMarket of this.catalog.markets) {
        const exchangeMarket = exchangeBySlug.get(catalogMarket.slug);
        if (exchangeMarket === undefined) continue;
        if (exchangeMarket.id.value !== catalogMarket.id.value) {
          throw new Error(
            `Conflicting identifiers for market ${catalogMarket.slug}`,
          );
        }
        qualified.push({ ...catalogMarket, ...exchangeMarket });
      }
      const filteredCatalog: MarketCatalog = {
        markets: Object.freeze(qualified),
        bySlug: new Map(qualified.map((market) => [market.slug, market])),
        exchangeRanks: this.catalog.exchangeRanks,
        heldSlugs: this.catalog.heldSlugs,
        categoryCounts: categoryCounts(qualified),
        exchangeRankingBasis: this.catalog.exchangeRankingBasis,
        warnings: this.catalog.warnings,
      };
      return {
        catalog: filteredCatalog,
        verifiedMinimumVolumeUsd: minimum,
        appliedFilters: [
          {
            metric: "totalVolumeUsd",
            minimum: key,
            basis: "EXCHANGE_VOLUME_NUM_MIN",
          },
        ],
      };
    })();
    this.volumeCatalogCache.set(key, pending);
    void pending.catch(() => this.volumeCatalogCache.delete(key));
    return pending;
  }

  private readBookMetrics(
    market: Market,
    signal?: AbortSignal,
  ): Promise<OrderBook | undefined> {
    const cached = this.bookMetricCache.get(market.slug);
    if (cached !== undefined) return cached;
    const pending = this.metricRequestLimit(async () => {
      signal?.throwIfAborted();
      try {
        const book = await this.exchange.getOrderBook(market.id);
        signal?.throwIfAborted();
        return book;
      } catch {
        signal?.throwIfAborted();
        return undefined;
      }
    });
    this.bookMetricCache.set(market.slug, pending);
    void pending.catch(() => this.bookMetricCache.delete(market.slug));
    return pending;
  }

  public async search(
    request: MarketDiscoveryRequest,
    observedAt?: Date,
    signal?: AbortSignal,
  ): Promise<MarketDiscoveryPage> {
    observedAt ??= this.now();
    if (Number.isNaN(observedAt.getTime())) {
      throw new Error("Market discovery time is invalid");
    }
    validateDiscoveryRequest(request);
    signal?.throwIfAborted();
    const [volumeResolution, groupResolution] = await Promise.all([
      this.resolveVolumeCatalog(request, signal),
      this.resolveGroupCatalog(request, signal),
    ]);
    signal?.throwIfAborted();
    const baseCatalog = this.catalogForGroup(
      volumeResolution.catalog,
      request,
      groupResolution,
    );
    const appliedFilters = [
      ...(volumeResolution.appliedFilters ?? []),
      ...(groupResolution.appliedFilters ?? []),
    ];
    const options: SearchMarketCatalogOptions = {
      ...(volumeResolution.verifiedMinimumVolumeUsd === undefined
        ? {}
        : {
            verifiedMinimumVolumeUsd: volumeResolution.verifiedMinimumVolumeUsd,
          }),
      catalogCount: this.catalog.markets.length,
      ...(appliedFilters.length === 0 ? {} : { appliedFilters }),
      ...(groupResolution.unavailableMetrics === undefined
        ? {}
        : { unavailableMetrics: groupResolution.unavailableMetrics }),
      ...(groupResolution.unavailableMetrics === undefined
        ? {}
        : { rankingBasisOverride: "UNAVAILABLE" }),
    };
    const needPriceMovement =
      request.minimumPriceMovement !== undefined ||
      request.mode === "VOLATILITY";
    const needQuality =
      request.maximumSpread !== undefined ||
      request.minimumBookDepth !== undefined ||
      request.minimumOpenInterest !== undefined ||
      request.minimumYesPrice !== undefined ||
      request.maximumYesPrice !== undefined ||
      request.maximumDataAgeSeconds !== undefined;
    if (!needPriceMovement && !needQuality) {
      return searchMarketCatalog(baseCatalog, request, observedAt, options);
    }

    const candidateRequest: MarketDiscoveryRequest = {
      ...request,
      mode: request.mode === "VOLATILITY" ? "ALL" : request.mode,
      minimumPriceMovement: undefined,
      maximumSpread: undefined,
      minimumBookDepth: undefined,
      bookDepthWithinPricePoints: undefined,
      minimumOpenInterest: undefined,
      minimumYesPrice: undefined,
      maximumYesPrice: undefined,
      maximumDataAgeSeconds: undefined,
      cursor: undefined,
    };
    const candidateState = buildCatalogSearchState(
      baseCatalog,
      candidateRequest,
      observedAt,
      options,
    );
    const candidateMarkets = candidateState.indexed.map(([market]) => market);
    const exchangeBookCarriesSummaryMetrics =
      this.exchange.id === "polymarket-us";
    const requiresEnrichment = (market: Market): boolean =>
      request.maximumSpread !== undefined ||
      request.minimumBookDepth !== undefined ||
      (needPriceMovement &&
        exchangeBookCarriesSummaryMetrics &&
        !hasPriceMovementMetric(market)) ||
      (request.minimumOpenInterest !== undefined &&
        market.openInterest === undefined &&
        exchangeBookCarriesSummaryMetrics) ||
      ((request.minimumYesPrice !== undefined ||
        request.maximumYesPrice !== undefined) &&
        (request.yesPriceBasis === "BOOK_MIDPOINT" ||
          (request.yesPriceBasis === "LAST_TRADE" &&
            market.lastPrice === undefined &&
            exchangeBookCarriesSummaryMetrics))) ||
      request.maximumDataAgeSeconds !== undefined;
    const remainingMetricRequests = Math.max(
      0,
      this.maximumMetricCandidates - this.bookMetricCache.size,
    );
    const enrichmentCandidates = candidateMarkets.filter(requiresEnrichment);
    const cachedEnrichmentCandidates = enrichmentCandidates.filter((market) =>
      this.bookMetricCache.has(market.slug),
    );
    const newEnrichmentCandidates = enrichmentCandidates.filter(
      (market) => !this.bookMetricCache.has(market.slug),
    );
    if (newEnrichmentCandidates.length > remainingMetricRequests) {
      const requestedBookMetrics: MarketDiscoveryBookMetric[] = [];
      if (needPriceMovement) requestedBookMetrics.push("PRICE_MOVEMENT");
      if (request.maximumSpread !== undefined) {
        requestedBookMetrics.push("SPREAD");
      }
      if (request.minimumBookDepth !== undefined) {
        requestedBookMetrics.push("BOOK_DEPTH");
      }
      if (request.minimumOpenInterest !== undefined) {
        requestedBookMetrics.push("OPEN_INTEREST");
      }
      if (
        request.minimumYesPrice !== undefined ||
        request.maximumYesPrice !== undefined
      ) {
        requestedBookMetrics.push("YES_PRICE");
      }
      if (request.maximumDataAgeSeconds !== undefined) {
        requestedBookMetrics.push("DATA_AGE");
      }
      const details: MarketDiscoveryNarrowingRequired = {
        code: "MARKET_DISCOVERY_NARROWING_REQUIRED",
        requestMode: request.mode,
        candidateCount: candidateMarkets.length,
        bookEnrichmentCandidateCount: enrichmentCandidates.length,
        cachedBookCandidateCount: cachedEnrichmentCandidates.length,
        requiredNewBookRequestCount: newEnrichmentCandidates.length,
        remainingNewBookRequestBudget: remainingMetricRequests,
        maximumBookMetricCandidates: this.maximumMetricCandidates,
        requestedBookMetrics,
        suggestedModes: ["KEYWORD", "CATEGORY", "TAG", "EVENT", "SERIES"],
        suggestedCheapFilters: [
          "closesAfter",
          "closesBefore",
          "minimumLiquidityUsd",
          "minimumVolumeUsd",
        ],
      };
      throw new MarketDiscoveryNarrowingRequiredError(details);
    }
    const enrichmentSlugs = new Set(
      enrichmentCandidates.map((market) => market.slug),
    );
    const enrichedWithBooks = await Promise.all(
      candidateMarkets.map(async (market) => {
        const book = enrichmentSlugs.has(market.slug)
          ? await this.readBookMetrics(market, signal)
          : undefined;
        const bookPriceMovement =
          book === undefined || priceMovementFields(market) !== undefined
            ? undefined
            : priceMovementFields(book);
        const bookVolatility =
          book === undefined || volatilityFields(market) !== undefined
            ? undefined
            : volatilityFields(book);
        const enrichedMarket: Market = {
          ...market,
          ...(bookPriceMovement ?? {}),
          ...(bookVolatility ?? {}),
        };
        if (
          enrichedMarket !== market &&
          (hasPriceMovementMetric(enrichedMarket) ||
            hasVolatilityMetric(enrichedMarket))
        ) {
          this.resolvedMetricMarkets.set(market.slug, enrichedMarket);
        }
        return { market: enrichedMarket, book };
      }),
    );
    signal?.throwIfAborted();
    const enriched = enrichedWithBooks.map((item) => item.market);
    const depthWindow = request.bookDepthWithinPricePoints ?? new Decimal(0);
    const qualityBySlug = new Map(
      enrichedWithBooks.map(({ market, book }) => [
        market.slug,
        qualitySnapshot(market, book, observedAt, depthWindow),
      ]),
    );
    const coverage = (
      available: (market: Market) => boolean,
    ): MarketMetricCoverage => ({
      candidateCount: candidateMarkets.length,
      evaluatedCount: enriched.length,
      availableCount: enriched.filter(available).length,
      truncated: false,
    });
    const metricCoverage: MarketDiscoveryMetricCoverage = {
      ...(needPriceMovement
        ? {
            priceMovement: coverage((market) => hasPriceMovementMetric(market)),
          }
        : {}),
      ...(request.maximumSpread === undefined
        ? {}
        : {
            spread: coverage(
              (market) => qualityBySlug.get(market.slug)?.spread !== undefined,
            ),
          }),
      ...(request.minimumBookDepth === undefined
        ? {}
        : {
            bookDepth: coverage(
              (market) =>
                qualityBySlug.get(market.slug)?.bookDepth !== undefined,
            ),
          }),
      ...(request.minimumOpenInterest === undefined
        ? {}
        : {
            openInterest: coverage(
              (market) =>
                (market.openInterest ??
                  qualityBySlug.get(market.slug)?.openInterest) !== undefined,
            ),
          }),
      ...(request.minimumYesPrice === undefined &&
      request.maximumYesPrice === undefined
        ? {}
        : {
            yesPrice: coverage(
              (market) =>
                selectedYesPrice(
                  qualityBySlug.get(market.slug),
                  request.yesPriceBasis,
                ) !== undefined,
            ),
          }),
      ...(request.maximumDataAgeSeconds === undefined
        ? {}
        : {
            dataAge: coverage(
              (market) =>
                qualityBySlug.get(market.slug)?.dataAgeSeconds !== undefined,
            ),
          }),
    };
    const enrichedCatalog: MarketCatalog = {
      markets: Object.freeze(enriched),
      bySlug: new Map(enriched.map((market) => [market.slug, market])),
      exchangeRanks: baseCatalog.exchangeRanks,
      heldSlugs: baseCatalog.heldSlugs,
      categoryCounts: categoryCounts(enriched),
      exchangeRankingBasis: baseCatalog.exchangeRankingBasis,
      warnings: baseCatalog.warnings,
    };
    return searchMarketCatalog(enrichedCatalog, request, observedAt, {
      ...options,
      metricCoverage,
      qualityBySlug,
    });
  }
}

export class MarketDetailResolver {
  private readonly cache = new Map<string, Promise<ResolvedMarketDetails>>();
  private readonly resolved = new Map<string, ResolvedMarketDetails>();

  public constructor(
    private readonly exchange: PredictionExchange,
    private readonly catalog: MarketCatalog,
    private readonly applyResolvedMetrics: (market: Market) => Market = (
      market,
    ) => market,
  ) {}

  private refreshResolvedMetrics(
    details: ResolvedMarketDetails,
  ): ResolvedMarketDetails {
    const market = this.applyResolvedMetrics(details.market);
    if (market === details.market) return details;
    const refreshed = { ...details, market };
    this.resolved.set(market.slug, refreshed);
    return refreshed;
  }

  public get resolvedDetails(): readonly ResolvedMarketDetails[] {
    return [...this.resolved.values()].map((details) =>
      this.refreshResolvedMetrics(details),
    );
  }

  public get resolvedMarkets(): readonly Market[] {
    return this.resolvedDetails.map((details) => details.market);
  }

  public async preloadHeld(
    signal?: AbortSignal,
  ): Promise<readonly ResolvedMarketDetails[]> {
    return Promise.all(
      [...this.catalog.heldSlugs].map((slug) => this.resolve(slug, signal)),
    );
  }

  public resolve(
    slug: string,
    signal?: AbortSignal,
  ): Promise<ResolvedMarketDetails> {
    const existing = this.cache.get(slug);
    if (existing !== undefined) {
      return existing.then((details) => this.refreshResolvedMetrics(details));
    }
    const catalogMarket = this.catalog.bySlug.get(slug);
    if (catalogMarket === undefined) {
      return Promise.reject(new Error(`Market ${slug} is not in the catalog`));
    }

    const pending = (async (): Promise<ResolvedMarketDetails> => {
      signal?.throwIfAborted();
      const exchangeMarket = await this.exchange.getMarketBySlug(slug);
      if (exchangeMarket.id.value !== catalogMarket.id.value) {
        throw new Error(`Market identifier changed for ${slug}`);
      }
      const market = this.applyResolvedMetrics(exchangeMarket);
      signal?.throwIfAborted();
      const warnings: string[] = [];
      let bbo: MarketBbo | undefined;
      try {
        bbo = await this.exchange.getBbo(market.id);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        warnings.push(`Current BBO is unavailable for ${slug}`);
      }
      signal?.throwIfAborted();
      const details: ResolvedMarketDetails = {
        market,
        ...(bbo === undefined ? {} : { bbo }),
        held: this.catalog.heldSlugs.has(slug),
        warnings: Object.freeze(warnings),
      };
      this.resolved.set(slug, details);
      return details;
    })();
    this.cache.set(slug, pending);
    void pending.catch(() => this.cache.delete(slug));
    return pending;
  }
}
