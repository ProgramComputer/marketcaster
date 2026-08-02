import { Decimal } from "decimal.js";
import type { AgentConfig } from "../config/schema.js";
import type { Market, MarketBbo, OrderBook } from "../domain/market.js";
import { serializeDecimal } from "../domain/primitives.js";

export type MarketSelectionPolicy = AgentConfig["marketSelection"];

export interface MarketCandidate {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly book?: OrderBook;
  readonly hasExistingPosition?: boolean;
}

export type MarketIneligibilityReason =
  | "INACTIVE"
  | "CLOSED"
  | "ARCHIVED"
  | "MISSING_CLOSE_TIME"
  | "CLOSES_TOO_SOON"
  | "CLOSES_TOO_LATE"
  | "MISSING_SETTLEMENT_RULES"
  | "INVALID_MINIMUM_QUANTITY"
  | "INVALID_PRICE_TICK"
  | "MISSING_BBO"
  | "INVALID_BBO"
  | "CROSSED_BBO"
  | "MISSING_ORDER_BOOK"
  | "INVALID_ORDER_BOOK"
  | "CROSSED_ORDER_BOOK"
  | "SPREAD_TOO_WIDE"
  | "INSUFFICIENT_LIQUIDITY_AND_VOLUME";

export interface RankedMarket {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly hasExistingPosition: boolean;
  readonly eligibleForNewExposure: boolean;
  readonly includedForReview: boolean;
  readonly ineligibilityReasons: readonly MarketIneligibilityReason[];
  readonly spread?: Decimal;
  readonly score: Decimal;
  readonly normalizedCategory: string;
}

export interface CompactMarketRow {
  readonly slug: string;
  readonly title: string;
  readonly category: string;
  readonly closesAt?: string;
  readonly yesBid?: string;
  readonly yesAsk?: string;
  readonly noBid?: string;
  readonly noAsk?: string;
  readonly spread?: string;
  readonly liquidityUsd?: string;
  readonly volume24hUsd?: string;
  readonly rankingScore: string;
  readonly held: boolean;
  readonly eligibleForNewExposure: boolean;
}

export interface MarketSelectionResult {
  readonly scannedCount: number;
  readonly eligibleCount: number;
  readonly reviewUniverse: readonly RankedMarket[];
  readonly detailedMarkets: readonly RankedMarket[];
  /** Every eligible or held market, never silently truncated by detail slots. */
  readonly compactMarkets: readonly CompactMarketRow[];
  readonly rejectedMarkets: readonly RankedMarket[];
  readonly detailedCategoryCounts: Readonly<Record<string, number>>;
}

interface BboValidation {
  readonly valid: boolean;
  readonly crossed: boolean;
  readonly spread?: Decimal;
}

interface OrderBookValidation {
  readonly valid: boolean;
  readonly crossed: boolean;
}

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const WEIGHT_VOLUME = new Decimal("0.35");
const WEIGHT_LIQUIDITY = new Decimal("0.35");
const WEIGHT_SPREAD = new Decimal("0.20");
const WEIGHT_TIME = new Decimal("0.10");

function validDate(value: Date | undefined): value is Date {
  return value !== undefined && !Number.isNaN(value.getTime());
}

function finiteBetweenZeroAndOne(value: Decimal | undefined): boolean {
  return (
    value !== undefined && value.isFinite() && value.gte(ZERO) && value.lte(ONE)
  );
}

function validateBbo(bbo: MarketBbo | undefined): BboValidation {
  if (bbo === undefined) {
    return { valid: false, crossed: false };
  }

  const { bid, ask } = bbo.yes;
  if (
    bid === undefined ||
    ask === undefined ||
    !finiteBetweenZeroAndOne(bid) ||
    !finiteBetweenZeroAndOne(ask)
  ) {
    return { valid: false, crossed: false };
  }
  if (ask.lt(bid)) {
    return { valid: false, crossed: true };
  }

  const spread = ask.minus(bid);
  const noBid = bbo.no.bid;
  const noAsk = bbo.no.ask;
  if (
    (noBid !== undefined && !finiteBetweenZeroAndOne(noBid)) ||
    (noAsk !== undefined && !finiteBetweenZeroAndOne(noAsk)) ||
    (noBid !== undefined && noAsk?.lt(noBid) === true)
  ) {
    return {
      valid: false,
      crossed: noBid !== undefined && noAsk?.lt(noBid) === true,
    };
  }

  if (
    (noBid !== undefined && !noBid.eq(ONE.minus(ask))) ||
    (noAsk !== undefined && !noAsk.eq(ONE.minus(bid)))
  ) {
    return { valid: false, crossed: false };
  }

  return { valid: true, crossed: false, spread };
}

