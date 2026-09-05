import { Decimal } from "decimal.js";
import type { AgentConfig } from "../config/schema.js";
import type { Market, MarketBbo } from "../domain/market.js";
import { serializeDecimal } from "../domain/primitives.js";
import type { MarketCatalog } from "./discovery.js";
import type { AgentDecision } from "./decision-schema.js";
import type {
  CriticalLearningPolicy,
  DetailedMarketContext,
} from "./context-builder.js";
import {
  buildFamilyScout,
  MAXIMUM_SCOUT_FAMILIES,
  type FamilyScoutFamily,
} from "./family-scout.js";

/** Strategy-supplied discovery metadata; never execution or settlement evidence. */
export interface OpportunityPrioritySignal {
  readonly advisoryOnly: true;
  readonly kind: string;
  readonly selectionReason: string;
  readonly [key: string]: unknown;
}

export type OpportunityBoardVariant = string;
export const DEFAULT_OPPORTUNITY_BOARD_VARIANT = "EXCHANGE_RANK";

export interface OpportunityBoardItem {
  readonly selectionLane: string;
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
    readonly scoreComponents: Readonly<Record<string, number>>;
  };
}

export interface OpportunityScoutEnrichment {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly nearTouchTwoSidedDepth?: number;
  /** Ask-side price times quantity within the deployment's depth price band. */
  readonly yesNearTouchBuyNotionalUsd?: number;
  readonly noNearTouchBuyNotionalUsd?: number;
}

export type OpportunityScoutEnrichmentHandler = (
  marketSlug: string,
  signal?: AbortSignal,
) => Promise<OpportunityScoutEnrichment>;

export interface SelectionExperimentDefinition {
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly controlVariant: string;
  readonly treatmentVariant: string;
  readonly limitations: readonly string[];
}

export interface SelectionPolicy {
  readonly depthPriceBand?: Decimal;
  readonly buildFamilyScout?: typeof buildFamilyScout;
  readonly shouldFetchFamilyBook?: (market: Market) => boolean;
  readonly allowWebSearch?: (
    board: readonly OpportunityBoardItem[],
    heldCount: number,
  ) => boolean;
  readonly shouldEnforceRequiredResearch?: (
    decision: AgentDecision,
    detailsBySlug: ReadonlyMap<string, DetailedMarketContext>,
  ) => boolean;
  readonly buildCriticalLearning?: CriticalLearningPolicy;
  readonly buildOpportunityBoard: typeof buildOpportunityBoard;
  readonly buildEnrichedOpportunityBoard: typeof buildEnrichedOpportunityBoard;
  readonly selectRequiredMarketSlugs: (
    board: readonly OpportunityBoardItem[],
    maximum?: number,
  ) => readonly string[];
  readonly experimentDefinition?: SelectionExperimentDefinition;
}

export const selectionPolicyApi = Object.freeze({
  Decimal,
  serializeDecimal,
  buildFamilyScout,
  MAXIMUM_SCOUT_FAMILIES,
});

export type SelectionPolicyApi = typeof selectionPolicyApi;

export function eligibleForOpportunityBoard(
  market: Market,
  heldSlugs: ReadonlySet<string>,
  policy: AgentConfig["marketSelection"],
  now: Date,
): boolean {
  if (heldSlugs.has(market.slug)) return false;
  if (!market.active || market.closed || market.archived) return false;
  if (market.settlementRules.trim().length === 0) return false;
  const closesAt = market.closesAt;
  if (closesAt === undefined || !Number.isFinite(closesAt.getTime()))
    return false;
  const millisecondsUntilClose = closesAt.getTime() - now.getTime();
  return (
    millisecondsUntilClose > policy.minimumMinutesToClose * 60_000 &&
    millisecondsUntilClose <= policy.maximumDaysToClose * 86_400_000
  );
}

function toBoardItem(
  market: Market,
  exchangeRank: number,
): OpportunityBoardItem {
  const closesAt = market.closesAt;
  if (closesAt === undefined || !Number.isFinite(closesAt.getTime())) {
    throw new TypeError(
      "Opportunity-board market must have a valid close time",
    );
  }
  const category = market.category?.trim();
  return {
    selectionLane: "EXCHANGE_RANK",
    exchangeRank,
    slug: market.slug,
    title: market.title,
    category:
      category === undefined || category.length === 0
        ? "Uncategorized"
        : category,
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
  };
}

