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
import { serializeDecimal, type Page } from "../domain/primitives.js";
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

export type CatalogCoverageDiagnosticCode =
  | "EMPTY_TERMINAL_PAGE_AT_PAGE_BOUNDARY"
  | "END_OF_CATALOG_BEFORE_NONEMPTY_PAGE"
  | "DUPLICATE_ROWS_ACROSS_PAGES"
  | "LIST_ORDER_NOT_MONOTONIC"
  | "CATALOG_SUPPLEMENT_INCOMPLETE";

export interface CatalogCoverageDiagnostic {
  readonly code: CatalogCoverageDiagnosticCode;
  readonly message: string;
}

/** One catalog list request exactly as the exchange answered it. */
export interface CatalogPageObservation {
  readonly pageNumber: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly requestedLimit: number;
  readonly returnedCount: number;
  readonly newMarketCount: number;
  readonly duplicateCount: number;
  readonly eof: boolean;
  readonly eofSource?: "RESPONSE" | "SHORT_PAGE";
  readonly nextCursor?: string;
  /** A repeated request for an ambiguous end of the list. */
  readonly verification: boolean;
}

export interface CatalogAcquisition {
  readonly pageSize: number;
  readonly maximumConcurrentPages: number;
  readonly pages: readonly CatalogPageObservation[];
  readonly rawRowCount: number;
  readonly uniqueMarketCount: number;
  readonly duplicateRowCount: number;
  readonly stopReason: "EXCHANGE_EOF" | "SHORT_PAGE" | "EMPTY_PAGE" | "HORIZON";
  readonly coverage: "COMPLETE" | "DEGRADED";
  readonly diagnostics: readonly CatalogCoverageDiagnostic[];
  /** Ranking and supplementary listings acquired after the membership list. */
  readonly segments?: readonly CatalogSegmentAcquisition[];
}

/** A caller-selected exchange list order. */
export interface CatalogListOrder {
  readonly orderBy: readonly string[];
  readonly orderDirection: "asc" | "desc";
}

/** One listing requested in addition to the membership list. */
export interface CatalogSegmentAcquisition {
  readonly kind: "RANKING" | "CATEGORY" | "CLOSING_SOON";
  readonly key?: string;
  readonly listRequests: number;
  readonly uniqueMarketCount: number;
  /** Markets merged into the catalog that the membership list lacked. */
  readonly addedMarketCount: number;
  readonly coverage: "COMPLETE" | "DEGRADED" | "UNSUPPORTED" | "FAILED";
  readonly stopReason?: CatalogAcquisition["stopReason"];
  readonly diagnostics: readonly CatalogCoverageDiagnostic[];
  /** A ranking only orders members; it cannot remove or add coverage. */
  readonly affectsCoverage: boolean;
}

export interface CatalogSupplementOptions {
  /** Categories whose complete listings must be present in the catalog. */
  readonly categories?: readonly string[];
  /** Every open market closing before `now + hours` must be present. */
  readonly closingWithin?: {
    readonly hours: number;
    readonly now: Date;
    /** Ascending close-time order; omitted when the exchange cannot sort so. */
    readonly order?: CatalogListOrder;
  };
}

export interface MarketCatalog {
  readonly markets: readonly Market[];
  readonly bySlug: ReadonlyMap<string, Market>;
  readonly exchangeRanks: ReadonlyMap<string, number>;
  readonly heldSlugs: ReadonlySet<string>;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly exchangeRankingBasis: "VOLUME_DESC" | "EXCHANGE_DEFAULT";
  readonly warnings: readonly string[];
  /** Page-level evidence for how the listed universe was acquired. */
  readonly acquisition?: CatalogAcquisition;
}

