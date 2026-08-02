import type { AgentConfig } from "../config/schema.js";
import type { Market, MarketBbo } from "../domain/market.js";
import { serializeDecimal } from "../domain/primitives.js";
import type { MarketCatalog } from "./discovery.js";
import {
  buildFamilyScout,
  MAXIMUM_SCOUT_FAMILIES,
  type FamilyScoutFamily,
  type FamilyScoutMember,
} from "./family-scout.js";

export type OpportunityPrioritySignal =
  | {
      /** Discovery hint only; exact prices, state, and settlement still require inspection. */
      readonly advisoryOnly: true;
      readonly kind: "NEAR_SETTLEMENT_DECISIVE_PRICE";
      readonly favoriteSide: "YES" | "NO";
      readonly indicativeFavoritePrice: string;
      readonly hoursToClose: number;
      readonly selectionReason: string;
    }
  | {
      /** Discovery hint only; a title or slug date never proves an outcome. */
      readonly advisoryOnly: true;
      readonly kind: "EVENT_DATE_BEFORE_MARKET_CLOSE";
      readonly eventTiming: "PASSED" | "IMMINENT";
      readonly eventAt: string;
      readonly eventDateSource: "TITLE_SCHEDULED_UTC" | "SLUG_UTC_DAY_END";
      /** Negative values mean the derived event time has already passed. */
      readonly hoursUntilEvent: number;
      readonly hoursUntilMarketClose: number;
      readonly closeLagHours: number;
      readonly selectionReason: string;
    }
  | {
      /** Discovery hint only; the matched wording does not prove the outcome. */
      readonly advisoryOnly: true;
      readonly kind: "RESOLVER_WINDOW_CANDIDATE";
      readonly resolverPattern:
        | "VERBAL_OR_PUBLIC_STATEMENT"
        | "EXPLICIT_SHORT_WINDOW"
        | "OFFICIAL_ACTION_DEADLINE"
        | "DATED_DEADLINE";
      readonly hoursToClose: number;
      readonly resolverDeadlineAt?: string;
      readonly hoursUntilResolverDeadline?: number;
      readonly matchedTerms: readonly string[];
      readonly selectionReason: string;
    }
  | {
      /** Discovery hint only; the exact resolver observation is still required. */
      readonly advisoryOnly: true;
      readonly kind: "SHORT_HORIZON_MEASUREMENT_FAMILY";
      readonly measurementPattern: "EXACT_TEMPERATURE_BUCKET";
      readonly hoursToClose: number;
      readonly selectionReason: string;
    };

export type OpportunityBoardVariant =
  "GENERALIST_CONTROL" | "RESOLVER_LAG_TREATMENT";

export const DEFAULT_OPPORTUNITY_BOARD_VARIANT: OpportunityBoardVariant =
  "RESOLVER_LAG_TREATMENT";

export const MAXIMUM_REQUIRED_PASSED_PRIORITY_MARKETS = 2;

export interface OpportunityBoardItem {
  readonly selectionLane: "EXCHANGE_RANK" | "FAMILY_SCOUT";
  readonly exchangeRank: number;
  readonly slug: string;
  readonly title: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly eventId?: string;
  readonly eventSlug?: string;
  readonly seriesId?: string;
  readonly seriesSlug?: string;
  readonly closesAt: string;
  readonly volumeUsd?: string;
  readonly volume24hUsd?: string;
  readonly liquidityUsd?: string;
  readonly lastPrice?: string;
  readonly prioritySignal?: OpportunityPrioritySignal;
  readonly familyScout?: {
    /** Discovery hint only; never a settlement, risk, or execution identity. */
    readonly advisoryOnly: true;
    readonly familyKey: string;
    readonly recurrenceKey: string;
    readonly kind: FamilyScoutFamily["kind"];
    readonly source: FamilyScoutFamily["source"];
    readonly recurrenceSource: FamilyScoutFamily["recurrenceSource"];
    readonly structure: FamilyScoutFamily["structure"];
    readonly totalMemberCount: number;
    readonly recurrenceInstanceCount: number;
    readonly enrichmentStatus: "SUCCESS" | "FAILED";
    readonly normalizedCategory: string;
    readonly selectionReason: string;
    readonly totalScore: number;
    readonly scoreComponents: {
      readonly liquidityOrDepth: number;
      readonly volume24h: number;
      readonly uncertainty: number;
      readonly exchangeRankQuality: number;
      readonly cappedRecurrence: number;
    };
  };
}

/**
 * Selects a deliberately small passed-event audit set in board order. These
 * markets still need ordinary quote, evidence, settlement, and risk checks;
 * the requirement only prevents the highest-value resolver-lag hypothesis
 * from being silently skipped in favor of broad forecasting research.
 */
export function selectRequiredPassedPriorityMarketSlugs(
  board: readonly OpportunityBoardItem[],
  maximum = MAXIMUM_REQUIRED_PASSED_PRIORITY_MARKETS,
): readonly string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new TypeError(
      "Passed-priority inspection maximum must be a non-negative integer",
    );
  }
  const selected: string[] = [];
  const selectedFamilies = new Set<string>();
  for (const item of board) {
    if (selected.length >= maximum) break;
    if (
      item.prioritySignal?.kind !== "EVENT_DATE_BEFORE_MARKET_CLOSE" ||
      item.prioritySignal.eventTiming !== "PASSED"
    ) {
      continue;
    }
    const family =
      item.familyScout?.familyKey ??
      (item.eventId === undefined
        ? item.eventSlug === undefined
          ? `event-window:${item.category.trim().toLocaleLowerCase("en-US")}:${item.prioritySignal.eventAt}`
          : `event-slug:${item.eventSlug}`
        : `event-id:${item.eventId}`);
    if (selectedFamilies.has(family)) continue;
    selectedFamilies.add(family);
    selected.push(item.slug);
  }
  return selected;
}

export interface OpportunityScoutEnrichment {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly nearTouchTwoSidedDepth?: number;
}

export type OpportunityScoutEnrichmentHandler = (
  marketSlug: string,
  signal?: AbortSignal,
) => Promise<OpportunityScoutEnrichment>;

interface ScoutScore {
  readonly enrichmentStatus: "SUCCESS" | "FAILED";
  readonly normalizedCategory: string;
  readonly selectionReason: string;
  readonly totalScore: number;
  readonly scoreComponents: {
    readonly liquidityOrDepth: number;
    readonly volume24h: number;
    readonly uncertainty: number;
    readonly exchangeRankQuality: number;
    readonly cappedRecurrence: number;
  };
}