function candidates(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  now: Date,
): readonly { readonly market: Market; readonly exchangeRank: number }[] {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Opportunity-board time must be a valid date");
  }
  if (
    !Number.isSafeInteger(policy.maximumPromptMarkets) ||
    policy.maximumPromptMarkets < 0
  ) {
    throw new TypeError(
      "Opportunity-board maximum must be a non-negative integer",
    );
  }
  const seen = new Set<string>();
  return catalog.markets
    .map((market, index) => ({
      market,
      exchangeRank: catalog.exchangeRanks.get(market.slug) ?? index + 1,
    }))
    .filter(({ market }) => {
      if (seen.has(market.slug)) return false;
      seen.add(market.slug);
      return eligibleForOpportunityBoard(
        market,
        catalog.heldSlugs,
        policy,
        now,
      );
    })
    .sort((left, right) => left.exchangeRank - right.exchangeRank);
}

/** Neutral reference policy: expose eligible catalog rows in exchange order. */
export function buildOpportunityBoard(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  now = new Date(),
  variant: OpportunityBoardVariant = DEFAULT_OPPORTUNITY_BOARD_VARIANT,
): readonly OpportunityBoardItem[] {
  void variant;
  return candidates(catalog, policy, now)
    .slice(0, policy.maximumPromptMarkets)
    .map(({ market, exchangeRank }) => toBoardItem(market, exchangeRank));
}

/** Refresh bounded catalog rows without strategy ranking or source selection. */
export async function buildEnrichedOpportunityBoard(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  enrich: OpportunityScoutEnrichmentHandler,
  now = new Date(),
  signal?: AbortSignal,
  variant: OpportunityBoardVariant = DEFAULT_OPPORTUNITY_BOARD_VARIANT,
): Promise<readonly OpportunityBoardItem[]> {
  void variant;
  signal?.throwIfAborted();
  const ranked = candidates(catalog, policy, now);
  const budget =
    policy.familyScouts?.enabled === true
      ? (policy.familyScouts.enrichmentRequestBudget ?? 0)
      : 0;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new TypeError("Enrichment budget must be a non-negative integer");
  }
  const results = new Map<string, OpportunityScoutEnrichment | null>();
  let next = 0;
  const count = Math.min(budget, ranked.length);
  await Promise.all(
    Array.from({ length: Math.min(4, count) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= count) return;
        const row = ranked[index];
        if (row === undefined) return;
        try {
          signal?.throwIfAborted();
          const result = await enrich(row.market.slug, signal);
          signal?.throwIfAborted();
          results.set(
            row.market.slug,
            result.market.slug === row.market.slug ? result : null,
          );
        } catch (error) {
          if (signal?.aborted === true) throw error;
          // Failed refresh leaves catalog metadata advisory; execution still inspects.
        }
      }
    }),
  );
  return ranked
    .flatMap(({ market, exchangeRank }) => {
      const result = results.get(market.slug);
      if (result === null) return [];
      const refreshed = result?.market ?? market;
      if (
        !eligibleForOpportunityBoard(refreshed, catalog.heldSlugs, policy, now)
      )
        return [];
      if (result !== undefined) {
        if (
          result.bbo?.yes.ask === undefined &&
          result.bbo?.no.ask === undefined
        )
          return [];
        const bid = result.bbo.yes.bid;
        const ask = result.bbo.yes.ask;
        if (
          bid !== undefined &&
          ask !== undefined &&
          (ask.lt(bid) || ask.minus(bid).gt(policy.maximumSpread))
        )
          return [];
      }
      return [toBoardItem(refreshed, exchangeRank)];
    })
    .slice(0, policy.maximumPromptMarkets);
}

export const referenceSelectionPolicy: SelectionPolicy = {
  depthPriceBand: new Decimal(0),
  buildOpportunityBoard,
  buildEnrichedOpportunityBoard,
  selectRequiredMarketSlugs: () => [],
};