function validateOrderBook(book: OrderBook | undefined): OrderBookValidation {
  if (book === undefined) {
    return { valid: false, crossed: false };
  }
  if (Number.isNaN(book.observedAt.getTime())) {
    return { valid: false, crossed: false };
  }
  const levels = [...book.yesBids, ...book.yesAsks];
  if (
    levels.some(
      (level) =>
        !finiteBetweenZeroAndOne(level.price) ||
        !level.quantity.isFinite() ||
        level.quantity.lte(0),
    )
  ) {
    return { valid: false, crossed: false };
  }
  if (book.yesBids.length === 0 || book.yesAsks.length === 0) {
    return { valid: false, crossed: false };
  }
  const bestBid = book.yesBids.reduce(
    (best, level) => Decimal.max(best, level.price),
    ZERO,
  );
  const bestAsk = book.yesAsks.reduce(
    (best, level) => Decimal.min(best, level.price),
    ONE,
  );
  return bestAsk.lt(bestBid)
    ? { valid: false, crossed: true }
    : { valid: true, crossed: false };
}

function categoryFor(market: Market): string {
  const raw = market.category?.trim();
  return raw === undefined || raw.length === 0 ? "Uncategorized" : raw;
}

function nonNegativeMetric(value: Decimal | undefined): Decimal {
  return value !== undefined && value.isFinite() && value.gt(0) ? value : ZERO;
}

function logOnePlus(value: Decimal): Decimal {
  return value.plus(ONE).ln();
}

function normalized(value: Decimal, maximum: Decimal): Decimal {
  return maximum.gt(ZERO) ? value.div(maximum) : ZERO;
}

function clampUnit(value: Decimal): Decimal {
  return Decimal.max(ZERO, Decimal.min(ONE, value));
}

function timeRelevance(
  market: Market,
  now: Date,
  policy: MarketSelectionPolicy,
): Decimal {
  if (!validDate(market.closesAt)) {
    return ZERO;
  }
  const remainingMilliseconds = new Decimal(
    market.closesAt.getTime() - now.getTime(),
  );
  const minimumMilliseconds = new Decimal(policy.minimumMinutesToClose)
    .mul(60)
    .mul(1000);
  const maximumMilliseconds = new Decimal(policy.maximumDaysToClose)
    .mul(24)
    .mul(60)
    .mul(60)
    .mul(1000);
  const range = maximumMilliseconds.minus(minimumMilliseconds);
  if (range.lte(ZERO)) {
    return ZERO;
  }
  return clampUnit(
    ONE.minus(remainingMilliseconds.minus(minimumMilliseconds).div(range)),
  );
}

function spreadQuality(
  spread: Decimal | undefined,
  maximumSpread: Decimal,
): Decimal {
  if (spread === undefined || !spread.isFinite() || spread.lt(ZERO)) {
    return ZERO;
  }
  if (maximumSpread.eq(ZERO)) {
    return spread.eq(ZERO) ? ONE : ZERO;
  }
  return Decimal.max(ZERO, ONE.minus(spread.div(maximumSpread)));
}

function compareRanked(left: RankedMarket, right: RankedMarket): number {
  if (left.hasExistingPosition !== right.hasExistingPosition) {
    return left.hasExistingPosition ? -1 : 1;
  }
  const scoreOrder = right.score.cmp(left.score);
  if (scoreOrder !== 0) {
    return scoreOrder;
  }
  return left.market.slug.localeCompare(right.market.slug, "en-US");
}