export interface MarketCatalogOptions {
  readonly pageSize?: number;
  readonly maximumPages?: number;
  /** Offset-page concurrency. Only safe for exchanges with numeric offsets. */
  readonly maximumConcurrentPages?: number;
  readonly signal?: AbortSignal;
  /**
   * A stable order that lists every open market exactly once. When set, it
   * defines catalog membership and `rankingOrder` only ranks the members, so an
   * order that shifts between page requests cannot drop markets.
   */
  readonly membershipOrder?: CatalogListOrder;
  readonly rankingOrder?: CatalogListOrder;
  readonly supplements?: CatalogSupplementOptions;
  /** Waits before each repeat of an ambiguous empty end page. */
  readonly verificationDelaysMilliseconds?: readonly number[];
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

function catalogStopReason(
  page: Page<Market>,
): CatalogAcquisition["stopReason"] {
  if (page.eofSource === "RESPONSE") return "EXCHANGE_EOF";
  return page.items.length === 0 ? "EMPTY_PAGE" : "SHORT_PAGE";
}

const DEFAULT_VERIFICATION_DELAYS_MILLISECONDS = Object.freeze([
  0, 1_000, 3_000,
]);
const MEMBERSHIP_CHURN_MINIMUM_ROWS = 50;
const MEMBERSHIP_CHURN_FRACTION = 0.002;

async function pause(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("Catalog verification aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ListUniverseOptions {
  readonly pageSize: number;
  readonly maximumPages: number;
  readonly maximumConcurrentPages?: number;
  readonly minimumVolumeUsd?: Decimal;
  readonly signal?: AbortSignal;
  /** Omitted: the exchange's historical discovery order. */
  readonly order?: CatalogListOrder;
  readonly categories?: readonly string[];
  /**
   * For a listing in ascending close order: stop after a page whose rows all
   * close at or after this time. Out-of-order rows are reported.
   */
  readonly closesBefore?: Date;
  readonly verificationDelaysMilliseconds?: readonly number[];
}

async function listEntireUniverse(
  exchange: PredictionExchange,
  options: ListUniverseOptions,
): Promise<{
  readonly markets: readonly Market[];
  readonly acquisition: CatalogAcquisition;
}> {
  const { pageSize, maximumPages, signal } = options;
  const maximumConcurrentPages = options.maximumConcurrentPages ?? 1;
  const verificationDelays =
    options.verificationDelaysMilliseconds ??
    DEFAULT_VERIFICATION_DELAYS_MILLISECONDS;
  if (
    verificationDelays.length === 0 ||
    verificationDelays.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 0,
    )
  ) {
    throw new RangeError(
      "verificationDelaysMilliseconds must list at least one non-negative integer",
    );
  }
  const order =
    options.order ??
    (exchange.id === "polymarket-us"
      ? ({ orderBy: ["volume", "id"], orderDirection: "desc" } as const)
      : undefined);
  const baseQuery = {
    active: true,
    closed: false,
    archived: false,
    limit: pageSize,
    ...(order === undefined
      ? {}
      : { orderBy: order.orderBy, orderDirection: order.orderDirection }),
    ...(options.categories === undefined
      ? {}
      : { categories: options.categories }),
    ...(options.minimumVolumeUsd === undefined
      ? {}
      : { minimumVolumeUsd: options.minimumVolumeUsd }),
  };
  const horizon = options.closesBefore?.getTime();
  const markets: Market[] = [];
  const identities = new Map<string, string>();
  const pages: CatalogPageObservation[] = [];
  const diagnostics: CatalogCoverageDiagnostic[] = [];
  let rawRowCount = 0;
  let duplicateRowCount = 0;
  let latestClose = Number.NEGATIVE_INFINITY;
  let orderViolation = false;
  const closeTime = (market: Market): number =>
    market.closesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const append = (
    page: Page<Market>,
    pageNumber: number,
    position: { readonly offset?: number; readonly cursor?: string },
    verification: boolean,
  ): void => {
    let newMarketCount = 0;
    for (const market of page.items) {
      const knownId = identities.get(market.slug);
      if (knownId !== undefined && knownId !== market.id.value) {
        throw new Error(`Conflicting identifiers for market ${market.slug}`);
      }
      if (knownId === undefined) {
        identities.set(market.slug, market.id.value);
        markets.push(market);
        newMarketCount += 1;
      }
      if (horizon !== undefined && !verification) {
        const closes = closeTime(market);
        if (closes < latestClose) orderViolation = true;
        latestClose = Math.max(latestClose, closes);
      }
    }
    rawRowCount += page.items.length;
    duplicateRowCount += page.items.length - newMarketCount;
    pages.push({
      pageNumber,
      ...position,
      requestedLimit: pageSize,
      returnedCount: page.items.length,
      newMarketCount,
      duplicateCount: page.items.length - newMarketCount,
      eof: page.eof,
      ...(page.eofSource === undefined ? {} : { eofSource: page.eofSource }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      verification,
    });
  };
  // Rows at or beyond the horizon end an ascending close-time listing.
  const reachedHorizon = (page: Page<Market>): boolean =>
    horizon !== undefined &&
    page.items.length > 0 &&
    page.items.every((market) => closeTime(market) >= horizon);
  // An empty page whose end is inferred only from its length, directly after a
  // full page, cannot be told apart from a truncated response. Ask again, with
  // increasing waits, before accepting it as the end of the list.
  const ambiguousEnd = (
    page: Page<Market>,
    previousReturned: number | undefined,
  ): boolean =>
    page.eof &&
    page.eofSource === "SHORT_PAGE" &&
    page.items.length === 0 &&
    previousReturned === pageSize;
  const verifyEnd = async (
    fetch: () => Promise<Page<Market>>,
    record: (page: Page<Market>) => void,
  ): Promise<Page<Market>> => {
    let latest: Page<Market> | undefined;
    for (const delay of verificationDelays) {
      await pause(delay, signal);
      latest = await fetch();
      signal?.throwIfAborted();
      record(latest);
      if (latest.items.length > 0) return latest;
    }
    if (latest === undefined) {
      throw new Error("Catalog end verification made no request");
    }
    return latest;
  };
  const confirmedEmptyEnd = (position: string): void => {
    diagnostics.push({
      code: "EMPTY_TERMINAL_PAGE_AT_PAGE_BOUNDARY",
      message: `${position} returned no rows directly after a full page, without an explicit end marker, and ${verificationDelays.length} repeated requests also returned none; the list may have ended early`,
    });
  };
  const finish = (
    terminal: Page<Market>,
    stopReason: CatalogAcquisition["stopReason"] = catalogStopReason(terminal),
  ) => {
    if (duplicateRowCount > 0) {
      diagnostics.push({
        code: "DUPLICATE_ROWS_ACROSS_PAGES",
        message: `${duplicateRowCount} repeated rows were returned across pages; the list order changed during pagination, so other rows may have been skipped`,
      });
    }
    if (orderViolation) {
      diagnostics.push({
        code: "LIST_ORDER_NOT_MONOTONIC",
        message:
          "Rows did not arrive in ascending close order, so stopping at the close-time horizon may have skipped markets",
      });
    }
    return {
      markets,
      acquisition: {
        pageSize,
        maximumConcurrentPages,
        pages: Object.freeze(pages),
        rawRowCount,
        uniqueMarketCount: markets.length,
        duplicateRowCount,
        stopReason,
        coverage:
          diagnostics.length === 0
            ? ("COMPLETE" as const)
            : ("DEGRADED" as const),
        diagnostics: Object.freeze([...diagnostics]),
      },
    };
  };

  if (maximumConcurrentPages > 1) {
    if (exchange.id !== "polymarket-us") {
      throw new Error(
        "Concurrent catalog pagination requires a numeric-offset exchange",
      );
    }
    const request = (pageNumber: number) =>
      exchange.listMarkets({ ...baseQuery, offset: pageNumber * pageSize });
    let nextPage = 0;
    let previousReturned: number | undefined;
    while (nextPage < maximumPages) {
      signal?.throwIfAborted();
      const pageNumbers = Array.from(
        { length: Math.min(maximumConcurrentPages, maximumPages - nextPage) },
        (_, index) => nextPage + index,
      );
      const batch = await Promise.all(pageNumbers.map(request));
      signal?.throwIfAborted();
      let terminal:
        | {
            readonly index: number;
            readonly previousReturned: number | undefined;
          }
        | undefined;
      let horizonPage: Page<Market> | undefined;
      // Keep every fetched row; an early end marker must not discard later pages.
      for (const [index, page] of batch.entries()) {
        const pageNumber = nextPage + index;
        append(page, pageNumber, { offset: pageNumber * pageSize }, false);
        if (terminal === undefined && horizonPage === undefined) {
          if (reachedHorizon(page)) {
            horizonPage = page;
          } else if (page.eof) {
            terminal = { index, previousReturned };
          } else if (page.items.length === 0) {
            throw new Error("Market offset pagination made no progress");
          }
        }
        previousReturned = page.items.length;
      }
      if (horizonPage !== undefined) return finish(horizonPage, "HORIZON");
      if (terminal === undefined) {
        nextPage += batch.length;
        continue;
      }
      const terminalPageNumber = nextPage + terminal.index;
      if (
        batch.slice(terminal.index + 1).some((page) => page.items.length > 0)
      ) {
        // Recover rows that an inconsistent end marker would otherwise hide.
        const recheck = await verifyEnd(
          () => request(terminalPageNumber),
          (page) =>
            append(
              page,
              terminalPageNumber,
              { offset: terminalPageNumber * pageSize },
              true,
            ),
        );
        if (recheck.items.length === 0) {
          diagnostics.push({
            code: "END_OF_CATALOG_BEFORE_NONEMPTY_PAGE",
            message: `Offset ${terminalPageNumber * pageSize} reported the end of the list, but a later page in the same batch returned rows; ${verificationDelays.length} repeated requests returned none, so its rows are missing`,
          });
        }
        nextPage += batch.length;
        continue;
      }
      const terminalPage = batch[terminal.index];
      if (terminalPage === undefined) {
        throw new Error("Catalog batch omitted its terminal page");
      }
      if (!ambiguousEnd(terminalPage, terminal.previousReturned)) {
        return finish(terminalPage);
      }
      const recheck = await verifyEnd(
        () => request(terminalPageNumber),
        (page) =>
          append(
            page,
            terminalPageNumber,
            { offset: terminalPageNumber * pageSize },
            true,
          ),
      );
      if (recheck.items.length === 0) {
        confirmedEmptyEnd(`Offset ${terminalPageNumber * pageSize}`);
        return finish(recheck);
      }
      if (reachedHorizon(recheck)) return finish(recheck, "HORIZON");
      if (recheck.eof) return finish(recheck);
      // Rows reappeared: resume after the recovered page.
      previousReturned = recheck.items.length;
      nextPage = terminalPageNumber + 1;
    }
    throw new Error(`Market discovery exceeded the ${maximumPages}-page guard`);
  }

  const cursors = new Set<string>();
  let cursor: string | undefined;
  let previousReturned: number | undefined;
  const request = (requestCursor: string | undefined) =>
    exchange.listMarkets({
      ...baseQuery,
      ...(requestCursor === undefined ? {} : { cursor: requestCursor }),
    });

  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    signal?.throwIfAborted();
    const position = cursor === undefined ? {} : { cursor };
    let page = await request(cursor);
    append(page, pageNumber, position, false);
    if (ambiguousEnd(page, previousReturned)) {
      page = await verifyEnd(
        () => request(cursor),
        (verified) => append(verified, pageNumber, position, true),
      );
      if (page.items.length === 0) {
        confirmedEmptyEnd(
          cursor === undefined ? "The first page" : `Cursor ${cursor}`,
        );
        return finish(page);
      }
    }
    if (reachedHorizon(page)) return finish(page, "HORIZON");
    if (page.eof) return finish(page);
    if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
      throw new Error(
        "Market pagination was incomplete or entered a cursor loop",
      );
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
    previousReturned = page.items.length;
  }
  throw new Error(`Market discovery exceeded the ${maximumPages}-page guard`);
}

function segmentFromListing(
  kind: CatalogSegmentAcquisition["kind"],
  key: string | undefined,
  acquisition: CatalogAcquisition,
  addedMarketCount: number,
  affectsCoverage: boolean,
): CatalogSegmentAcquisition {
  return {
    kind,
    ...(key === undefined ? {} : { key }),
    listRequests: acquisition.pages.length,
    uniqueMarketCount: acquisition.uniqueMarketCount,
    addedMarketCount,
    coverage: acquisition.coverage,
    stopReason: acquisition.stopReason,
    diagnostics: acquisition.diagnostics,
    affectsCoverage,
  };
}

function segmentFromFailure(
  kind: CatalogSegmentAcquisition["kind"],
  key: string | undefined,
  error: unknown,
  affectsCoverage: boolean,
): CatalogSegmentAcquisition {
  const unsupported =
    error instanceof ExchangeError && error.code === "UNSUPPORTED";
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind,
    ...(key === undefined ? {} : { key }),
    listRequests: 0,
    uniqueMarketCount: 0,
    addedMarketCount: 0,
    coverage: unsupported ? "UNSUPPORTED" : "FAILED",
    diagnostics: Object.freeze([
      {
        code: "CATALOG_SUPPLEMENT_INCOMPLETE" as const,
        message: `${kind}${key === undefined ? "" : ` ${key}`} listing ${unsupported ? "is unsupported by this exchange" : "failed"}: ${detail}`,
      },
    ]),
    affectsCoverage,
  };
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
  if (
    options.rankingOrder !== undefined &&
    options.membershipOrder === undefined
  ) {
    throw new RangeError("rankingOrder requires a stable membershipOrder");
  }
  const closingWithin = options.supplements?.closingWithin;
  if (
    closingWithin !== undefined &&
    (!Number.isFinite(closingWithin.hours) ||
      closingWithin.hours <= 0 ||
      Number.isNaN(closingWithin.now.getTime()))
  ) {
    throw new RangeError(
      "closingWithin requires positive hours and a valid time",
    );
  }
  const listing = {
    pageSize,
    maximumPages,
    maximumConcurrentPages,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.verificationDelaysMilliseconds === undefined
      ? {}
      : {
          verificationDelaysMilliseconds:
            options.verificationDelaysMilliseconds,
        }),
  };
  const segments: CatalogSegmentAcquisition[] = [];
  const optionalListing = async (
    kind: CatalogSegmentAcquisition["kind"],
    key: string | undefined,
    affectsCoverage: boolean,
    run: () => ReturnType<typeof listEntireUniverse>,
  ): Promise<readonly Market[]> => {
    try {
      const listed = await run();
      segments.push(
        segmentFromListing(kind, key, listed.acquisition, 0, affectsCoverage),
      );
      return listed.markets;
    } catch (error) {
      options.signal?.throwIfAborted();
      segments.push(segmentFromFailure(kind, key, error, affectsCoverage));
      return [];
    }
  };

  // Rank before listing members: a market created between the two scans is
  // then an unranked member instead of a ranked market missing from members.
  const rankingOrder = options.rankingOrder;
  const ranked =
    rankingOrder === undefined
      ? undefined
      : await optionalListing("RANKING", undefined, false, () =>
          listEntireUniverse(exchange, { ...listing, order: rankingOrder }),
        );
  const listed = await listEntireUniverse(exchange, {
    ...listing,
    ...(options.membershipOrder === undefined
      ? {}
      : { order: options.membershipOrder }),
  });
  const members = new Map(
    listed.markets.map((market) => [market.slug, market]),
  );
  const markets: Market[] = [];
  const bySlug = new Map<string, Market>();
  const include = (market: Market): boolean => {
    if (bySlug.has(market.slug)) return false;
    bySlug.set(market.slug, market);
    markets.push(market);
    return true;
  };
  // A market missing from the membership list but seen by the ranking list is
  // kept: an offset scan can skip rows when markets open or close mid-scan.
  let rankingAdded = 0;
  for (const market of ranked ?? []) {
    const member = members.get(market.slug);
    if (include(member ?? market) && member === undefined) rankingAdded += 1;
  }
  for (const market of listed.markets) include(market);
  const rankingIndex = segments.findIndex(
    (segment) => segment.kind === "RANKING",
  );
  const rankingSegment = segments[rankingIndex];
  if (rankingSegment !== undefined) {
    segments[rankingIndex] = {
      ...rankingSegment,
      addedMarketCount: rankingAdded,
    };
  }
  // With a stable membership order, a few repeated rows only mean that markets
  // opened or closed while the list was paged; many mean the order is unstable.
  const churnTolerance = Math.max(
    MEMBERSHIP_CHURN_MINIMUM_ROWS,
    Math.ceil(listed.acquisition.uniqueMarketCount * MEMBERSHIP_CHURN_FRACTION),
  );
  const membershipChurn =
    options.membershipOrder !== undefined &&
    listed.acquisition.duplicateRowCount > 0 &&
    listed.acquisition.duplicateRowCount <= churnTolerance;

  const merge = (
    index: number,
    supplement: readonly Market[],
  ): CatalogSegmentAcquisition | undefined => {
    const segment = segments[index];
    if (segment === undefined) return undefined;
    const addedMarketCount = supplement.filter(include).length;
    segments[index] = { ...segment, addedMarketCount };
    return segments[index];
  };
  for (const category of options.supplements?.categories ?? []) {
    const supplement = await optionalListing("CATEGORY", category, true, () =>
      listEntireUniverse(exchange, {
        ...listing,
        ...(options.membershipOrder === undefined
          ? {}
          : { order: options.membershipOrder }),
        categories: [category],
      }),
    );
    merge(segments.length - 1, supplement);
  }
  if (closingWithin !== undefined) {
    const order = closingWithin.order;
    const key = `${closingWithin.hours}h`;
    if (order === undefined) {
      segments.push(
        segmentFromFailure(
          "CLOSING_SOON",
          key,
          new ExchangeError(
            "No ascending close-time list order is available",
            "UNSUPPORTED",
          ),
          true,
        ),
      );
    } else {
      const supplement = await optionalListing("CLOSING_SOON", key, true, () =>
        listEntireUniverse(exchange, {
          ...listing,
          order,
          closesBefore: new Date(
            closingWithin.now.getTime() + closingWithin.hours * 3_600_000,
          ),
        }),
      );
      merge(segments.length - 1, supplement);
    }
  }

  const exchangeRanks = new Map(
    markets.map((market, index) => [market.slug, index + 1]),
  );
  const heldSlugs = new Set(
    snapshot.positions.map((position) => position.marketSlug),
  );
  const incompleteSegments = segments.filter(
    (segment) => segment.affectsCoverage && segment.coverage !== "COMPLETE",
  );
  const diagnostics = [
    ...listed.acquisition.diagnostics.filter(
      (diagnostic) =>
        !membershipChurn || diagnostic.code !== "DUPLICATE_ROWS_ACROSS_PAGES",
    ),
    ...incompleteSegments.map((segment) => ({
      code: "CATALOG_SUPPLEMENT_INCOMPLETE" as const,
      message: `${segment.kind}${segment.key === undefined ? "" : ` ${segment.key}`} listing coverage was ${segment.coverage}: ${segment.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`,
    })),
  ];
  const acquisition: CatalogAcquisition = {
    ...listed.acquisition,
    coverage: diagnostics.length === 0 ? "COMPLETE" : "DEGRADED",
    diagnostics: Object.freeze(diagnostics),
    ...(segments.length === 0 ? {} : { segments: Object.freeze(segments) }),
  };
  const warnings: string[] = [];
  if (acquisition.coverage === "DEGRADED") {
    warnings.push(
      `CATALOG_COVERAGE_DEGRADED: ${acquisition.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(
          ", ",
        )}; ${markets.length} markets from ${acquisition.pages.length} membership list requests. A market absent from this catalog is unverified, not unavailable.`,
    );
  }
  if (membershipChurn) {
    warnings.push(
      `CATALOG_LISTING_CHANGED_DURING_SCAN: ${listed.acquisition.duplicateRowCount} membership rows repeated (tolerance ${churnTolerance}) while markets opened or closed; ${rankingAdded} markets missing from the membership list were kept from the ranking list`,
    );
  }
  const ranking = segments.find((segment) => segment.kind === "RANKING");
  if (ranking !== undefined && ranking.coverage !== "COMPLETE") {
    warnings.push(
      `CATALOG_RANKING_PARTIAL: the ranking listing was ${ranking.coverage}; markets it did not return keep membership order after ranked markets`,
    );
  }

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
      exchange.id === "polymarket-us" &&
      (options.membershipOrder === undefined ||
        (rankingOrder?.orderBy[0] === "volume" &&
          rankingOrder.orderDirection === "desc"))
        ? "VOLUME_DESC"
        : "EXCHANGE_DEFAULT",
    warnings: Object.freeze(warnings),
    acquisition,
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
      const { markets: exchangeMarkets, acquisition } =
        await listEntireUniverse(this.exchange, {
          pageSize: this.pageSize,
          maximumPages: this.maximumPages,
          minimumVolumeUsd: minimum,
          ...(signal === undefined ? {} : { signal }),
        });
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
        warnings:
          acquisition.coverage === "DEGRADED"
            ? [
                ...this.catalog.warnings,
                `CATALOG_COVERAGE_DEGRADED: volume-threshold listing ${acquisition.diagnostics
                  .map((diagnostic) => diagnostic.code)
                  .join(", ")}`,
              ]
            : this.catalog.warnings,
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