function normalizedCategory(market: Market): string {
  const category = market.category?.trim();
  return category === undefined || category.length === 0
    ? "Uncategorized"
    : category;
}

function normalizedCategoryKey(market: Market): string {
  return normalizedCategory(market).toLocaleLowerCase("en-US");
}

function climateCategory(category: string): boolean {
  return /(?:climate|weather|temperature)/iu.test(category);
}

function sportsCategory(category: string): boolean {
  return /(?:sports|esports)/iu.test(category);
}

function supportedSportsLiveFeed(market: Market): boolean {
  const context = `${market.slug} ${market.title}`;
  return (
    /(?:setka|\batp\b|\bwta\b)/iu.test(context) &&
    !/(?:\bitf\b|esports)/iu.test(context)
  );
}

interface RankedCandidate {
  readonly market: Market;
  readonly exchangeRank: number;
  /** Fresh advisory two-sided YES spread used only to rank priority candidates. */
  readonly prioritySpread?: number;
  /** False only after a successful enrichment found no executable ask. */
  readonly priorityQuoteAvailable?: boolean;
}

type PrioritySignal = OpportunityPrioritySignal;

const MAXIMUM_NEAR_SETTLEMENT_PRIORITY_MARKETS = 8;
const MAXIMUM_PRIORITY_ENRICHMENT_MARKETS = 12;
const NEAR_SETTLEMENT_HORIZON_MILLISECONDS = 7 * 86_400_000;
const MINIMUM_DECISIVE_FAVORITE_PRICE = 0.65;
const MAXIMUM_DECISIVE_FAVORITE_PRICE = 0.97;
const MAXIMUM_NEAR_SETTLEMENT_MARKETS_PER_CATEGORY = 2;
const MAXIMUM_NEAR_SETTLEMENT_CLIMATE_MARKETS = 1;
const EVENT_RESEARCH_LOOKAHEAD_MILLISECONDS = 2 * 86_400_000;
const EVENT_RESEARCH_LOOKBACK_MILLISECONDS = 7 * 86_400_000;
const MINIMUM_EVENT_TO_CLOSE_LAG_MILLISECONDS = 12 * 3_600_000;
const MAXIMUM_SPORTS_IMMINENT_LOOKAHEAD_MILLISECONDS = 15 * 60_000;
const RESOLVER_WINDOW_HORIZON_MILLISECONDS = 45 * 86_400_000;
const DATED_RESOLVER_LOOKAROUND_MILLISECONDS = 86_400_000;
const MEASUREMENT_FAMILY_HORIZON_MILLISECONDS = 36 * 3_600_000;

const VERBAL_OR_PUBLIC_STATEMENT_PATTERN =
  /\b(?:say|says|said|mention|mentions|insult|insults|refer(?:s|red|ring)?\s+to|use(?:s|d|ing)?\s+(?:the\s+)?(?:word|phrase)|post(?:s|ed|ing)?|tweet(?:s|ed|ing)?)\b/iu;
const EXPLICIT_SHORT_WINDOW_PATTERN =
  /\b(?:within|in)\s+(?:\d{1,3}|one|two|three|four|five|six|seven)\s+(?:hours?|days?)\b|\b(?:24|48|72)\s*[- ]?hours?\b/iu;
const OFFICIAL_ACTION_PATTERN =
  /\b(?:announce|announces|announced|resign|resigns|resigned|appoint|appoints|appointed|nominate|nominates|nominated|file|files|filed|filing|release|releases|released|publish|publishes|published|launch|launches|launched|visit|visits|visited|meet|meets|met|sign|signs|signed|approve|approves|approved|ban|bans|banned|pardon|pardons|pardoned|indict|indicts|indicted|convict|convicts|convicted|ceasefire|agreement|deal)\b/iu;
const DATED_DEADLINE_PATTERN =
  /\b(?:by|before)\s+(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|(?:19|20)\d{2}|midnight|the\s+deadline|market\s+close)\b/iu;

const UTC_MONTH_INDEX: Readonly<Record<string, number>> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function validUtcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): Date | undefined {
  const date = new Date(Date.UTC(year, monthIndex, day, hour, minute));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIndex &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute
    ? date
    : undefined;
}

function explicitTitleDeadline(market: Market, now: Date): Date | undefined {
  const match =
    /^(?:by|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+((?:19|20)\d{2}))?\b/iu.exec(
      market.title.trim(),
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const monthIndex = UTC_MONTH_INDEX[match[1].toLowerCase()];
  if (monthIndex === undefined) return undefined;
  let year = match[3] === undefined ? now.getUTCFullYear() : Number(match[3]);
  let deadline = validUtcDate(year, monthIndex, Number(match[2]), 23, 59);
  if (
    match[3] === undefined &&
    deadline !== undefined &&
    deadline.getTime() < now.getTime() - 180 * 86_400_000
  ) {
    year += 1;
    deadline = validUtcDate(year, monthIndex, Number(match[2]), 23, 59);
  }
  return deadline;
}

function derivedEventDate(market: Market):
  | {
      readonly eventAt: Date;
      readonly source: "TITLE_SCHEDULED_UTC" | "SLUG_UTC_DAY_END";
    }
  | undefined {
  const scheduled =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s+((?:19|20)\d{2})\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*(?:utc|gmt)\b/iu.exec(
      market.title,
    );
  if (
    scheduled?.[1] !== undefined &&
    scheduled[2] !== undefined &&
    scheduled[3] !== undefined &&
    scheduled[4] !== undefined &&
    scheduled[5] !== undefined &&
    scheduled[6] !== undefined
  ) {
    const monthIndex = UTC_MONTH_INDEX[scheduled[1].toLowerCase()];
    const clockHour = Number(scheduled[4]);
    if (monthIndex !== undefined && clockHour >= 1 && clockHour <= 12) {
      const hour =
        scheduled[6].toLowerCase() === "pm"
          ? (clockHour % 12) + 12
          : clockHour % 12;
      const eventAt = validUtcDate(
        Number(scheduled[3]),
        monthIndex,
        Number(scheduled[2]),
        hour,
        Number(scheduled[5]),
      );
      if (eventAt !== undefined) {
        return { eventAt, source: "TITLE_SCHEDULED_UTC" };
      }
    }
  }

  const slugDate =
    /(?:^|-)((?:19|20)\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])(?:-|$)/u.exec(
      market.slug,
    );
  if (
    slugDate?.[1] === undefined ||
    slugDate[2] === undefined ||
    slugDate[3] === undefined
  ) {
    return undefined;
  }
  const eventAt = validUtcDate(
    Number(slugDate[1]),
    Number(slugDate[2]) - 1,
    Number(slugDate[3]),
    23,
    59,
  );
  return eventAt === undefined
    ? undefined
    : { eventAt, source: "SLUG_UTC_DAY_END" };
}