function eligibilityReasons(
  candidate: MarketCandidate,
  policy: MarketSelectionPolicy,
  now: Date,
  bboValidation: BboValidation,
  orderBookValidation: OrderBookValidation,
): readonly MarketIneligibilityReason[] {
  const reasons: MarketIneligibilityReason[] = [];
  const { market } = candidate;

  if (!market.active) reasons.push("INACTIVE");
  if (market.closed) reasons.push("CLOSED");
  if (market.archived) reasons.push("ARCHIVED");
  if (!validDate(market.closesAt)) {
    reasons.push("MISSING_CLOSE_TIME");
  } else {
    const minimumClose =
      now.getTime() + policy.minimumMinutesToClose * 60 * 1000;
    const maximumClose =
      now.getTime() + policy.maximumDaysToClose * 24 * 60 * 60 * 1000;
    if (market.closesAt.getTime() <= minimumClose) {
      reasons.push("CLOSES_TOO_SOON");
    }
    if (market.closesAt.getTime() > maximumClose) {
      reasons.push("CLOSES_TOO_LATE");
    }
  }
  if (market.settlementRules.trim().length === 0) {
    reasons.push("MISSING_SETTLEMENT_RULES");
  }
  if (
    !market.minimumTradeQuantity.isFinite() ||
    market.minimumTradeQuantity.lte(0)
  ) {
    reasons.push("INVALID_MINIMUM_QUANTITY");
  }
  if (
    !market.priceTick.isFinite() ||
    market.priceTick.lte(0) ||
    market.priceTick.gte(1)
  ) {
    reasons.push("INVALID_PRICE_TICK");
  }
  if (candidate.bbo === undefined) {
    reasons.push("MISSING_BBO");
  } else if (bboValidation.crossed) {
    reasons.push("CROSSED_BBO");
  } else if (!bboValidation.valid) {
    reasons.push("INVALID_BBO");
  }
  if (candidate.book === undefined) {
    reasons.push("MISSING_ORDER_BOOK");
  } else if (orderBookValidation.crossed) {
    reasons.push("CROSSED_ORDER_BOOK");
  } else if (!orderBookValidation.valid) {
    reasons.push("INVALID_ORDER_BOOK");
  }
  if (bboValidation.spread?.gt(policy.maximumSpread) === true) {
    reasons.push("SPREAD_TOO_WIDE");
  }

  const liquidityPasses =
    market.liquidity !== undefined &&
    market.liquidity.isFinite() &&
    market.liquidity.gte(policy.minimumLiquidityUsd);
  const volumePasses =
    market.volume24h !== undefined &&
    market.volume24h.isFinite() &&
    market.volume24h.gte(policy.minimumVolume24hUsd);
  const activityPasses = policy.allowIfLiquidityOrVolumePasses
    ? liquidityPasses || volumePasses
    : liquidityPasses && volumePasses;
  if (!activityPasses) {
    reasons.push("INSUFFICIENT_LIQUIDITY_AND_VOLUME");
  }

  return reasons;
}

function compactRow(ranked: RankedMarket): CompactMarketRow {
  const yesBid = ranked.bbo?.yes.bid;
  const yesAsk = ranked.bbo?.yes.ask;
  const noBid =
    ranked.bbo?.no.bid ??
    (yesAsk === undefined ? undefined : ONE.minus(yesAsk));
  const noAsk =
    ranked.bbo?.no.ask ??
    (yesBid === undefined ? undefined : ONE.minus(yesBid));
  return {
    slug: ranked.market.slug,
    title: ranked.market.title,
    category: ranked.normalizedCategory,
    ...(validDate(ranked.market.closesAt)
      ? { closesAt: ranked.market.closesAt.toISOString() }
      : {}),
    ...(yesBid === undefined ? {} : { yesBid: serializeDecimal(yesBid) }),
    ...(yesAsk === undefined ? {} : { yesAsk: serializeDecimal(yesAsk) }),
    ...(noBid === undefined ? {} : { noBid: serializeDecimal(noBid) }),
    ...(noAsk === undefined ? {} : { noAsk: serializeDecimal(noAsk) }),
    ...(ranked.spread === undefined
      ? {}
      : { spread: serializeDecimal(ranked.spread) }),
    ...(ranked.market.liquidity === undefined
      ? {}
      : { liquidityUsd: serializeDecimal(ranked.market.liquidity) }),
    ...(ranked.market.volume24h === undefined
      ? {}
      : { volume24hUsd: serializeDecimal(ranked.market.volume24h) }),
    rankingScore: ranked.score.toFixed(8),
    held: ranked.hasExistingPosition,
    eligibleForNewExposure: ranked.eligibleForNewExposure,
  };
}

function chooseDetailedMarkets(
  rankedMarkets: readonly RankedMarket[],
  policy: MarketSelectionPolicy,
): readonly RankedMarket[] {
  const held = rankedMarkets.filter((market) => market.hasExistingPosition);
  const chosen = [...held];
  const chosenSlugs = new Set(held.map((market) => market.market.slug));
  const targetCount = Math.max(policy.maximumPromptMarkets, held.length);
  for (const market of rankedMarkets) {
    if (chosen.length >= targetCount) break;
    if (chosenSlugs.has(market.market.slug)) continue;
    chosen.push(market);
    chosenSlugs.add(market.market.slug);
  }

  return chosen;
}