function eventDatePrioritySignal(
  candidate: RankedCandidate,
  now: Date,
): PrioritySignal | undefined {
  const closesAt = candidate.market.closesAt;
  const derived = derivedEventDate(candidate.market);
  if (closesAt === undefined || derived === undefined) return undefined;
  const millisecondsUntilEvent = derived.eventAt.getTime() - now.getTime();
  const millisecondsUntilClose = closesAt.getTime() - now.getTime();
  const closeLag = closesAt.getTime() - derived.eventAt.getTime();
  if (
    millisecondsUntilClose <= 0 ||
    closeLag < MINIMUM_EVENT_TO_CLOSE_LAG_MILLISECONDS ||
    millisecondsUntilEvent > EVENT_RESEARCH_LOOKAHEAD_MILLISECONDS ||
    millisecondsUntilEvent < -EVENT_RESEARCH_LOOKBACK_MILLISECONDS
  ) {
    return undefined;
  }
  const imminentSupportedSport =
    millisecondsUntilEvent > 0 &&
    millisecondsUntilEvent <= MAXIMUM_SPORTS_IMMINENT_LOOKAHEAD_MILLISECONDS &&
    derived.source === "TITLE_SCHEDULED_UTC" &&
    sportsCategory(normalizedCategoryKey(candidate.market)) &&
    supportedSportsLiveFeed(candidate.market);
  if (millisecondsUntilEvent > 0 && !imminentSupportedSport) return undefined;
  const eventTiming = millisecondsUntilEvent <= 0 ? "PASSED" : "IMMINENT";
  return {
    advisoryOnly: true,
    kind: "EVENT_DATE_BEFORE_MARKET_CLOSE",
    eventTiming,
    eventAt: derived.eventAt.toISOString(),
    eventDateSource: derived.source,
    hoursUntilEvent: Number((millisecondsUntilEvent / 3_600_000).toFixed(2)),
    hoursUntilMarketClose: Number(
      (millisecondsUntilClose / 3_600_000).toFixed(2),
    ),
    closeLagHours: Number((closeLag / 3_600_000).toFixed(2)),
    selectionReason:
      eventTiming === "PASSED"
        ? "derived event time has passed while the exchange market remains open; inspect exact rules and creation time, verify the official live state or result, and assess delayed-resolution or stale-price edge"
        : "supported sports event is scheduled to start within 15 minutes; inspect once for a matching official live-state snapshot, but do not trade from schedule or pre-match price alone",
  };
}

function nearSettlementPrioritySignal(
  candidate: RankedCandidate,
  now: Date,
): PrioritySignal | undefined {
  const { market } = candidate;
  const closesAt = market.closesAt;
  const lastPrice = market.lastPrice;
  if (closesAt === undefined || lastPrice === undefined) return undefined;
  const millisecondsToClose = closesAt.getTime() - now.getTime();
  if (
    millisecondsToClose <= 0 ||
    millisecondsToClose > NEAR_SETTLEMENT_HORIZON_MILLISECONDS
  ) {
    return undefined;
  }
  const yesPrice = lastPrice.toNumber();
  if (!Number.isFinite(yesPrice) || yesPrice < 0 || yesPrice > 1) {
    return undefined;
  }
  const favoritePrice = Math.max(yesPrice, 1 - yesPrice);
  if (
    favoritePrice < MINIMUM_DECISIVE_FAVORITE_PRICE ||
    favoritePrice > MAXIMUM_DECISIVE_FAVORITE_PRICE
  ) {
    return undefined;
  }
  const favoriteSide = yesPrice >= 0.5 ? "YES" : "NO";
  const indicativeFavoritePrice =
    favoriteSide === "YES" ? lastPrice : lastPrice.negated().plus(1);
  const hoursToClose = millisecondsToClose / 3_600_000;
  return {
    advisoryOnly: true,
    kind: "NEAR_SETTLEMENT_DECISIVE_PRICE",
    favoriteSide,
    indicativeFavoritePrice: serializeDecimal(indicativeFavoritePrice),
    hoursToClose: Number(hoursToClose.toFixed(2)),
    selectionReason:
      "closes within seven days with a decisive indicative price; check live event state, exact deadline, resolution source, residual risk, and executable favorite/contrarian edge",
  };
}

function resolverWindowPrioritySignal(
  candidate: RankedCandidate,
  now: Date,
): PrioritySignal | undefined {
  const { market } = candidate;
  const closesAt = market.closesAt;
  if (closesAt === undefined) return undefined;
  const millisecondsToClose = closesAt.getTime() - now.getTime();
  if (
    millisecondsToClose <= 0 ||
    millisecondsToClose > RESOLVER_WINDOW_HORIZON_MILLISECONDS
  ) {
    return undefined;
  }

  const primaryText = [
    market.title,
    market.slug,
    market.eventSlug,
    market.seriesSlug,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  const titleHasDeadline = /^(?:by|before)\b/iu.test(market.title.trim());
  // Descriptions and settlement rules frequently describe how long the
  // exchange itself may take to resolve an ordinary event (for example,
  // "within two days"). Treating that boilerplate as the event's factual
  // deadline promotes false resolver-lag candidates. Candidate identity must
  // be visible in the title/slug/family metadata; exact details remain a
  // required downstream inspection.
  const verbal = VERBAL_OR_PUBLIC_STATEMENT_PATTERN.exec(primaryText)?.[0];
  const shortWindow = EXPLICIT_SHORT_WINDOW_PATTERN.exec(primaryText)?.[0];
  const officialAction = OFFICIAL_ACTION_PATTERN.exec(primaryText)?.[0];
  const datedDeadline = DATED_DEADLINE_PATTERN.exec(primaryText)?.[0];
  const category = normalizedCategoryKey(market);

  let resolverPattern:
    | "VERBAL_OR_PUBLIC_STATEMENT"
    | "EXPLICIT_SHORT_WINDOW"
    | "OFFICIAL_ACTION_DEADLINE"
    | "DATED_DEADLINE"
    | undefined;
  if (verbal !== undefined) {
    resolverPattern = "VERBAL_OR_PUBLIC_STATEMENT";
  } else if (shortWindow !== undefined) {
    resolverPattern = "EXPLICIT_SHORT_WINDOW";
  } else if (
    officialAction !== undefined &&
    !/(?:macro|econom)/iu.test(category)
  ) {
    resolverPattern = "OFFICIAL_ACTION_DEADLINE";
  } else if (titleHasDeadline && datedDeadline !== undefined) {
    resolverPattern = "DATED_DEADLINE";
  }
  if (resolverPattern === undefined) return undefined;

  const resolverDeadline = explicitTitleDeadline(market, now);
  const millisecondsUntilResolverDeadline =
    resolverDeadline === undefined
      ? undefined
      : resolverDeadline.getTime() - now.getTime();
  if (
    resolverPattern === "DATED_DEADLINE" &&
    (millisecondsUntilResolverDeadline === undefined ||
      Math.abs(millisecondsUntilResolverDeadline) >
        DATED_RESOLVER_LOOKAROUND_MILLISECONDS)
  ) {
    return undefined;
  }

  const matchedTerms = [verbal, shortWindow, officialAction, datedDeadline]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim().toLocaleLowerCase("en-US"));
  return {
    advisoryOnly: true,
    kind: "RESOLVER_WINDOW_CANDIDATE",
    resolverPattern,
    hoursToClose: Number((millisecondsToClose / 3_600_000).toFixed(2)),
    ...(resolverDeadline === undefined
      ? {}
      : {
          resolverDeadlineAt: resolverDeadline.toISOString(),
          hoursUntilResolverDeadline: Number(
            ((millisecondsUntilResolverDeadline ?? 0) / 3_600_000).toFixed(2),
          ),
        }),
    matchedTerms: [...new Set(matchedTerms)].slice(0, 4),
    selectionReason:
      "short-dated wording suggests a statement, action, or explicit deadline whose creation time, exact resolver language, and already-public facts may outrun the market price; inspect those mechanics before doing broad forecasting",
  };
}

function measurementFamilyPrioritySignal(
  candidate: RankedCandidate,
  now: Date,
): PrioritySignal | undefined {
  const { market } = candidate;
  if (!climateCategory(normalizedCategoryKey(market))) return undefined;
  const closesAt = market.closesAt;
  if (closesAt === undefined) return undefined;
  const millisecondsToClose = closesAt.getTime() - now.getTime();
  if (
    millisecondsToClose <= 0 ||
    millisecondsToClose > MEASUREMENT_FAMILY_HORIZON_MILLISECONDS
  ) {
    return undefined;
  }
  const context = [
    market.title,
    market.slug,
    market.eventSlug,
    market.seriesSlug,
    market.settlementRules,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  if (
    !/(?:\btemp(?:erature)?\b|highest temperature|lowest temperature|\bhigh\b.*\b(?:fahrenheit|celsius|degrees?|f|c)\b|\blow\b.*\b(?:fahrenheit|celsius|degrees?|f|c)\b)/iu.test(
      context,
    )
  ) {
    return undefined;
  }
  return {
    advisoryOnly: true,
    kind: "SHORT_HORIZON_MEASUREMENT_FAMILY",
    measurementPattern: "EXACT_TEMPERATURE_BUCKET",
    hoursToClose: Number((millisecondsToClose / 3_600_000).toFixed(2)),
    selectionReason:
      "exact-temperature family closes within 36 hours; inspect the complete mutually exclusive family, verify the resolver station and observation method, build one coherent distribution, and compare one or adjacent buckets with combined executable cost",
  };
}

function candidatePrioritySignal(
  candidate: RankedCandidate,
  now: Date,
  variant: OpportunityBoardVariant,
): PrioritySignal | undefined {
  const eventSignal = eventDatePrioritySignal(candidate, now);
  if (variant === "GENERALIST_CONTROL") {
    return eventSignal ?? nearSettlementPrioritySignal(candidate, now);
  }
  if (
    eventSignal?.kind === "EVENT_DATE_BEFORE_MARKET_CLOSE" &&
    eventSignal.eventTiming === "PASSED"
  ) {
    return eventSignal;
  }
  return (
    resolverWindowPrioritySignal(candidate, now) ??
    measurementFamilyPrioritySignal(candidate, now) ??
    eventSignal ??
    nearSettlementPrioritySignal(candidate, now)
  );
}

function prioritySignalRank(
  signal: PrioritySignal,
  market: Market,
  variant: OpportunityBoardVariant,
): number {
  if (variant === "GENERALIST_CONTROL") {
    if (signal.kind === "EVENT_DATE_BEFORE_MARKET_CLOSE") {
      return signal.eventTiming === "PASSED" ? 0 : 1;
    }
    return 2;
  }
  if (signal.kind === "EVENT_DATE_BEFORE_MARKET_CLOSE") {
    if (sportsCategory(normalizedCategoryKey(market))) {
      return signal.eventTiming === "PASSED" ? 5 : 7;
    }
    return signal.eventTiming === "PASSED" ? 0 : 4;
  }
  if (signal.kind === "RESOLVER_WINDOW_CANDIDATE") {
    switch (signal.resolverPattern) {
      case "VERBAL_OR_PUBLIC_STATEMENT":
        return 1;
      case "EXPLICIT_SHORT_WINDOW":
        return 2;
      case "OFFICIAL_ACTION_DEADLINE":
      case "DATED_DEADLINE":
        return 3;
    }
  }
  if (signal.kind === "SHORT_HORIZON_MEASUREMENT_FAMILY") return 4;
  return 6;
}

function highLeverageBoardCandidate(
  candidate: RankedCandidate,
  now: Date,
  variant: OpportunityBoardVariant,
): boolean {
  if (variant === "GENERALIST_CONTROL") return true;
  const category = normalizedCategoryKey(candidate.market);
  const signal = candidatePrioritySignal(candidate, now, variant);
  if (climateCategory(category)) {
    return (
      signal?.kind === "SHORT_HORIZON_MEASUREMENT_FAMILY" ||
      signal?.kind === "NEAR_SETTLEMENT_DECISIVE_PRICE"
    );
  }
  if (!sportsCategory(category)) return true;
  if (signal?.kind === "NEAR_SETTLEMENT_DECISIVE_PRICE") return true;
  const eventSignal = eventDatePrioritySignal(candidate, now);
  return (
    eventSignal?.kind === "EVENT_DATE_BEFORE_MARKET_CLOSE" &&
    eventSignal.eventDateSource === "TITLE_SCHEDULED_UTC" &&
    (eventSignal.eventTiming === "IMMINENT" ||
      eventSignal.hoursUntilEvent >= -4) &&
    supportedSportsLiveFeed(candidate.market)
  );
}

function rankedLaneSelections(
  candidates: readonly RankedCandidate[],
  maximum: number,
  now: Date,
  variant: OpportunityBoardVariant,
): readonly SelectedBoardRow[] {
  if (maximum <= 0) return [];
  const priorityMaximum =
    variant === "GENERALIST_CONTROL"
      ? Math.min(
          maximum,
          MAXIMUM_NEAR_SETTLEMENT_PRIORITY_MARKETS,
          Math.max(1, Math.floor(maximum / 3)),
        )
      : Math.min(maximum, MAXIMUM_NEAR_SETTLEMENT_PRIORITY_MARKETS);
  const prioritized = candidates
    .flatMap((candidate) => {
      const prioritySignal = candidatePrioritySignal(candidate, now, variant);
      return prioritySignal === undefined
        ? []
        : [{ ...candidate, prioritySignal }];
    })
    .toSorted((left, right) => {
      const priorityDifference =
        prioritySignalRank(left.prioritySignal, left.market, variant) -
        prioritySignalRank(right.prioritySignal, right.market, variant);
      if (priorityDifference !== 0) return priorityDifference;
      const spreadDifference =
        (left.prioritySpread ?? Number.POSITIVE_INFINITY) -
        (right.prioritySpread ?? Number.POSITIVE_INFINITY);
      if (spreadDifference !== 0) return spreadDifference;
      const closeDifference =
        (left.market.closesAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (right.market.closesAt?.getTime() ?? Number.POSITIVE_INFINITY);
      if (closeDifference !== 0) return closeDifference;
      const volumeDifference =
        (decimalNumber(right.market.volume24h) ?? 0) -
        (decimalNumber(left.market.volume24h) ?? 0);
      return volumeDifference === 0
        ? left.exchangeRank - right.exchangeRank
        : volumeDifference;
    });
  const selected: SelectedBoardRow[] = [];
  const selectedSlugs = new Set<string>();
  const categoryCounts = new Map<string, number>();
  let climateCount = 0;
  for (const candidate of prioritized) {
    if (selected.length >= priorityMaximum) break;
    const category = normalizedCategoryKey(candidate.market);
    if (
      (categoryCounts.get(category) ?? 0) >=
      MAXIMUM_NEAR_SETTLEMENT_MARKETS_PER_CATEGORY
    ) {
      continue;
    }
    if (
      climateCategory(category) &&
      climateCount >= MAXIMUM_NEAR_SETTLEMENT_CLIMATE_MARKETS
    ) {
      continue;
    }
    selected.push({
      ...candidate,
      selectionLane: "EXCHANGE_RANK",
    });
    selectedSlugs.add(candidate.market.slug);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    if (climateCategory(category)) climateCount += 1;
  }
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    if (selectedSlugs.has(candidate.market.slug)) continue;
    selected.push({ ...candidate, selectionLane: "EXCHANGE_RANK" });
    selectedSlugs.add(candidate.market.slug);
  }
  return selected;
}

function eligibleForBoard(
  market: Market,
  heldSlugs: ReadonlySet<string>,
  policy: AgentConfig["marketSelection"],
  now: Date,
): boolean {
  if (heldSlugs.has(market.slug)) return false;
  if (!market.active || market.closed || market.archived) return false;
  if (market.settlementRules.trim().length === 0) return false;
  if (
    market.closesAt === undefined ||
    Number.isNaN(market.closesAt.getTime())
  ) {
    return false;
  }
  const millisecondsUntilClose = market.closesAt.getTime() - now.getTime();
  const minimumMilliseconds = policy.minimumMinutesToClose * 60_000;
  const maximumMilliseconds = policy.maximumDaysToClose * 86_400_000;
  return (
    millisecondsUntilClose > minimumMilliseconds &&
    millisecondsUntilClose <= maximumMilliseconds
  );
}

function toBoardItem(
  market: Market,
  exchangeRank: number,
  selectionLane: OpportunityBoardItem["selectionLane"],
  familyScout?: FamilyScoutFamily,
  scoutScore?: ScoutScore,
  prioritySignal?: PrioritySignal,
): OpportunityBoardItem {
  const closesAt = market.closesAt;
  if (closesAt === undefined || Number.isNaN(closesAt.getTime())) {
    throw new TypeError(
      "Opportunity-board market must have a valid close time",
    );
  }
  return {
    selectionLane,
    exchangeRank,
    slug: market.slug,
    title: market.title,
    category: normalizedCategory(market),
    ...(market.subcategory === undefined
      ? {}
      : { subcategory: market.subcategory }),
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    closesAt: closesAt.toISOString(),
    ...(market.volume === undefined
      ? {}
      : { volumeUsd: serializeDecimal(market.volume) }),
    ...(market.volume24h === undefined
      ? {}
      : { volume24hUsd: serializeDecimal(market.volume24h) }),
    ...(market.liquidity === undefined
      ? {}
      : { liquidityUsd: serializeDecimal(market.liquidity) }),
    ...(market.lastPrice === undefined
      ? {}
      : { lastPrice: serializeDecimal(market.lastPrice) }),
    ...(prioritySignal === undefined ? {} : { prioritySignal }),
    ...(familyScout === undefined
      ? {}
      : {
          familyScout: {
            advisoryOnly: true,
            familyKey: familyScout.familyKey,
            recurrenceKey: familyScout.recurrenceKey,
            kind: familyScout.kind,
            source: familyScout.source,
            recurrenceSource: familyScout.recurrenceSource,
            structure: familyScout.structure,
            totalMemberCount: familyScout.totalMemberCount,
            recurrenceInstanceCount: familyScout.recurrenceInstanceCount,
            enrichmentStatus: scoutScore?.enrichmentStatus ?? "FAILED",
            normalizedCategory:
              scoutScore?.normalizedCategory ??
              normalizedCategory(market).toLocaleLowerCase("en-US"),
            selectionReason:
              scoutScore?.selectionReason ?? "catalog-only family scout",
            totalScore: scoutScore?.totalScore ?? 0,
            scoreComponents: scoutScore?.scoreComponents ?? {
              liquidityOrDepth: 0,
              volume24h: 0,
              uncertainty: 0,
              exchangeRankQuality: 0,
              cappedRecurrence: 0,
            },
          },
        }),
  };
}

interface SelectedBoardRow {
  readonly market: Market;
  readonly exchangeRank: number;
  readonly selectionLane: OpportunityBoardItem["selectionLane"];
  readonly familyScout?: FamilyScoutFamily;
  readonly scoutScore?: ScoutScore;
  readonly prioritySignal?: PrioritySignal;
}

function familyScoutSelections(
  families: readonly FamilyScoutFamily[],
  maximum: number,
  alreadySelected: ReadonlySet<string>,
): readonly SelectedBoardRow[] {
  const selected: SelectedBoardRow[] = [];
  const seen = new Set(alreadySelected);
  const maximumRounds = Math.max(
    0,
    ...families.map((family) => family.sampledMembers.length),
  );
  for (let round = 0; round < maximumRounds; round += 1) {
    for (const family of families) {
      if (selected.length >= maximum) return selected;
      const member: FamilyScoutMember | undefined =
        family.sampledMembers[round];
      if (member === undefined || seen.has(member.market.slug)) continue;
      seen.add(member.market.slug);
      selected.push({
        ...member,
        selectionLane: "FAMILY_SCOUT",
        familyScout: family,
      });
    }
  }
  return selected;
}

/**
 * Builds a cheap deterministic board from catalog metadata. The leading lane
 * preserves exchange rank while an optional bounded lane surfaces recurring
 * families and ladders. Family-scout identities are advisory only. The board
 * is not inspected market evidence; exact details and executable prices must
 * still be fetched before a target can produce an order.
 */
export function buildOpportunityBoard(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  now = new Date(),
  variant: OpportunityBoardVariant = DEFAULT_OPPORTUNITY_BOARD_VARIANT,
): readonly OpportunityBoardItem[] {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("Opportunity-board time must be a valid date");
  }

  const candidates = catalog.markets
    .map((market, index) => ({
      market,
      exchangeRank: catalog.exchangeRanks.get(market.slug) ?? index + 1,
    }))
    .filter(({ market }) =>
      eligibleForBoard(market, catalog.heldSlugs, policy, now),
    )
    .filter((candidate) => highLeverageBoardCandidate(candidate, now, variant))
    .sort((left, right) => left.exchangeRank - right.exchangeRank);

  const scoutPolicy = policy.familyScouts;
  if (
    scoutPolicy === undefined ||
    !scoutPolicy.enabled ||
    scoutPolicy.reservedPromptMarkets === 0
  ) {
    return rankedLaneSelections(
      candidates,
      policy.maximumPromptMarkets,
      now,
      variant,
    ).map(({ market, exchangeRank, selectionLane, prioritySignal }) =>
      toBoardItem(
        market,
        exchangeRank,
        selectionLane,
        undefined,
        undefined,
        prioritySignal ??
          candidatePrioritySignal({ market, exchangeRank }, now, variant),
      ),
    );
  }

  const reservedScoutMarkets = Math.min(
    policy.maximumPromptMarkets,
    scoutPolicy.reservedPromptMarkets,
  );
  const rankedMarketCount = policy.maximumPromptMarkets - reservedScoutMarkets;
  const ranked = rankedLaneSelections(
    candidates,
    rankedMarketCount,
    now,
    variant,
  );
  const selectedSlugs = new Set(ranked.map(({ market }) => market.slug));
  const families = buildFamilyScout(candidates, {
    maximumFamilies: scoutPolicy.maximumFamilies,
    maximumMembersPerFamily: scoutPolicy.maximumMembersPerFamily,
    minimumFamilyMembers: scoutPolicy.minimumFamilyMembers,
  });
  const scouted = familyScoutSelections(
    families,
    reservedScoutMarkets,
    selectedSlugs,
  );
  for (const { market } of scouted) selectedSlugs.add(market.slug);

  const selected: SelectedBoardRow[] = [...ranked, ...scouted];
  for (const candidate of candidates) {
    if (selected.length >= policy.maximumPromptMarkets) break;
    if (selectedSlugs.has(candidate.market.slug)) continue;
    selectedSlugs.add(candidate.market.slug);
    selected.push({
      ...candidate,
      selectionLane: "EXCHANGE_RANK",
    });
  }
  return selected.map(
    ({
      market,
      exchangeRank,
      selectionLane,
      familyScout,
      scoutScore,
      prioritySignal,
    }) =>
      toBoardItem(
        market,
        exchangeRank,
        selectionLane,
        familyScout,
        scoutScore,
        prioritySignal ??
          candidatePrioritySignal({ market, exchangeRank }, now, variant),
      ),
  );
}