function assertUniqueCandidates(candidates: readonly MarketCandidate[]): void {
  const identities = new Map<string, string>();
  for (const candidate of candidates) {
    const previousId = identities.get(candidate.market.slug);
    if (previousId !== undefined && previousId !== candidate.market.id.value) {
      throw new Error(
        `Conflicting market identifiers for slug ${candidate.market.slug}`,
      );
    }
    if (previousId !== undefined) {
      throw new Error(
        `Duplicate market candidate for slug ${candidate.market.slug}`,
      );
    }
    identities.set(candidate.market.slug, candidate.market.id.value);
  }
}

export function selectMarkets(
  candidates: readonly MarketCandidate[],
  policy: MarketSelectionPolicy,
  now = new Date(),
): MarketSelectionResult {
  if (!validDate(now)) {
    throw new TypeError("Market selection time must be a valid date");
  }
  assertUniqueCandidates(candidates);

  const provisional = candidates.map((candidate) => {
    const bboValidation = validateBbo(candidate.bbo);
    const orderBookValidation = validateOrderBook(candidate.book);
    const reasons = eligibilityReasons(
      candidate,
      policy,
      now,
      bboValidation,
      orderBookValidation,
    );
    const hasExistingPosition = candidate.hasExistingPosition === true;
    return {
      candidate,
      bboValidation,
      reasons,
      hasExistingPosition,
      eligibleForNewExposure: reasons.length === 0,
      includedForReview: reasons.length === 0 || hasExistingPosition,
      volumeLog: logOnePlus(nonNegativeMetric(candidate.market.volume24h)),
      liquidityLog: logOnePlus(nonNegativeMetric(candidate.market.liquidity)),
    };
  });

  const included = provisional.filter((entry) => entry.includedForReview);
  const maximumVolumeLog = included.reduce(
    (maximum, entry) => Decimal.max(maximum, entry.volumeLog),
    ZERO,
  );
  const maximumLiquidityLog = included.reduce(
    (maximum, entry) => Decimal.max(maximum, entry.liquidityLog),
    ZERO,
  );

  const rankedAll: RankedMarket[] = provisional.map((entry) => {
    const score = normalized(entry.volumeLog, maximumVolumeLog)
      .mul(WEIGHT_VOLUME)
      .plus(
        normalized(entry.liquidityLog, maximumLiquidityLog).mul(
          WEIGHT_LIQUIDITY,
        ),
      )
      .plus(
        spreadQuality(entry.bboValidation.spread, policy.maximumSpread).mul(
          WEIGHT_SPREAD,
        ),
      )
      .plus(
        timeRelevance(entry.candidate.market, now, policy).mul(WEIGHT_TIME),
      );
    return {
      market: entry.candidate.market,
      ...(entry.candidate.bbo === undefined
        ? {}
        : { bbo: entry.candidate.bbo }),
      hasExistingPosition: entry.hasExistingPosition,
      eligibleForNewExposure: entry.eligibleForNewExposure,
      includedForReview: entry.includedForReview,
      ineligibilityReasons: entry.reasons,
      ...(entry.bboValidation.spread === undefined
        ? {}
        : { spread: entry.bboValidation.spread }),
      score,
      normalizedCategory: categoryFor(entry.candidate.market),
    };
  });

  const reviewUniverse = rankedAll
    .filter((market) => market.includedForReview)
    .sort(compareRanked);
  const detailedMarkets = chooseDetailedMarkets(reviewUniverse, policy);
  const detailedCategoryCounts: Record<string, number> = {};
  for (const market of detailedMarkets) {
    detailedCategoryCounts[market.normalizedCategory] =
      (detailedCategoryCounts[market.normalizedCategory] ?? 0) + 1;
  }

  return {
    scannedCount: candidates.length,
    eligibleCount: rankedAll.filter((market) => market.eligibleForNewExposure)
      .length,
    reviewUniverse,
    detailedMarkets,
    compactMarkets: reviewUniverse.map(compactRow),
    rejectedMarkets: rankedAll
      .filter((market) => !market.includedForReview)
      .sort((left, right) =>
        left.market.slug.localeCompare(right.market.slug, "en-US"),
      ),
    detailedCategoryCounts,
  };
}

export function chunkCompactMarkets(
  rows: readonly CompactMarketRow[],
  maximumRowsPerChunk: number,
): readonly (readonly CompactMarketRow[])[] {
  if (!Number.isInteger(maximumRowsPerChunk) || maximumRowsPerChunk <= 0) {
    throw new RangeError("maximumRowsPerChunk must be a positive integer");
  }
  const chunks: CompactMarketRow[][] = [];
  for (let index = 0; index < rows.length; index += maximumRowsPerChunk) {
    chunks.push(rows.slice(index, index + maximumRowsPerChunk));
  }
  return chunks;
}