function categoryDiverseFamilies(
  families: readonly FamilyScoutFamily[],
  maximum: number,
): readonly FamilyScoutFamily[] {
  const buckets = new Map<string, FamilyScoutFamily[]>();
  for (const family of families) {
    const representative = family.sampledMembers[0]?.market;
    if (representative === undefined) continue;
    const category = normalizedCategoryKey(representative);
    const bucket = buckets.get(category) ?? [];
    bucket.push(family);
    buckets.set(category, bucket);
  }
  const orderedBuckets = [...buckets.entries()].toSorted((left, right) => {
    const leftRank = left[1][0]?.bestExchangeRank ?? Number.POSITIVE_INFINITY;
    const rightRank = right[1][0]?.bestExchangeRank ?? Number.POSITIVE_INFINITY;
    const rank = leftRank - rightRank;
    return rank === 0 ? left[0].localeCompare(right[0], "en-US") : rank;
  });
  const selected: FamilyScoutFamily[] = [];
  for (let round = 0; selected.length < maximum; round += 1) {
    let appended = false;
    for (const [, bucket] of orderedBuckets) {
      const family = bucket[round];
      if (family === undefined) continue;
      selected.push(family);
      appended = true;
      if (selected.length >= maximum) break;
    }
    if (!appended) break;
  }
  return selected;
}

async function boundedEnrich(
  rows: readonly {
    readonly member: FamilyScoutMember;
    readonly family: FamilyScoutFamily;
  }[],
  handler: OpportunityScoutEnrichmentHandler,
  signal: AbortSignal | undefined,
): Promise<
  readonly {
    readonly member: FamilyScoutMember;
    readonly family: FamilyScoutFamily;
    readonly result?: OpportunityScoutEnrichment;
  }[]
> {
  interface EnrichedRow {
    member: FamilyScoutMember;
    family: FamilyScoutFamily;
    result?: OpportunityScoutEnrichment;
  }
  const output: (EnrichedRow | undefined)[] = Array.from(
    { length: rows.length },
    () => undefined,
  );
  let next = 0;
  const workers = Array.from({ length: Math.min(4, rows.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const row = rows[index];
      if (row === undefined) return;
      try {
        signal?.throwIfAborted();
        output[index] = {
          ...row,
          result: await handler(row.member.market.slug, signal),
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        output[index] = row;
      }
    }
  });
  await Promise.all(workers);
  return output.map((row, index) => {
    if (row === undefined) {
      throw new Error(`Scout enrichment worker omitted row ${index}`);
    }
    return row;
  });
}

async function boundedPriorityEnrich(
  candidates: readonly RankedCandidate[],
  handler: OpportunityScoutEnrichmentHandler,
  signal: AbortSignal | undefined,
): Promise<
  readonly {
    readonly candidate: RankedCandidate;
    readonly result?: OpportunityScoutEnrichment;
  }[]
> {
  interface EnrichedCandidate {
    candidate: RankedCandidate;
    result?: OpportunityScoutEnrichment;
  }
  const output: (EnrichedCandidate | undefined)[] = Array.from(
    { length: candidates.length },
    () => undefined,
  );
  let next = 0;
  const workers = Array.from(
    { length: Math.min(4, candidates.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const candidate = candidates[index];
        if (candidate === undefined) return;
        try {
          signal?.throwIfAborted();
          output[index] = {
            candidate,
            result: await handler(candidate.market.slug, signal),
          };
        } catch (error) {
          if (signal?.aborted === true) throw error;
          output[index] = { candidate };
        }
      }
    },
  );
  await Promise.all(workers);
  return output.map((row, index) => {
    if (row === undefined) {
      throw new Error(`Priority enrichment worker omitted row ${index}`);
    }
    return row;
  });
}

function decimalNumber(
  value: { toNumber(): number } | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const number = value.toNumber();
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function scaled(value: number | undefined, maximum: number): number {
  if (value === undefined || maximum <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(maximum));
}

/**
 * Builds the live board with a bounded second-stage enrichment pass. Only the
 * family-scout lane is re-ranked; the leading exchange-ranked lane remains
 * deterministic and final backfill always follows exchange rank.
 */
export async function buildEnrichedOpportunityBoard(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  enrich: OpportunityScoutEnrichmentHandler,
  now = new Date(),
  signal?: AbortSignal,
  variant: OpportunityBoardVariant = DEFAULT_OPPORTUNITY_BOARD_VARIANT,
): Promise<readonly OpportunityBoardItem[]> {
  const scoutPolicy = policy.familyScouts;
  if (
    scoutPolicy === undefined ||
    !scoutPolicy.enabled ||
    scoutPolicy.reservedPromptMarkets === 0 ||
    (scoutPolicy.enrichmentRequestBudget ?? 24) === 0
  ) {
    return buildOpportunityBoard(catalog, policy, now, variant);
  }
  const candidates: readonly RankedCandidate[] = catalog.markets
    .map((market, index) => ({
      market,
      exchangeRank: catalog.exchangeRanks.get(market.slug) ?? index + 1,
    }))
    .filter(({ market }) =>
      eligibleForBoard(market, catalog.heldSlugs, policy, now),
    )
    .filter((candidate) => highLeverageBoardCandidate(candidate, now, variant))
    .sort((left, right) => left.exchangeRank - right.exchangeRank);
  const totalEnrichmentBudget = scoutPolicy.enrichmentRequestBudget ?? 24;
  const priorityEnrichmentMaximum = Math.min(
    MAXIMUM_PRIORITY_ENRICHMENT_MARKETS,
    Math.ceil(totalEnrichmentBudget / 2),
  );
  const prioritySeeds = candidates
    .flatMap((candidate) => {
      const prioritySignal = candidatePrioritySignal(candidate, now, variant);
      return prioritySignal === undefined
        ? []
        : [{ candidate, prioritySignal }];
    })
    .toSorted((left, right) => {
      const priorityDifference =
        prioritySignalRank(
          left.prioritySignal,
          left.candidate.market,
          variant,
        ) -
        prioritySignalRank(
          right.prioritySignal,
          right.candidate.market,
          variant,
        );
      if (priorityDifference !== 0) return priorityDifference;
      const closeDifference =
        (left.candidate.market.closesAt?.getTime() ??
          Number.POSITIVE_INFINITY) -
        (right.candidate.market.closesAt?.getTime() ??
          Number.POSITIVE_INFINITY);
      if (closeDifference !== 0) return closeDifference;
      const volumeDifference =
        (decimalNumber(right.candidate.market.volume24h) ?? 0) -
        (decimalNumber(left.candidate.market.volume24h) ?? 0);
      return volumeDifference === 0
        ? left.candidate.exchangeRank - right.candidate.exchangeRank
        : volumeDifference;
    })
    .slice(0, priorityEnrichmentMaximum)
    .map(({ candidate }) => candidate);
  const enrichedPriority = await boundedPriorityEnrich(
    prioritySeeds,
    enrich,
    signal,
  );
  const priorityBySlug = new Map(
    enrichedPriority.map(({ candidate, result }) => {
      if (result === undefined)
        return [candidate.market.slug, candidate] as const;
      const bid = decimalNumber(result.bbo?.yes.bid);
      const ask = decimalNumber(result.bbo?.yes.ask);
      const prioritySpread =
        bid !== undefined && ask !== undefined && ask >= bid
          ? ask - bid
          : undefined;
      const priorityQuoteAvailable =
        result.bbo?.yes.ask !== undefined || result.bbo?.no.ask !== undefined;
      return [
        candidate.market.slug,
        {
          market: result.market,
          exchangeRank: candidate.exchangeRank,
          priorityQuoteAvailable,
          ...(prioritySpread === undefined ? {} : { prioritySpread }),
        },
      ] as const;
    }),
  );
  const refreshedCandidates = candidates
    .map((candidate) => priorityBySlug.get(candidate.market.slug) ?? candidate)
    .filter(({ market }) =>
      eligibleForBoard(market, catalog.heldSlugs, policy, now),
    )
    .filter((candidate) => candidate.priorityQuoteAvailable !== false)
    .filter(
      (candidate) =>
        candidate.prioritySpread === undefined ||
        candidate.prioritySpread <= policy.maximumSpread.toNumber(),
    );

  const reserved = Math.min(
    policy.maximumPromptMarkets,
    scoutPolicy.reservedPromptMarkets,
  );
  const rankedCount = policy.maximumPromptMarkets - reserved;
  const selected: SelectedBoardRow[] = [
    ...rankedLaneSelections(refreshedCandidates, rankedCount, now, variant),
  ];
  const selectedSlugs = new Set(selected.map(({ market }) => market.slug));
  const allFamilies = buildFamilyScout(refreshedCandidates, {
    maximumFamilies: MAXIMUM_SCOUT_FAMILIES,
    maximumMembersPerFamily: scoutPolicy.maximumMembersPerFamily,
    minimumFamilyMembers: scoutPolicy.minimumFamilyMembers,
  });
  const families = categoryDiverseFamilies(
    allFamilies,
    scoutPolicy.maximumFamilies,
  );
  const priorityEnrichedSlugs = new Set(
    enrichedPriority.map(({ candidate }) => candidate.market.slug),
  );
  const remainingEnrichmentBudget = Math.max(
    0,
    totalEnrichmentBudget - prioritySeeds.length,
  );
  const enrichmentRows = families
    .flatMap((family) =>
      family.sampledMembers.map((member) => ({ member, family })),
    )
    .filter(
      ({ member }) =>
        !selectedSlugs.has(member.market.slug) &&
        !priorityEnrichedSlugs.has(member.market.slug),
    )
    .slice(0, remainingEnrichmentBudget);
  const enriched = await boundedEnrich(enrichmentRows, enrich, signal);
  const liquidityValues = enriched.map(({ result }) => {
    const liquidity = decimalNumber(result?.market.liquidity);
    const midpoint =
      result?.bbo?.yes.bid !== undefined && result.bbo.yes.ask !== undefined
        ? result.bbo.yes.bid.plus(result.bbo.yes.ask).div(2).toNumber()
        : undefined;
    const depthUsd =
      result?.nearTouchTwoSidedDepth === undefined || midpoint === undefined
        ? undefined
        : result.nearTouchTwoSidedDepth * midpoint;
    return Math.max(liquidity ?? 0, depthUsd ?? 0);
  });
  const volumeValues = enriched.map(({ result }) =>
    decimalNumber(result?.market.volume24h),
  );
  const maximumLiquidity = Math.max(0, ...liquidityValues);
  const maximumVolume = Math.max(0, ...volumeValues.map((value) => value ?? 0));
  const evaluated = enriched.map(
    ({ member, family, result }, index): SelectedBoardRow => {
      const market = result?.market ?? member.market;
      const midpoint =
        result?.bbo?.yes.bid !== undefined && result.bbo.yes.ask !== undefined
          ? result.bbo.yes.bid.plus(result.bbo.yes.ask).div(2).toNumber()
          : decimalNumber(market.lastPrice);
      const scoreComponents = {
        liquidityOrDepth: scaled(
          result === undefined ? undefined : liquidityValues[index],
          maximumLiquidity,
        ),
        volume24h: scaled(
          result === undefined ? undefined : volumeValues[index],
          maximumVolume,
        ),
        uncertainty:
          midpoint === undefined
            ? 0
            : Math.max(0, 1 - Math.abs(midpoint - 0.5) * 2),
        exchangeRankQuality:
          refreshedCandidates.length <= 1
            ? 1
            : Math.max(
                0,
                1 -
                  (member.exchangeRank - 1) / (refreshedCandidates.length - 1),
              ),
        cappedRecurrence: Math.min(5, family.recurrenceInstanceCount) / 5,
      };
      const totalScore =
        scoreComponents.liquidityOrDepth * 0.35 +
        scoreComponents.volume24h * 0.25 +
        scoreComponents.uncertainty * 0.25 +
        scoreComponents.exchangeRankQuality * 0.1 +
        scoreComponents.cappedRecurrence * 0.05;
      const category = normalizedCategoryKey(market);
      return {
        market,
        exchangeRank: member.exchangeRank,
        selectionLane: "FAMILY_SCOUT",
        familyScout: family,
        scoutScore: {
          enrichmentStatus: result === undefined ? "FAILED" : "SUCCESS",
          normalizedCategory: category,
          selectionReason:
            result === undefined
              ? "enrichment failed; exchange-rank backfill preferred"
              : `weighted liquidity/depth, 24h volume, uncertainty, exchange rank, and capped recurrence (${totalScore.toFixed(4)})`,
          totalScore,
          scoreComponents,
        },
      };
    },
  );
  const byFamily = new Map<string, SelectedBoardRow[]>();
  for (const row of evaluated) {
    if (row.scoutScore?.enrichmentStatus !== "SUCCESS") continue;
    const key = row.familyScout?.familyKey;
    if (key === undefined) continue;
    const bucket = byFamily.get(key) ?? [];
    bucket.push(row);
    byFamily.set(key, bucket);
  }
  for (const bucket of byFamily.values()) {
    bucket.sort((left, right) => {
      const score =
        (right.scoutScore?.totalScore ?? 0) -
        (left.scoutScore?.totalScore ?? 0);
      return score === 0 ? left.exchangeRank - right.exchangeRank : score;
    });
  }
  const familyBuckets = [...byFamily.values()].toSorted((left, right) => {
    const score =
      (right[0]?.scoutScore?.totalScore ?? 0) -
      (left[0]?.scoutScore?.totalScore ?? 0);
    return score === 0
      ? (left[0]?.exchangeRank ?? 0) - (right[0]?.exchangeRank ?? 0)
      : score;
  });
  const categoryCounts = new Map<string, number>();
  let climateCount = 0;
  const maximumPerCategory = scoutPolicy.maximumMarketsPerCategory ?? 3;
  const maximumClimate = scoutPolicy.maximumClimateMarkets ?? 2;
  const maximumRounds = Math.max(
    0,
    ...familyBuckets.map((bucket) => bucket.length),
  );
  for (let round = 0; round < maximumRounds; round += 1) {
    for (const bucket of familyBuckets) {
      if (selected.length >= policy.maximumPromptMarkets) break;
      const row = bucket[round];
      if (row === undefined || selectedSlugs.has(row.market.slug)) continue;
      const category = row.scoutScore?.normalizedCategory ?? "uncategorized";
      if ((categoryCounts.get(category) ?? 0) >= maximumPerCategory) continue;
      if (climateCategory(category) && climateCount >= maximumClimate) continue;
      selected.push(row);
      selectedSlugs.add(row.market.slug);
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      if (climateCategory(category)) climateCount += 1;
    }
  }
  for (const candidate of refreshedCandidates) {
    if (selected.length >= policy.maximumPromptMarkets) break;
    if (selectedSlugs.has(candidate.market.slug)) continue;
    selectedSlugs.add(candidate.market.slug);
    selected.push({ ...candidate, selectionLane: "EXCHANGE_RANK" });
  }
  return selected.map(
    ({
      market,
      exchangeRank,
      selectionLane,
      familyScout,
      scoutScore,
      prioritySignal,
    }) =>
      toBoardItem(
        market,
        exchangeRank,
        selectionLane,
        familyScout,
        scoutScore,
        prioritySignal ??
          candidatePrioritySignal({ market, exchangeRank }, now, variant),
      ),
  );
}
