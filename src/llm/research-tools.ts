import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { AgentDecision } from "../agent/decision-schema.js";
import {
  canonicalEvidenceUrl,
  EvidenceSourceRegistry,
  fetchEvidencePage,
  type FetchedEvidencePage,
  type ObservedEvidenceSource,
} from "../agent/evidence-provenance.js";
import {
  AgentDecisionModelJsonSchema,
  parseModelAgentDecision,
} from "../agent/decision-schema.js";
import type { DetailedMarketContext } from "../agent/context-builder.js";
import type { SelectionPolicy } from "../agent/opportunity-board.js";
import {
  MarketDiscoveryNarrowingRequiredError,
  type MarketFacetPage,
  type MarketFacetRequest,
  type MarketCatalogRow,
  type MarketDiscoveryMode,
  type MarketDiscoveryPage,
  type MarketDiscoveryRequest,
} from "../agent/discovery.js";
import type {
  MarketAnalysisRequest,
  MarketAnalysisResult,
} from "../agent/market-analysis.js";
import type {
  AgentNoteOperation,
  AgentNoteOperationResult,
} from "../agent/memory.js";
import type {
  AgentStateOperation,
  AgentStateOperationResult,
} from "../agent/agent-state.js";
import type {
  AdvisoryTradePreviewRequest,
  AdvisoryTradePreviewResult,
} from "../agent/trade-preview.js";
import type {
  PromptBundle,
  ResearchToolMessages,
  ResearchToolPrompts,
} from "../config/prompts.js";
import {
  isInNativeMarketFamily,
  nativeMarketFamilyKey,
  type MarketFamilySeed,
  type NativeMarketFamily,
} from "../domain/market-family.js";
import type { DecisionLimits } from "./decision-provider.js";
import {
  tableTennisSetComplete,
  tableTennisSetWinProbability,
  firstToThreeMatchWinProbability,
  inverseMonotonicProbability,
} from "../domain/probability-math.js";

export type DecisionToolName =
  | "list_market_facets"
  | "discover_markets"
  | "web_search"
  | "read_evidence_source"
  | "get_market_details"
  | "get_market_family_details"
  | "get_market_analysis"
  | "preview_trade"
  | "manage_notes"
  | "manage_state"
  | "submit_trade_plan";

export interface DecisionToolDefinition {
  readonly name: DecisionToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly terminal: boolean;
}

const DISCOVERY_MODES = [
  "ALL",
  "KEYWORD",
  "CATEGORY",
  "TAG",
  "EVENT",
  "SERIES",
  "VOLUME",
  "VOLATILITY",
  "TRENDING",
  "EXPIRING",
] as const satisfies readonly MarketDiscoveryMode[];

const DISCOVERY_MODE_SELECTORS = [
  ["KEYWORD", "query"],
  ["CATEGORY", "category"],
  ["TAG", "tag"],
  ["EVENT", "event"],
  ["SERIES", "series"],
] as const;

const NonNegativeDecimalStringSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    try {
      const decimal = new Decimal(value);
      if (!decimal.isFinite() || decimal.lt(0)) {
        context.addIssue({
          code: "custom",
          message: "Expected a non-negative finite decimal string",
        });
        return z.NEVER;
      }
      return decimal;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Expected a valid decimal string",
      });
      return z.NEVER;
    }
  });

const ProbabilityPointDeltaStringSchema = NonNegativeDecimalStringSchema.refine(
  (value) => value.lte(1),
  "Expected a probability-point delta from zero through one",
);

const PositiveDecimalStringSchema = NonNegativeDecimalStringSchema.refine(
  (value) => value.gt(0),
  "Expected a positive decimal string",
);

const StrictProbabilityStringSchema = PositiveDecimalStringSchema.refine(
  (value) => value.lt(1),
  "Expected a probability strictly between zero and one",
);

const DiscoveryDateSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const MarketDiscoveryInputSchema = z
  .object({
    mode: z.enum(DISCOVERY_MODES),
    query: z.string().trim().min(1).max(300).optional(),
    category: z.string().trim().min(1).max(200).optional(),
    tag: z.string().trim().min(1).max(200).optional(),
    event: z.string().trim().min(1).max(500).optional(),
    series: z.string().trim().min(1).max(500).optional(),
    cursor: z.string().trim().min(1).max(2_000).optional(),
    limit: z.number().int().positive().max(25).optional(),
    closesAfter: DiscoveryDateSchema.optional(),
    closesBefore: DiscoveryDateSchema.optional(),
    minimumLiquidityUsd: NonNegativeDecimalStringSchema.optional(),
    minimumVolumeUsd: NonNegativeDecimalStringSchema.optional(),
    minimumPriceMovement: ProbabilityPointDeltaStringSchema.optional(),
    maximumSpread: ProbabilityPointDeltaStringSchema.optional(),
    minimumBookDepth: NonNegativeDecimalStringSchema.optional(),
    bookDepthWithinPricePoints: ProbabilityPointDeltaStringSchema.optional(),
    minimumOpenInterest: NonNegativeDecimalStringSchema.optional(),
    minimumYesPrice: ProbabilityPointDeltaStringSchema.optional(),
    maximumYesPrice: ProbabilityPointDeltaStringSchema.optional(),
    yesPriceBasis: z.enum(["LAST_TRADE", "BOOK_MIDPOINT"]).optional(),
    maximumDataAgeSeconds: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [mode, field] of DISCOVERY_MODE_SELECTORS) {
      const selector = value[field];
      if (value.mode === mode) {
        if (selector !== undefined) continue;
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${mode} mode requires ${field}`,
        });
      } else if (selector !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is only valid in ${mode} mode`,
        });
      }
    }
    if (
      (value.minimumBookDepth === undefined) !==
      (value.bookDepthWithinPricePoints === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["bookDepthWithinPricePoints"],
        message:
          "minimumBookDepth and bookDepthWithinPricePoints must be supplied together",
      });
    }
    if (
      (value.minimumYesPrice !== undefined ||
        value.maximumYesPrice !== undefined) &&
      value.yesPriceBasis === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["yesPriceBasis"],
        message: "Price-band filters require yesPriceBasis",
      });
    }
    if (
      value.minimumYesPrice !== undefined &&
      value.maximumYesPrice !== undefined &&
      value.minimumYesPrice.gt(value.maximumYesPrice)
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumYesPrice"],
        message: "maximumYesPrice must not be less than minimumYesPrice",
      });
    }
    if (
      value.closesAfter !== undefined &&
      value.closesBefore !== undefined &&
      value.closesAfter >= value.closesBefore
    ) {
      context.addIssue({
        code: "custom",
        path: ["closesBefore"],
        message: "closesBefore must be later than closesAfter",
      });
    }
  });

const MarketFacetInputSchema = z
  .object({
    kind: z.enum(["ALL", "CATEGORY", "TAG", "EVENT", "SERIES"]).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).max(2_000).optional(),
    limit: z.number().int().positive().max(25).optional(),
  })
  .strict();

const MarketAnalysisInputSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    window: z.enum(["24_HOURS", "7_DAYS", "30_DAYS"]),
  })
  .strict();

const TradePreviewInputSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    quantity: PositiveDecimalStringSchema,
    limitPrice: StrictProbabilityStringSchema,
  })
  .strict();

const AgentNoteInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("LIST"),
      cursor: z.string().regex(/^\d+$/u).max(20).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("ADD"),
      content: z.string().trim().min(1).max(4_000),
      evidenceUrls: z.array(z.url()).max(10).default([]),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("UPDATE"),
      noteId: z.uuid(),
      content: z.string().trim().min(1).max(4_000),
      evidenceUrls: z.array(z.url()).max(10).default([]),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("DELETE"),
      noteId: z.uuid(),
    })
    .strict(),
]);

const AgentStateInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("LIST"),
      cursor: z.string().regex(/^\d+$/u).max(20).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("ADD_BELIEF"),
      type: z.enum([
        "EVENT_ANALYSIS",
        "MARKET_STRUCTURE",
        "MARKET_SENTIMENT",
        "RISK_ASSESSMENT",
        "TRADING_STRATEGY",
      ]),
      confidence: z.number().int().min(0).max(100),
      content: z.string().trim().min(1).max(4_000),
      marketSlugs: z.array(z.string().trim().min(1).max(300)).max(25),
      evidenceUpdatedAt: z.iso.datetime({ offset: true }),
      status: z.enum(["ACTIVE", "INVALIDATED", "SUPERSEDED"]).optional(),
      supersedesBeliefId: z.uuid().nullable().optional(),
      expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      reviewAt: z.iso.datetime({ offset: true }).nullable().optional(),
      invalidationConditions: z
        .array(z.string().trim().min(1).max(500))
        .max(10),
      evidenceUrls: z.array(z.url()).max(10).default([]),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("UPDATE_BELIEF"),
      beliefId: z.uuid(),
      type: z
        .enum([
          "EVENT_ANALYSIS",
          "MARKET_STRUCTURE",
          "MARKET_SENTIMENT",
          "RISK_ASSESSMENT",
          "TRADING_STRATEGY",
        ])
        .optional(),
      confidence: z.number().int().min(0).max(100).optional(),
      content: z.string().trim().min(1).max(4_000).optional(),
      marketSlugs: z
        .array(z.string().trim().min(1).max(300))
        .max(25)
        .optional(),
      evidenceUpdatedAt: z.iso.datetime({ offset: true }).optional(),
      status: z.enum(["ACTIVE", "INVALIDATED", "SUPERSEDED"]).optional(),
      supersedesBeliefId: z.uuid().nullable().optional(),
      expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      reviewAt: z.iso.datetime({ offset: true }).nullable().optional(),
      invalidationConditions: z
        .array(z.string().trim().min(1).max(500))
        .max(10)
        .optional(),
      evidenceUrls: z.array(z.url()).max(10).optional(),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("DELETE_BELIEF"), beliefId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("SET_NEXT_CYCLE_PLAN"),
      reviewAt: z.iso.datetime({ offset: true }).nullable().optional(),
      content: z.string().trim().min(1).max(8_000),
      marketSlugs: z.array(z.string().trim().min(1).max(300)).max(25),
      evidenceUrls: z.array(z.url()).max(10).default([]),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("SET_LONG_TERM_PLAN"),
      reviewAt: z.iso.datetime({ offset: true }).nullable().optional(),
      content: z.string().trim().min(1).max(8_000),
      marketSlugs: z.array(z.string().trim().min(1).max(300)).max(25),
      evidenceUrls: z.array(z.url()).max(10).default([]),
      basisMarketSlugs: z
        .array(z.string().trim().min(1).max(500))
        .max(25)
        .default([]),
    })
    .strict(),
  z.object({ action: z.literal("CLEAR_NEXT_CYCLE_PLAN") }).strict(),
]);

const WebSearchInputSchema = z
  .object({
    query: z.string().trim().min(2).max(500),
    marketSlug: z.string().trim().min(1).max(500).optional(),
    marketSlugs: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(30)
      .refine(
        (values) => new Set(values).size === values.length,
        "marketSlugs must be distinct",
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.marketSlug !== undefined && value.marketSlugs !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["marketSlugs"],
        message: "Supply marketSlug or marketSlugs, not both",
      });
    }
  });

const MarketDetailsInputSchema = z
  .object({ marketSlug: z.string().trim().min(1).max(500) })
  .strict();

const MarketFamilyDetailsInputSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    limit: z.number().int().positive().max(30).optional(),
  })
  .strict();

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Search result URLs must use HTTP or HTTPS");

const EvidenceSourceReadInputSchema = z
  .object({
    url: HttpUrlSchema,
    find: z.string().trim().min(1).max(200).nullable().optional(),
    marketSlug: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const WebSearchResultSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    url: HttpUrlSchema,
    snippet: z.string().trim().min(1).max(4000),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const PositionContextSchema = z
  .object({
    marketSlug: z.string(),
    side: z.enum(["YES", "NO"]),
    quantity: z.string(),
    availableQuantity: z.string(),
    costBasis: z.string(),
    costBasisFractionOfRiskEquity: z.string().optional(),
    realizedPnl: z.string(),
    exchangeCashValue: z.string().optional(),
    liquidationBid: z.string().optional(),
    conservativeValue: z.string().optional(),
    unrealizedPnl: z.string().optional(),
    expired: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const DetailedMarketContextSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    eventId: z.string().min(1).optional(),
    eventSlug: z.string().min(1).optional(),
    seriesId: z.string().min(1).optional(),
    seriesSlug: z.string().min(1).optional(),
    tags: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            slug: z.string().min(1),
            label: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    title: z.string(),
    description: z.string(),
    settlementRules: z.string(),
    resolutionSource: z.string().optional(),
    category: z.string(),
    subcategory: z.string().optional(),
    active: z.boolean(),
    closed: z.boolean(),
    archived: z.boolean(),
    closesAt: z.iso.datetime({ offset: true }).optional(),
    liquidityUsd: z.string().optional(),
    volumeUsd: z.string().optional(),
    volume24hUsd: z.string().optional(),
    volume7dUsd: z.string().optional(),
    volume30dUsd: z.string().optional(),
    lastPrice: z.string().optional(),
    sessionOpenYesPrice: z.string().optional(),
    sessionCurrentYesPrice: z.string().optional(),
    sessionLastYesPrice: z.string().optional(),
    sessionHighYesPrice: z.string().optional(),
    sessionLowYesPrice: z.string().optional(),
    sessionBookObservedAt: z.iso.datetime({ offset: true }).optional(),
    priceMovement: z.string().optional(),
    priceMovementWindow: z.enum(["24_HOURS", "TRADING_SESSION"]).optional(),
    priceMovementBasis: z
      .enum(["EXCHANGE_REPORTED_24H_CHANGE", "EXCHANGE_SESSION_BOOK_STATS"])
      .optional(),
    volatility: z.string().optional(),
    volatilityWindow: z.enum(["24_HOURS", "TRADING_SESSION"]).optional(),
    volatilityBasis: z
      .enum(["EXCHANGE_REPORTED_24H_CHANGE", "EXCHANGE_SESSION_BOOK_STATS"])
      .optional(),
    openInterest: z.string().optional(),
    minimumTradeQuantity: z.string(),
    priceTick: z.string(),
    yesBid: z.string().optional(),
    yesAsk: z.string().optional(),
    noBid: z.string().optional(),
    noAsk: z.string().optional(),
    spread: z.string().optional(),
    quoteObservedAt: z.iso.datetime({ offset: true }).optional(),
    quoteAvailable: z.boolean(),
    warnings: z.array(z.string()),
    held: z.boolean(),
    existingExposure: PositionContextSchema.optional(),
    officialLiveSnapshot: z.string().min(1).optional(),
    officialLiveSnapshotObservedAt: z.iso.datetime({ offset: true }).optional(),
    officialLivePositiveEdge: z.boolean().optional(),
  })
  .strict();

const NativeMarketFamilySchema = z
  .object({
    key: z.string().trim().min(1).max(500),
    kind: z.enum(["EVENT", "SERIES", "MARKET"]),
    value: z.string().trim().min(1).max(500),
    source: z.enum([
      "EVENT_ID",
      "EVENT_SLUG",
      "SERIES_ID",
      "SERIES_SLUG",
      "MARKET_SLUG",
    ]),
  })
  .strict();

const MarketFamilyDetailsResultSchema = z
  .object({
    family: NativeMarketFamilySchema,
    seedMarketSlug: z.string().trim().min(1).max(500),
    members: z.array(DetailedMarketContextSchema).min(1).max(30),
    discoveryBasis: z.enum([
      "EXCHANGE_GROUP",
      "CATALOG_METADATA",
      "EXCHANGE_GROUP_AND_CATALOG_METADATA",
      "SEED_ONLY",
    ]),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

export type MarketDiscoveryToolInput = z.output<
  typeof MarketDiscoveryInputSchema
>;
export type MarketFacetToolInput = z.output<typeof MarketFacetInputSchema>;
export type MarketFamilyDetailsToolInput = z.output<
  typeof MarketFamilyDetailsInputSchema
>;
export type MarketAnalysisToolInput = z.output<
  typeof MarketAnalysisInputSchema
>;
export type TradePreviewToolInput = z.output<typeof TradePreviewInputSchema>;
export type WebSearchResult = z.input<typeof WebSearchResultSchema>;
export type WebSearchHandler = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly WebSearchResult[]>;
export type EvidencePageReader = (
  url: string,
  signal: AbortSignal,
) => Promise<FetchedEvidencePage>;
export type MarketDiscoveryHandler = (
  request: MarketDiscoveryRequest,
  signal: AbortSignal,
) => Promise<MarketDiscoveryPage>;
export type MarketFacetHandler = (
  request: MarketFacetRequest,
  signal: AbortSignal,
) => Promise<MarketFacetPage>;
export type MarketDetailsHandler = (
  marketSlug: string,
  signal: AbortSignal,
) => Promise<DetailedMarketContext>;
export interface MarketFamilyDetailsResult {
  readonly family: NativeMarketFamily;
  readonly seedMarketSlug: string;
  readonly members: readonly DetailedMarketContext[];
  readonly discoveryBasis:
    | "EXCHANGE_GROUP"
    | "CATALOG_METADATA"
    | "EXCHANGE_GROUP_AND_CATALOG_METADATA"
    | "SEED_ONLY";
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
export type MarketFamilyDetailsHandler = (
  request: MarketFamilyDetailsToolInput,
  signal: AbortSignal,
) => Promise<MarketFamilyDetailsResult>;
export type MarketAnalysisHandler = (
  request: MarketAnalysisRequest,
  signal: AbortSignal,
) => Promise<MarketAnalysisResult>;
export type TradePreviewHandler = (
  request: AdvisoryTradePreviewRequest,
  signal: AbortSignal,
) => Promise<AdvisoryTradePreviewResult>;
export type AgentNotesHandler = (
  operation: AgentNoteOperation,
  signal: AbortSignal,
) => Promise<AgentNoteOperationResult>;
export type AgentStateHandler = (
  operation: AgentStateOperation,
  signal: AbortSignal,
) => Promise<AgentStateOperationResult>;

export type CandidateFamilySeed = MarketFamilySeed & {
  /** Conservative discovery-only equivalence class for research diversity. */
  readonly researchFamilyKey?: string;
};

function researchFamilyKey(candidate: CandidateFamilySeed): string {
  return candidate.researchFamilyKey ?? nativeMarketFamilyKey(candidate);
}

function preserveAdvisoryResearchFamily(
  existing: string | undefined,
  nativeFamily: string,
): string {
  return existing?.startsWith("scout:") === true ? existing : nativeFamily;
}

export interface PassResearchRequirements {
  readonly minimumDiscoveryRequests: number;
  readonly minimumDistinctDiscoveryModes: number;
  readonly minimumInspectedMarkets: number;
  readonly minimumDistinctEventFamilies: number;
  readonly minimumWebSearches: number;
  readonly minimumMarketAnalyses: number;
  readonly minimumTradePreviews: number;
  readonly maximumQualifiedSpread: Decimal;
}

export type PassResearchGateStatus =
  | "DISABLED"
  | "NOT_APPLICABLE"
  | "REQUIRED"
  | "SATISFIED"
  | "NO_CANDIDATES"
  | "NO_QUALIFIED_CANDIDATES"
  | "WAIVED_FINAL_ROUND"
  | "WAIVED_PROVIDER_BYPASS";

export interface PassResearchReadiness {
  readonly allowed: boolean;
  readonly status: PassResearchGateStatus;
  readonly unmet: readonly string[];
  readonly successfulDiscoveryRequests: number;
  readonly distinctDiscoveryModes: number;
  readonly inspectedMarkets: number;
  readonly availableDistinctEventFamilies: number;
  readonly requiredDistinctEventFamilies: number;
  readonly inspectedDistinctEventFamilies: number;
  readonly qualifiedCandidates: number;
  readonly webSearches: number;
  readonly qualifiedMarketAnalyses: number;
  readonly qualifiedTradePreviews: number;
  readonly qualifiedCandidateReviews: number;
  readonly qualifiedNonHeldCandidateReviews: number;
  readonly requiredPriorityEvidenceMarketSlugs: readonly string[];
  readonly priorityEvidenceAttemptedMarketSlugs: readonly string[];
  readonly priorityEvidenceAttemptCounts: Readonly<Record<string, number>>;
}

export interface DecisionResearchToolsOptions {
  readonly marketDetails?: readonly DetailedMarketContext[];
  readonly listMarketFacets?: MarketFacetHandler;
  readonly discoverMarkets?: MarketDiscoveryHandler;
  readonly marketDetailsHandler?: MarketDetailsHandler;
  readonly marketFamilyDetailsHandler?: MarketFamilyDetailsHandler;
  readonly marketAnalysisHandler?: MarketAnalysisHandler;
  readonly tradePreviewHandler?: TradePreviewHandler;
  readonly agentNotesHandler?: AgentNotesHandler;
  readonly agentStateHandler?: AgentStateHandler;
  readonly candidateFamilies?: readonly CandidateFamilySeed[];
  /** Discovery-only aliases for catalog siblings not present on the board. */
  readonly researchFamilyAliases?: ReadonlyMap<string, string>;
  /** Strategy-selected candidates that require inspection and source-linked follow-through. */
  readonly requiredPriorityEvidenceMarketSlugs?: readonly string[];
  readonly requiredResearchGate?: SelectionPolicy["shouldEnforceRequiredResearch"];
  readonly passResearchRequirements?: PassResearchRequirements;
  readonly prompts: PromptBundle["research"];
  readonly webSearch?: WebSearchHandler;
  readonly evidencePageReader?: EvidencePageReader;
  readonly forecastPolicy?: ForecastPolicy;
  readonly maximumResultsPerSearch?: number;
}

export function relatedPriorityEvidenceAttributionSlugs(input: {
  readonly attributedMarketSlug: string;
  readonly researchFamilyBySlug: ReadonlyMap<string, string>;
  readonly requiredPriorityMarketSlugs: ReadonlySet<string>;
}): readonly string[] {
  const slugs = new Set([input.attributedMarketSlug]);
  const family = input.researchFamilyBySlug.get(input.attributedMarketSlug);
  if (family === undefined) return [...slugs];
  for (const requiredSlug of input.requiredPriorityMarketSlugs) {
    if (input.researchFamilyBySlug.get(requiredSlug) === family) {
      slugs.add(requiredSlug);
    }
  }
  return [...slugs];
}

export interface ResearchToolCounts {
  readonly marketDiscoveryRequests: number;
  readonly webSearches: number;
  readonly evidenceSourceReads: number;
  readonly successfulEvidenceSourceReads: number;
  readonly marketDetailRequests: number;
  readonly marketAnalysisRequests: number;
  readonly tradePreviews: number;
  readonly noteOperations: number;
  readonly stateOperations: number;
}

export interface MarketDiscoveryAuditEntry {
  readonly request: MarketDiscoveryRequest;
  readonly returnedSlugs: readonly string[];
  readonly matchedCount: number;
  readonly nextCursor?: string;
  readonly eof: boolean;
  readonly unavailableMetrics: readonly string[];
  readonly rankingBasis: string;
  readonly metricCoverage?: MarketDiscoveryPage["metricCoverage"];
  readonly appliedFilters?: MarketDiscoveryPage["appliedFilters"];
}

export type ToolExecutionResult =
  | {
      readonly kind: "TOOL_RESULT";
      readonly content: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "DECISION";
      readonly decision: AgentDecision;
    };

export class ResearchToolLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResearchToolLimitError";
  }
}

function discoverMarketsInputJsonSchema(
  prompts: ResearchToolPrompts["discover_markets"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: {
        type: "string",
        enum: DISCOVERY_MODES,
        description: prompts.mode,
      },
      query: { type: "string", maxLength: 300, description: prompts.query },
      category: {
        type: "string",
        maxLength: 200,
        description: prompts.category,
      },
      tag: { type: "string", maxLength: 200, description: prompts.tag },
      event: { type: "string", maxLength: 500, description: prompts.event },
      series: {
        type: "string",
        maxLength: 500,
        description: prompts.series,
      },
      cursor: {
        type: "string",
        pattern: "^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$",
        description: prompts.cursor,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: prompts.limit,
      },
      closesAfter: {
        type: "string",
        format: "date-time",
        description: prompts.closesAfter,
      },
      closesBefore: {
        type: "string",
        format: "date-time",
        description: prompts.closesBefore,
      },
      minimumLiquidityUsd: {
        type: "string",
        description: prompts.minimumLiquidityUsd,
      },
      minimumVolumeUsd: {
        type: "string",
        description: prompts.minimumVolumeUsd,
      },
      minimumPriceMovement: {
        type: "string",
        description: prompts.minimumPriceMovement,
      },
      maximumSpread: {
        type: "string",
        description: prompts.maximumSpread,
      },
      minimumBookDepth: {
        type: "string",
        description: prompts.minimumBookDepth,
      },
      bookDepthWithinPricePoints: {
        type: "string",
        description: prompts.bookDepthWithinPricePoints,
      },
      minimumOpenInterest: {
        type: "string",
        description: prompts.minimumOpenInterest,
      },
      minimumYesPrice: {
        type: "string",
        description: prompts.minimumYesPrice,
      },
      maximumYesPrice: {
        type: "string",
        description: prompts.maximumYesPrice,
      },
      yesPriceBasis: {
        type: "string",
        enum: ["LAST_TRADE", "BOOK_MIDPOINT"],
        description: prompts.yesPriceBasis,
      },
      maximumDataAgeSeconds: {
        type: "integer",
        minimum: 0,
        description: prompts.maximumDataAgeSeconds,
      },
    },
    required: ["mode"],
  } as const;
}

function marketFacetsInputJsonSchema(
  prompts: ResearchToolPrompts["list_market_facets"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: ["ALL", "CATEGORY", "TAG", "EVENT", "SERIES"],
        description: prompts.kind,
      },
      query: { type: "string", maxLength: 200, description: prompts.query },
      cursor: {
        type: "string",
        pattern: "^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$",
        description: prompts.cursor,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: prompts.limit,
      },
    },
  } as const;
}

function marketAnalysisInputJsonSchema(
  prompts: ResearchToolPrompts["get_market_analysis"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: prompts.marketSlug,
      },
      window: {
        type: "string",
        enum: ["24_HOURS", "7_DAYS", "30_DAYS"],
        description: prompts.window,
      },
    },
    required: ["marketSlug", "window"],
  } as const;
}

function tradePreviewInputJsonSchema(
  prompts: ResearchToolPrompts["preview_trade"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: prompts.marketSlug,
      },
      side: {
        type: "string",
        enum: ["YES", "NO"],
        description: prompts.side,
      },
      action: {
        type: "string",
        enum: ["BUY", "SELL"],
        description: prompts.action,
      },
      quantity: { type: "string", description: prompts.quantity },
      limitPrice: { type: "string", description: prompts.limitPrice },
    },
    required: ["marketSlug", "side", "action", "quantity", "limitPrice"],
  } as const;
}

function agentNotesInputJsonSchema(
  prompts: ResearchToolPrompts["manage_notes"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["LIST", "ADD", "UPDATE", "DELETE"],
        description: prompts.action,
      },
      noteId: {
        type: "string",
        format: "uuid",
        description: prompts.noteId,
      },
      content: {
        type: "string",
        minLength: 1,
        maxLength: 4_000,
        description: prompts.content,
      },
      cursor: {
        type: "string",
        description: prompts.cursor,
      },
      evidenceUrls: {
        type: "array",
        maxItems: 10,
        items: { type: "string", format: "uri" },
        description: prompts.evidenceUrls,
      },
      basisMarketSlugs: {
        type: "array",
        maxItems: 25,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: prompts.basisMarketSlugs,
      },
    },
    required: ["action"],
  } as const;
}

function agentStateInputJsonSchema(
  prompts: ResearchToolPrompts["manage_state"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "LIST",
          "ADD_BELIEF",
          "UPDATE_BELIEF",
          "DELETE_BELIEF",
          "SET_NEXT_CYCLE_PLAN",
          "SET_LONG_TERM_PLAN",
          "CLEAR_NEXT_CYCLE_PLAN",
        ],
        description: prompts.action,
      },
      beliefId: {
        type: "string",
        format: "uuid",
        description: prompts.beliefId,
      },
      type: {
        type: "string",
        enum: [
          "EVENT_ANALYSIS",
          "MARKET_STRUCTURE",
          "MARKET_SENTIMENT",
          "RISK_ASSESSMENT",
          "TRADING_STRATEGY",
        ],
        description: prompts.type,
      },
      confidence: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: prompts.confidence,
      },
      content: {
        type: "string",
        minLength: 1,
        maxLength: 8_000,
        description: prompts.content,
      },
      marketSlugs: {
        type: "array",
        maxItems: 25,
        items: { type: "string", minLength: 1, maxLength: 300 },
        description: prompts.marketSlugs,
      },
      evidenceUpdatedAt: {
        type: "string",
        format: "date-time",
        description: prompts.evidenceUpdatedAt,
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "INVALIDATED", "SUPERSEDED"],
        description:
          prompts.status ??
          "Belief lifecycle status; omitted updates preserve the existing status.",
      },
      supersedesBeliefId: {
        type: ["string", "null"],
        format: "uuid",
        description:
          prompts.supersedesBeliefId ??
          "Earlier belief replaced by this belief; null clears the relation.",
      },
      expiresAt: {
        type: ["string", "null"],
        format: "date-time",
        description:
          prompts.expiresAt ??
          "When this belief stops being current; null clears expiry.",
      },
      reviewAt: {
        type: ["string", "null"],
        format: "date-time",
        description:
          prompts.reviewAt ??
          "Scheduled review time for a belief or plan; null clears the review time.",
      },
      invalidationConditions: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: prompts.invalidationConditions,
      },
      cursor: { type: "string", description: prompts.cursor },
      evidenceUrls: {
        type: "array",
        maxItems: 10,
        items: { type: "string", format: "uri" },
        description: prompts.evidenceUrls,
      },
      basisMarketSlugs: {
        type: "array",
        maxItems: 25,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: prompts.basisMarketSlugs,
      },
    },
    required: ["action"],
  } as const;
}

function webSearchInputJsonSchema(
  prompts: ResearchToolPrompts["web_search"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 2,
        maxLength: 500,
        description: prompts.query,
      },
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: prompts.marketSlug,
      },
      marketSlugs: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: prompts.marketSlugs,
      },
    },
    required: ["query"],
  } as const;
}

function evidenceSourceReadInputJsonSchema(
  prompts: ResearchToolPrompts["read_evidence_source"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        format: "uri",
        description: prompts.url,
      },
      find: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: 200,
        description: prompts.find,
      },
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: prompts.marketSlug,
      },
    },
    required: ["url", "find"],
  } as const;
}

function marketDetailsInputJsonSchema(description: string) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description,
      },
    },
    required: ["marketSlug"],
  } as const;
}

function marketFamilyDetailsInputJsonSchema(
  prompts: ResearchToolPrompts["get_market_family_details"]["arguments"],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      marketSlug: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: prompts.marketSlug,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        description: prompts.limit,
      },
    },
    required: ["marketSlug"],
  } as const;
}

function buildDecisionToolDefinitions(
  prompts: ResearchToolPrompts,
): readonly DecisionToolDefinition[] {
  return Object.freeze([
    {
      name: "list_market_facets",
      description: prompts.list_market_facets.description,
      inputSchema: marketFacetsInputJsonSchema(
        prompts.list_market_facets.arguments,
      ),
      terminal: false,
    },
    {
      name: "discover_markets",
      description: prompts.discover_markets.description,
      inputSchema: discoverMarketsInputJsonSchema(
        prompts.discover_markets.arguments,
      ),
      terminal: false,
    },
    {
      name: "web_search",
      description: prompts.web_search.description,
      inputSchema: webSearchInputJsonSchema(prompts.web_search.arguments),
      terminal: false,
    },
    {
      name: "read_evidence_source",
      description: prompts.read_evidence_source.description,
      inputSchema: evidenceSourceReadInputJsonSchema(
        prompts.read_evidence_source.arguments,
      ),
      terminal: false,
    },
    {
      name: "get_market_details",
      description: prompts.get_market_details.description,
      inputSchema: marketDetailsInputJsonSchema(
        prompts.get_market_details.arguments.marketSlug,
      ),
      terminal: false,
    },
    {
      name: "get_market_family_details",
      description: prompts.get_market_family_details.description,
      inputSchema: marketFamilyDetailsInputJsonSchema(
        prompts.get_market_family_details.arguments,
      ),
      terminal: false,
    },
    {
      name: "get_market_analysis",
      description: prompts.get_market_analysis.description,
      inputSchema: marketAnalysisInputJsonSchema(
        prompts.get_market_analysis.arguments,
      ),
      terminal: false,
    },
    {
      name: "preview_trade",
      description: prompts.preview_trade.description,
      inputSchema: tradePreviewInputJsonSchema(prompts.preview_trade.arguments),
      terminal: false,
    },
    {
      name: "manage_notes",
      description: prompts.manage_notes.description,
      inputSchema: agentNotesInputJsonSchema(prompts.manage_notes.arguments),
      terminal: false,
    },
    {
      name: "manage_state",
      description: prompts.manage_state.description,
      inputSchema: agentStateInputJsonSchema(prompts.manage_state.arguments),
      terminal: false,
    },
    {
      name: "submit_trade_plan",
      description: prompts.submit_trade_plan.description,
      inputSchema: AgentDecisionModelJsonSchema,
      terminal: true,
    },
  ]);
}

function safeToolError(
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): ToolExecutionResult {
  return {
    kind: "TOOL_RESULT",
    content: JSON.stringify({ ok: false, code, message, ...metadata }),
    isError: true,
  };
}

const MAXIMUM_DECISION_INPUT_ISSUES = 20;

function decisionInputValidationIssues(
  error: z.ZodError,
): readonly Readonly<{ path: string; message: string }>[] {
  return error.issues.slice(0, MAXIMUM_DECISION_INPUT_ISSUES).map((issue) => ({
    path:
      issue.path.length === 0
        ? "$"
        : issue.path.reduce<string>((path, segment) => {
            if (typeof segment === "number") return `${path}[${segment}]`;
            return path.length === 0
              ? String(segment)
              : `${path}.${String(segment)}`;
          }, ""),
    message: issue.message.slice(0, 1_000),
  }));
}

const PROTECTED_CURSOR_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;
const MAXIMUM_RAW_CURSOR_LENGTH = 1_000;

class InvalidProtectedCursorError extends Error {
  public constructor() {
    super("Invalid protected discovery cursor");
    this.name = "InvalidProtectedCursorError";
  }
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Decimal.isDecimal(value)) return value.toString();
  if (typeof value === "string") {
    return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  }
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, item]) => [key, canonicalizeFingerprintValue(item)]),
    );
  }
  return value;
}

function requestFingerprint(scope: string, value: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(JSON.stringify(canonicalizeFingerprintValue(value)))
    .digest("hex");
}

function cursorSignature(
  secret: Buffer,
  scope: string,
  fingerprint: string,
  encodedCursor: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(scope)
    .update("\0")
    .update(fingerprint)
    .update("\0")
    .update(encodedCursor)
    .digest();
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function protectCursor(
  secret: Buffer,
  scope: string,
  fingerprint: string,
  rawCursor: string,
): string {
  if (
    rawCursor.length === 0 ||
    rawCursor.length > MAXIMUM_RAW_CURSOR_LENGTH ||
    containsControlCharacter(rawCursor)
  ) {
    throw new InvalidProtectedCursorError();
  }
  const encodedCursor = Buffer.from(rawCursor, "utf8").toString("base64url");
  const signature = cursorSignature(
    secret,
    scope,
    fingerprint,
    encodedCursor,
  ).toString("base64url");
  return `v1.${encodedCursor}.${signature}`;
}

function unprotectCursor(
  secret: Buffer,
  scope: string,
  fingerprint: string,
  protectedCursor: string,
): string {
  const match = PROTECTED_CURSOR_PATTERN.exec(protectedCursor);
  if (match === null) throw new InvalidProtectedCursorError();
  const encodedCursor = match[1];
  const encodedSignature = match[2];
  if (encodedCursor === undefined || encodedSignature === undefined) {
    throw new InvalidProtectedCursorError();
  }
  const expected = cursorSignature(secret, scope, fingerprint, encodedCursor);
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvalidProtectedCursorError();
  }
  const rawCursor = Buffer.from(encodedCursor, "base64url").toString("utf8");
  if (
    rawCursor.length === 0 ||
    rawCursor.length > MAXIMUM_RAW_CURSOR_LENGTH ||
    Buffer.from(rawCursor, "utf8").toString("base64url") !== encodedCursor ||
    containsControlCharacter(rawCursor)
  ) {
    throw new InvalidProtectedCursorError();
  }
  return rawCursor;
}

function sanitizeExternalText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
      ? " "
      : character;
  }).join("");
}

// Attribution is present once an observed host is linked to the required market.
// Entry authorization independently enforces configured evidence requirements.
const MINIMUM_PRIORITY_EVIDENCE_ATTEMPT_DOMAINS = 1;
const MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS = 24_000;
const EVIDENCE_SOURCE_NO_MATCH_PREVIEW_CHARACTERS = 4_000;
const EVIDENCE_SOURCE_MATCH_CONTEXT_CHARACTERS = 900;
const MAXIMUM_EVIDENCE_SOURCE_MATCH_FRAGMENTS = 8;
const EVIDENCE_SOURCE_TERM_WINDOW_CHARACTERS = 2_400;
const EVIDENCE_SOURCE_TERM_WINDOW_STRIDE = 1_200;
const MAXIMUM_EVIDENCE_SOURCE_TERM_FRAGMENTS = 4;
const EVIDENCE_SOURCE_QUERY_STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

interface EvidenceSourceTextSelection {
  readonly text: string;
  readonly sourceCharacters: number;
  readonly matchCount: number | null;
  readonly returnedFragments: number;
  readonly truncated: boolean;
  readonly selectionMode:
    "PREFIX" | "EXACT_PHRASE" | "QUERY_TERMS" | "NO_MATCH_PREFIX";
  readonly matchedTerms: readonly string[];
}

function evidenceQueryTerms(value: string): readonly string[] {
  return [
    ...new Set(
      (value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) =>
          term.length >= 2 && !EVIDENCE_SOURCE_QUERY_STOP_TERMS.has(term),
      ),
    ),
  ].slice(0, 24);
}

function countTextOccurrences(value: string, term: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const match = value.indexOf(term, offset);
    if (match < 0) return count;
    count += 1;
    offset = match + term.length;
  }
}

function selectQueryTermRanges(
  source: string,
  normalizedSource: string,
  queryTerms: readonly string[],
): {
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly matchedTerms: readonly string[];
} {
  if (queryTerms.length === 0 || source.length === 0) {
    return { ranges: [], matchedTerms: [] };
  }
  const minimumMatchedTerms = queryTerms.length === 1 ? 1 : 2;
  const candidates: {
    readonly start: number;
    readonly end: number;
    readonly score: number;
    readonly matchedTerms: readonly string[];
  }[] = [];
  for (
    let start = 0;
    start < source.length;
    start += EVIDENCE_SOURCE_TERM_WINDOW_STRIDE
  ) {
    const end = Math.min(
      source.length,
      start + EVIDENCE_SOURCE_TERM_WINDOW_CHARACTERS,
    );
    const window = normalizedSource.slice(start, end);
    const matchedTerms = queryTerms.filter((term) => window.includes(term));
    if (matchedTerms.length < minimumMatchedTerms) continue;
    const occurrenceScore = matchedTerms.reduce(
      (sum, term) => sum + Math.min(20, countTextOccurrences(window, term)),
      0,
    );
    candidates.push({
      start,
      end,
      score: matchedTerms.length * 1_000 + occurrenceScore,
      matchedTerms,
    });
  }
  candidates.sort(
    (left, right) => right.score - left.score || left.start - right.start,
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (
      selected.some(
        (existing) =>
          candidate.start < existing.end && candidate.end > existing.start,
      )
    ) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= MAXIMUM_EVIDENCE_SOURCE_TERM_FRAGMENTS) break;
  }
  selected.sort((left, right) => left.start - right.start);
  return {
    ranges: selected.map(({ start, end }) => ({ start, end })),
    matchedTerms: [
      ...new Set(selected.flatMap((candidate) => candidate.matchedTerms)),
    ],
  };
}

function selectEvidenceSourceText(
  rawText: string,
  find: string | null | undefined,
): EvidenceSourceTextSelection {
  const source = sanitizeExternalText(rawText).trim();
  if (find === null || find === undefined) {
    return {
      text: source.slice(0, MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS),
      sourceCharacters: source.length,
      matchCount: null,
      returnedFragments: source.length === 0 ? 0 : 1,
      truncated: source.length > MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS,
      selectionMode: "PREFIX",
      matchedTerms: [],
    };
  }

  const normalizedSource = source.toLocaleLowerCase("en-US");
  const normalizedNeedle = find.toLocaleLowerCase("en-US");
  const ranges: { start: number; end: number }[] = [];
  let matchCount = 0;
  let offset = 0;
  let omittedRange = false;
  for (;;) {
    const match = normalizedSource.indexOf(normalizedNeedle, offset);
    if (match < 0) break;
    matchCount += 1;
    const start = Math.max(0, match - EVIDENCE_SOURCE_MATCH_CONTEXT_CHARACTERS);
    const end = Math.min(
      source.length,
      match +
        normalizedNeedle.length +
        EVIDENCE_SOURCE_MATCH_CONTEXT_CHARACTERS,
    );
    const lastRange = ranges.at(-1);
    if (lastRange !== undefined && start <= lastRange.end) {
      lastRange.end = Math.max(lastRange.end, end);
    } else if (ranges.length < MAXIMUM_EVIDENCE_SOURCE_MATCH_FRAGMENTS) {
      ranges.push({ start, end });
    } else {
      omittedRange = true;
    }
    offset = match + normalizedNeedle.length;
  }

  if (ranges.length === 0) {
    const termSelection = selectQueryTermRanges(
      source,
      normalizedSource,
      evidenceQueryTerms(find),
    );
    if (termSelection.ranges.length > 0) {
      const fragments = termSelection.ranges.map(({ start, end }) =>
        source.slice(start, end),
      );
      const selected = fragments.join("\n...\n");
      return {
        text: selected.slice(0, MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS),
        sourceCharacters: source.length,
        matchCount: 0,
        returnedFragments: fragments.length,
        truncated:
          selected.length > MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS ||
          selected.length < source.length,
        selectionMode: "QUERY_TERMS",
        matchedTerms: termSelection.matchedTerms,
      };
    }
    return {
      text: source.slice(0, EVIDENCE_SOURCE_NO_MATCH_PREVIEW_CHARACTERS),
      sourceCharacters: source.length,
      matchCount: 0,
      returnedFragments: 0,
      truncated: source.length > EVIDENCE_SOURCE_NO_MATCH_PREVIEW_CHARACTERS,
      selectionMode: "NO_MATCH_PREFIX",
      matchedTerms: [],
    };
  }
  const fragments = ranges.map(({ start, end }) => source.slice(start, end));
  const selected = fragments.join("\n...\n");
  return {
    text: selected.slice(0, MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS),
    sourceCharacters: source.length,
    matchCount,
    returnedFragments: fragments.length,
    truncated:
      omittedRange ||
      selected.length > MAXIMUM_EVIDENCE_SOURCE_OUTPUT_CHARACTERS,
    selectionMode: "EXACT_PHRASE",
    matchedTerms: evidenceQueryTerms(find),
  };
}

function catalogRowFamilySeed(row: MarketCatalogRow): CandidateFamilySeed {
  return {
    marketSlug: row.slug,
    ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
    ...(row.eventSlug === undefined ? {} : { eventSlug: row.eventSlug }),
    ...(row.seriesId === undefined ? {} : { seriesId: row.seriesId }),
    ...(row.seriesSlug === undefined ? {} : { seriesSlug: row.seriesSlug }),
  };
}

function detailedMarketFamilySeed(
  details: DetailedMarketContext,
): CandidateFamilySeed {
  return {
    marketSlug: details.slug,
    ...(details.eventId === undefined ? {} : { eventId: details.eventId }),
    ...(details.eventSlug === undefined
      ? {}
      : { eventSlug: details.eventSlug }),
    ...(details.seriesId === undefined ? {} : { seriesId: details.seriesId }),
    ...(details.seriesSlug === undefined
      ? {}
      : { seriesSlug: details.seriesSlug }),
  };
}

function mechanicallyQualifiedMarket(
  details: DetailedMarketContext,
  maximumSpread: Decimal,
): boolean {
  if (
    !details.active ||
    details.closed ||
    details.archived ||
    !details.quoteAvailable ||
    details.settlementRules.trim().length === 0 ||
    details.yesBid === undefined ||
    details.yesAsk === undefined
  ) {
    return false;
  }
  try {
    const bid = new Decimal(details.yesBid);
    const ask = new Decimal(details.yesAsk);
    return (
      bid.isFinite() &&
      ask.isFinite() &&
      bid.gte(0) &&
      ask.lte(1) &&
      ask.gte(bid) &&
      ask.minus(bid).lte(maximumSpread)
    );
  } catch {
    return false;
  }
}

export interface SystemLiveEvidenceSource {
  readonly title: string;
  readonly url: string;
  readonly findHint: string;
  readonly preview?: string;
}

export interface LiveEvidenceLinePreview {
  /** Only observed source text is registered as evidence. */
  readonly evidenceExcerpt: string;
  /** May additionally include explicitly labelled policy-derived estimates. */
  readonly preview: string;
  /** Optional derived estimate; never registered as observed evidence. */
  readonly forecastYesProbability?: Decimal;
}

export interface ForecastProbabilityRequest {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
}

export interface FreshForecastProbabilities {
  /** Required markets with no returned probability must fail validation. */
  readonly requiredMarketSlugs: ReadonlySet<string>;
  readonly selectedSideProbabilityByMarketSlug: ReadonlyMap<string, Decimal>;
}

/** Source selection and probability policy are supplied by the deployment. */
export interface ForecastPolicy {
  readonly forecastTolerance: Decimal;
  systemLiveEvidenceSources(
    details: DetailedMarketContext,
    now?: Date,
  ): readonly SystemLiveEvidenceSource[];
  liveEvidenceLinePreview(
    rawText: string,
    findHint: string,
    sessionOpenYesPrice?: string,
    details?: DetailedMarketContext,
  ): LiveEvidenceLinePreview | undefined;
  refreshForecasts(
    requests: readonly ForecastProbabilityRequest[],
    detailsBySlug: ReadonlyMap<string, DetailedMarketContext>,
    observedAt: Date,
    signal: AbortSignal,
  ): Promise<FreshForecastProbabilities>;
}

/** Engine-owned dependencies injected into external policy factories. */
export const forecastPolicyApi = Object.freeze({
  Decimal,
  fetchEvidencePage,
  evidenceQueryTerms,
  sanitizeExternalText,
  tableTennisSetComplete,
  tableTennisSetWinProbability,
  firstToThreeMatchWinProbability,
  inverseMonotonicProbability,
});

function validatedPassResearchRequirements(
  requirements: PassResearchRequirements | undefined,
): PassResearchRequirements | undefined {
  if (requirements === undefined) return undefined;
  const integerFields = [
    "minimumDiscoveryRequests",
    "minimumDistinctDiscoveryModes",
    "minimumInspectedMarkets",
    "minimumDistinctEventFamilies",
    "minimumWebSearches",
    "minimumMarketAnalyses",
    "minimumTradePreviews",
  ] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(requirements[field]) || requirements[field] < 0) {
      throw new RangeError(`${field} must be a non-negative safe integer`);
    }
  }
  if (
    !requirements.maximumQualifiedSpread.isFinite() ||
    requirements.maximumQualifiedSpread.lt(0) ||
    requirements.maximumQualifiedSpread.gt(1)
  ) {
    throw new RangeError(
      "maximumQualifiedSpread must be a finite decimal from zero through one",
    );
  }
  return requirements;
}

export class DecisionResearchTools {
  private readonly initialDetailsBySlug: ReadonlyMap<
    string,
    DetailedMarketContext
  >;
  private readonly definitions: readonly DecisionToolDefinition[];
  private readonly messages: ResearchToolMessages;
  private readonly listMarketFacets: MarketFacetHandler | undefined;
  private readonly discoverMarkets: MarketDiscoveryHandler | undefined;
  private readonly marketDetailsHandler: MarketDetailsHandler | undefined;
  private readonly marketFamilyDetailsHandler:
    MarketFamilyDetailsHandler | undefined;
  private readonly marketAnalysisHandler: MarketAnalysisHandler | undefined;
  private readonly tradePreviewHandler: TradePreviewHandler | undefined;
  private readonly agentNotesHandler: AgentNotesHandler | undefined;
  private readonly agentStateHandler: AgentStateHandler | undefined;
  private readonly candidateFamilies: readonly CandidateFamilySeed[];
  private readonly researchFamilyAliases: ReadonlyMap<string, string>;
  private readonly requiredPriorityEvidenceMarketSlugs: ReadonlySet<string>;
  private readonly passResearchRequirements:
    PassResearchRequirements | undefined;
  private readonly webSearch: WebSearchHandler | undefined;
  private readonly evidencePageReader: EvidencePageReader;
  private readonly forecastPolicy: ForecastPolicy | undefined;
  private readonly requiredResearchGate: SelectionPolicy["shouldEnforceRequiredResearch"];
  private readonly maximumResultsPerSearch: number;
  private totalMarketDiscoveryRequestCount = 0;
  private totalWebSearchCount = 0;
  private totalMarketDetailRequestCount = 0;
  private totalMarketAnalysisRequestCount = 0;
  private totalTradePreviewCount = 0;
  private totalNoteOperationCount = 0;
  private totalStateOperationCount = 0;
  private activeMaximumMarketDiscoveryRequests: number | undefined;
  private activeMaximumWebSearchRequests: number | undefined;
  private activeMaximumTradePreviewRequests: number | undefined;
  private activeSession: DecisionResearchSession | undefined;
  private providerDecisionReturned = false;
  private readonly surfacedSlugs = new Set<string>();
  private readonly inspectedSlugs = new Set<string>();
  private readonly researchedSlugs = new Set<string>();
  private readonly previewedSlugs = new Set<string>();
  private readonly qualifiedSlugs = new Set<string>();
  private readonly discoveryAudit: MarketDiscoveryAuditEntry[] = [];
  private readonly evidenceSources = new EvidenceSourceRegistry();

  public constructor(options: DecisionResearchToolsOptions) {
    const maximumResultsPerSearch = options.maximumResultsPerSearch ?? 8;
    if (
      !Number.isInteger(maximumResultsPerSearch) ||
      maximumResultsPerSearch <= 0 ||
      maximumResultsPerSearch > 20
    ) {
      throw new RangeError(
        "maximumResultsPerSearch must be an integer from 1 to 20",
      );
    }

    const details = new Map<string, DetailedMarketContext>();
    for (const item of options.marketDetails ?? []) {
      const parsed = DetailedMarketContextSchema.parse(
        item,
      ) as DetailedMarketContext;
      if (details.has(parsed.slug)) {
        throw new Error(`Duplicate market details for ${parsed.slug}`);
      }
      details.set(parsed.slug, parsed);
    }
    this.initialDetailsBySlug = details;
    this.definitions = buildDecisionToolDefinitions(options.prompts.tools);
    this.messages = options.prompts.messages;
    this.listMarketFacets = options.listMarketFacets;
    this.discoverMarkets = options.discoverMarkets;
    this.marketDetailsHandler = options.marketDetailsHandler;
    this.marketFamilyDetailsHandler = options.marketFamilyDetailsHandler;
    this.marketAnalysisHandler = options.marketAnalysisHandler;
    this.tradePreviewHandler = options.tradePreviewHandler;
    this.agentNotesHandler = options.agentNotesHandler;
    this.agentStateHandler = options.agentStateHandler;
    this.candidateFamilies = Object.freeze([
      ...(options.candidateFamilies ?? []),
    ]);
    const researchFamilyAliases = new Map<string, string>();
    for (const [marketSlug, familyKey] of options.researchFamilyAliases ?? []) {
      if (marketSlug.trim().length === 0 || !familyKey.startsWith("scout:")) {
        throw new TypeError(
          "Research-family aliases require a market slug and a scout: key",
        );
      }
      researchFamilyAliases.set(marketSlug, familyKey);
    }
    this.researchFamilyAliases = researchFamilyAliases;
    const requiredPriorityEvidenceMarketSlugs = new Set<string>();
    for (const marketSlug of options.requiredPriorityEvidenceMarketSlugs ??
      []) {
      const normalized = marketSlug.trim();
      if (normalized.length === 0) {
        throw new TypeError(
          "Required priority-evidence market slugs must not be empty",
        );
      }
      requiredPriorityEvidenceMarketSlugs.add(normalized);
    }
    this.requiredPriorityEvidenceMarketSlugs =
      requiredPriorityEvidenceMarketSlugs;
    this.passResearchRequirements = validatedPassResearchRequirements(
      options.passResearchRequirements,
    );
    this.webSearch = options.webSearch;
    this.forecastPolicy = options.forecastPolicy;
    this.requiredResearchGate = options.requiredResearchGate;
    this.evidencePageReader =
      options.evidencePageReader ??
      ((url, signal) => fetchEvidencePage(url, { signal }));
    this.maximumResultsPerSearch = maximumResultsPerSearch;
  }

  public get hasClientWebSearchHandler(): boolean {
    return this.webSearch !== undefined;
  }

  public get totalCounts(): ResearchToolCounts {
    return {
      marketDiscoveryRequests: this.totalMarketDiscoveryRequestCount,
      webSearches: this.totalWebSearchCount,
      evidenceSourceReads: this.activeSession?.counts.evidenceSourceReads ?? 0,
      successfulEvidenceSourceReads:
        this.activeSession?.counts.successfulEvidenceSourceReads ?? 0,
      marketDetailRequests: this.totalMarketDetailRequestCount,
      marketAnalysisRequests: this.totalMarketAnalysisRequestCount,
      tradePreviews: this.totalTradePreviewCount,
      noteOperations: this.totalNoteOperationCount,
      stateOperations: this.totalStateOperationCount,
    };
  }

  public get surfacedMarketSlugs(): ReadonlySet<string> {
    return this.surfacedSlugs;
  }

  public get inspectedMarketSlugs(): ReadonlySet<string> {
    return this.inspectedSlugs;
  }

  public get researchedMarketSlugs(): ReadonlySet<string> {
    return this.researchedSlugs;
  }

  public get previewedMarketSlugs(): ReadonlySet<string> {
    return this.previewedSlugs;
  }

  public get qualifiedMarketSlugs(): ReadonlySet<string> {
    return this.qualifiedSlugs;
  }

  public get seriouslyEvaluatedMarketSlugs(): ReadonlySet<string> {
    return new Set(
      [...this.qualifiedSlugs].filter(
        (slug) =>
          this.researchedSlugs.has(slug) || this.previewedSlugs.has(slug),
      ),
    );
  }

  public get passResearchReadiness(): PassResearchReadiness {
    return this.resolvePassResearchReadiness(true);
  }

  public get strictPassResearchReadiness(): PassResearchReadiness {
    return this.resolvePassResearchReadiness(false);
  }

  private resolvePassResearchReadiness(
    allowWaivers: boolean,
  ): PassResearchReadiness {
    if (this.activeSession !== undefined) {
      const readiness = allowWaivers
        ? this.activeSession.passReadiness
        : this.activeSession.strictPassReadiness;
      if (
        this.providerDecisionReturned &&
        !this.activeSession.terminalSubmissionObserved
      ) {
        return {
          ...readiness,
          allowed: allowWaivers,
          status: allowWaivers ? "WAIVED_PROVIDER_BYPASS" : "REQUIRED",
          unmet: [
            ...readiness.unmet,
            "The decision provider returned without submit_trade_plan",
          ],
        };
      }
      return readiness;
    }
    const requirements = this.passResearchRequirements;
    const configured = requirements !== undefined;
    const availableDistinctEventFamilies = new Set(
      this.candidateFamilies.map(researchFamilyKey),
    ).size;
    return {
      allowed: configured ? allowWaivers : true,
      status: configured
        ? allowWaivers
          ? "WAIVED_PROVIDER_BYPASS"
          : "REQUIRED"
        : "DISABLED",
      unmet: configured
        ? [
            "The decision provider did not create an observable research session",
          ]
        : [],
      successfulDiscoveryRequests: 0,
      distinctDiscoveryModes: 0,
      inspectedMarkets: 0,
      availableDistinctEventFamilies,
      requiredDistinctEventFamilies: configured
        ? Math.min(
            requirements.minimumDistinctEventFamilies,
            availableDistinctEventFamilies,
          )
        : 0,
      inspectedDistinctEventFamilies: 0,
      qualifiedCandidates: 0,
      webSearches: 0,
      qualifiedMarketAnalyses: 0,
      qualifiedTradePreviews: 0,
      qualifiedCandidateReviews: 0,
      qualifiedNonHeldCandidateReviews: 0,
      requiredPriorityEvidenceMarketSlugs: [
        ...this.requiredPriorityEvidenceMarketSlugs,
      ],
      priorityEvidenceAttemptedMarketSlugs: [],
      priorityEvidenceAttemptCounts: {},
    };
  }

  public get marketDiscoveryAudit(): readonly MarketDiscoveryAuditEntry[] {
    return this.discoveryAudit;
  }

  public get observedEvidenceSources(): readonly ObservedEvidenceSource[] {
    return this.evidenceSources.sources;
  }

  public recordProviderEvidenceSources(
    sources: readonly ObservedEvidenceSource[],
  ): void {
    for (const source of sources) this.evidenceSources.register(source);
  }

  public recordProviderWebSearches(
    attemptedCount: number,
    successfulCount = attemptedCount,
  ): void {
    if (!Number.isInteger(attemptedCount) || attemptedCount < 0) {
      throw new TypeError(
        "Provider web-search count must be a non-negative integer",
      );
    }
    if (
      !Number.isInteger(successfulCount) ||
      successfulCount < 0 ||
      successfulCount > attemptedCount
    ) {
      throw new TypeError(
        "Successful provider web-search count must be between zero and the attempted count",
      );
    }
    this.totalWebSearchCount += attemptedCount;
    this.activeSession?.recordProviderWebSearches(
      attemptedCount,
      successfulCount,
    );
  }

  public recordProviderDecisionReturned(): void {
    this.providerDecisionReturned = true;
  }

  public definitionsForRound(
    finalRound: boolean,
  ): readonly DecisionToolDefinition[] {
    this.activeSession?.observeRound(finalRound);
    // Keep the provider-facing tool prefix byte-for-byte stable across rounds.
    // Forced final submission is expressed with tool_choice; mutating the tools
    // array invalidates Anthropic's tools -> system -> messages prompt cache.
    const discoveryDisabled = this.activeMaximumMarketDiscoveryRequests === 0;
    const webSearchDisabled = this.activeMaximumWebSearchRequests === 0;
    const previewDisabled = this.activeMaximumTradePreviewRequests === 0;
    return this.definitions.filter((definition) => {
      if (definition.name === "get_market_details") return false;
      if (webSearchDisabled && definition.name === "web_search") return false;
      if (
        discoveryDisabled &&
        (definition.name === "discover_markets" ||
          definition.name === "list_market_facets")
      ) {
        return false;
      }
      if (previewDisabled && definition.name === "preview_trade") {
        return false;
      }
      return true;
    });
  }

  public createSession(limits: DecisionLimits): DecisionResearchSession {
    this.activeMaximumMarketDiscoveryRequests =
      limits.maximumMarketDiscoveryRequests;
    this.activeMaximumWebSearchRequests = limits.maximumWebSearches;
    this.activeMaximumTradePreviewRequests = limits.maximumTradePreviewRequests;
    this.providerDecisionReturned = false;
    this.totalMarketDiscoveryRequestCount = 0;
    this.totalWebSearchCount = 0;
    this.totalMarketDetailRequestCount = 0;
    this.totalMarketAnalysisRequestCount = 0;
    this.totalTradePreviewCount = 0;
    this.totalNoteOperationCount = 0;
    this.totalStateOperationCount = 0;
    this.surfacedSlugs.clear();
    this.inspectedSlugs.clear();
    this.researchedSlugs.clear();
    this.previewedSlugs.clear();
    this.qualifiedSlugs.clear();
    this.discoveryAudit.length = 0;
    this.evidenceSources.clear();
    const session = new DecisionResearchSession(
      new Map(this.initialDetailsBySlug),
      this.listMarketFacets,
      this.discoverMarkets,
      this.marketDetailsHandler,
      this.marketFamilyDetailsHandler,
      this.marketAnalysisHandler,
      this.tradePreviewHandler,
      this.agentNotesHandler,
      this.agentStateHandler,
      this.webSearch,
      this.evidencePageReader,
      this.evidenceSources,
      this.maximumResultsPerSearch,
      this.messages,
      limits,
      this.candidateFamilies,
      this.researchFamilyAliases,
      this.requiredPriorityEvidenceMarketSlugs,
      this.passResearchRequirements,
      (tool) => {
        if (tool === "discover_markets" || tool === "list_market_facets") {
          this.totalMarketDiscoveryRequestCount += 1;
        } else if (tool === "web_search") {
          this.totalWebSearchCount += 1;
        } else if (
          tool === "get_market_details" ||
          tool === "get_market_family_details"
        ) {
          this.totalMarketDetailRequestCount += 1;
        } else if (tool === "get_market_analysis") {
          this.totalMarketAnalysisRequestCount += 1;
        } else if (tool === "preview_trade") {
          this.totalTradePreviewCount += 1;
        } else if (tool === "manage_notes") {
          this.totalNoteOperationCount += 1;
        } else {
          this.totalStateOperationCount += 1;
        }
      },
      (request, page) => {
        const returnedSlugs = page.items.map((item) => item.slug);
        for (const slug of returnedSlugs) this.surfacedSlugs.add(slug);
        this.discoveryAudit.push({
          request,
          returnedSlugs,
          matchedCount: page.matchedCount,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
          eof: page.eof,
          unavailableMetrics: page.unavailableMetrics,
          rankingBasis: page.rankingBasis,
          ...(page.metricCoverage === undefined
            ? {}
            : { metricCoverage: page.metricCoverage }),
          ...(page.appliedFilters === undefined
            ? {}
            : { appliedFilters: page.appliedFilters }),
        });
      },
      (slug, details, qualified) => {
        this.surfacedSlugs.add(slug);
        this.inspectedSlugs.add(slug);
        if (qualified) this.qualifiedSlugs.add(slug);
        void details;
      },
      (slug) => this.researchedSlugs.add(slug),
      (slug) => this.previewedSlugs.add(slug),
      this.forecastPolicy,
      this.requiredResearchGate,
    );
    this.activeSession = session;
    return session;
  }
}

type CountedTool =
  | "list_market_facets"
  | "discover_markets"
  | "web_search"
  | "get_market_details"
  | "get_market_family_details"
  | "get_market_analysis"
  | "preview_trade"
  | "manage_notes"
  | "manage_state";

export class DecisionResearchSession {
  private readonly cursorSecret = randomBytes(32);
  private readonly completedDiscoveryRequests = new Set<string>();
  private readonly consumedDiscoveryCursors = new Map<string, Set<string>>();
  private marketDiscoveryCount = 0;
  private webSearchCount = 0;
  private evidenceSourceReadCount = 0;
  private successfulEvidenceSourceReadCount = 0;
  private successfulWebSearchCount = 0;
  private marketDetailRequestCount = 0;
  private marketAnalysisRequestCount = 0;
  private tradePreviewCount = 0;
  private noteOperationCount = 0;
  private stateOperationCount = 0;
  private terminalDecisionSubmitted = false;
  private terminalDecisionRepairCount = 0;
  private roundStateObserved = false;
  private forcedFinalRound = false;
  private successfulDiscoveryCount = 0;
  private readonly successfulDiscoveryModes = new Set<MarketDiscoveryMode>();
  private readonly candidateFamilyBySlug = new Map<string, string>();
  private readonly inspectedSlugs = new Set<string>();
  private readonly inspectedFamilies = new Set<string>();
  private readonly familyDetailSnapshotSlugs = new Set<string>();
  private readonly qualifiedSlugs = new Set<string>();
  private readonly qualifiedAnalysisSlugs = new Set<string>();
  private readonly qualifiedPreviewSlugs = new Set<string>();
  private readonly priorityEvidenceAttemptDomainsBySlug = new Map<
    string,
    Set<string>
  >();
  private readonly evidencePageCache = new Map<
    string,
    Promise<FetchedEvidencePage>
  >();

  public constructor(
    private readonly detailsBySlug: Map<string, DetailedMarketContext>,
    private readonly listMarketFacets: MarketFacetHandler | undefined,
    private readonly discoverMarkets: MarketDiscoveryHandler | undefined,
    private readonly marketDetailsHandler: MarketDetailsHandler | undefined,
    private readonly marketFamilyDetailsHandler:
      MarketFamilyDetailsHandler | undefined,
    private readonly marketAnalysisHandler: MarketAnalysisHandler | undefined,
    private readonly tradePreviewHandler: TradePreviewHandler | undefined,
    private readonly agentNotesHandler: AgentNotesHandler | undefined,
    private readonly agentStateHandler: AgentStateHandler | undefined,
    private readonly webSearch: WebSearchHandler | undefined,
    private readonly evidencePageReader: EvidencePageReader,
    private readonly evidenceSources: EvidenceSourceRegistry,
    private readonly maximumResultsPerSearch: number,
    private readonly messages: ResearchToolMessages,
    private readonly limits: DecisionLimits,
    candidateFamilies: readonly CandidateFamilySeed[],
    private readonly researchFamilyAliases: ReadonlyMap<string, string>,
    private readonly requiredPriorityEvidenceMarketSlugs: ReadonlySet<string>,
    private readonly passResearchRequirements:
      PassResearchRequirements | undefined,
    private readonly recordCall: (tool: CountedTool) => void,
    private readonly recordDiscovery: (
      request: MarketDiscoveryRequest,
      page: MarketDiscoveryPage,
    ) => void,
    private readonly recordInspected: (
      slug: string,
      details: DetailedMarketContext,
      qualified: boolean,
    ) => void,
    private readonly recordResearched: (slug: string) => void,
    private readonly recordPreviewed: (slug: string) => void,
    private readonly forecastPolicy?: ForecastPolicy,
    private readonly requiredResearchGate?: SelectionPolicy["shouldEnforceRequiredResearch"],
  ) {
    for (const candidate of candidateFamilies) {
      this.candidateFamilyBySlug.set(
        candidate.marketSlug,
        this.researchFamilyAliases.get(candidate.marketSlug) ??
          researchFamilyKey(candidate),
      );
    }
    for (const details of this.detailsBySlug.values()) {
      if (details.officialLiveSnapshot === undefined) continue;
      const family = preserveAdvisoryResearchFamily(
        this.candidateFamilyBySlug.get(details.slug) ??
          this.researchFamilyAliases.get(details.slug),
        nativeMarketFamilyKey(detailedMarketFamilySeed(details)),
      );
      this.candidateFamilyBySlug.set(details.slug, family);
      this.inspectedSlugs.add(details.slug);
      this.inspectedFamilies.add(family);
      this.familyDetailSnapshotSlugs.add(details.slug);
      const qualified =
        this.passResearchRequirements !== undefined &&
        mechanicallyQualifiedMarket(
          details,
          this.passResearchRequirements.maximumQualifiedSpread,
        );
      if (qualified) this.qualifiedSlugs.add(details.slug);
      this.recordInspected(details.slug, details, qualified);
    }
  }

  private async registerSystemLiveEvidenceSources(
    details: DetailedMarketContext,
    signal: AbortSignal,
  ): Promise<readonly SystemLiveEvidenceSource[]> {
    const sources =
      this.forecastPolicy?.systemLiveEvidenceSources(details) ?? [];
    const observedAt = new Date().toISOString();
    return Promise.all(
      sources.map(async (source): Promise<SystemLiveEvidenceSource> => {
        this.evidenceSources.register({
          title: source.title,
          url: source.url,
          observedAt,
          provider: "SYSTEM_LIVE_FEED",
        });
        const url = canonicalEvidenceUrl(source.url);
        let pending = this.evidencePageCache.get(url);
        if (pending === undefined) {
          pending = this.evidencePageReader(url, signal);
          this.evidencePageCache.set(url, pending);
        }
        try {
          const page = await pending;
          const linePreview = this.forecastPolicy?.liveEvidenceLinePreview(
            page.text,
            source.findHint,
            details.sessionOpenYesPrice,
            details,
          );
          if (linePreview !== undefined) {
            this.evidenceSources.register({
              title: source.title,
              url: source.url,
              excerpt: linePreview.evidenceExcerpt,
              observedAt,
              provider: "SYSTEM_LIVE_FEED",
            });
          }
          return linePreview === undefined
            ? source
            : { ...source, preview: linePreview.preview };
        } catch (error) {
          if (signal.aborted) throw error;
          if (this.evidencePageCache.get(url) === pending) {
            this.evidencePageCache.delete(url);
          }
          return source;
        }
      }),
    );
  }

  public get counts(): ResearchToolCounts {
    return {
      marketDiscoveryRequests: this.marketDiscoveryCount,
      webSearches: this.webSearchCount,
      evidenceSourceReads: this.evidenceSourceReadCount,
      successfulEvidenceSourceReads: this.successfulEvidenceSourceReadCount,
      marketDetailRequests: this.marketDetailRequestCount,
      marketAnalysisRequests: this.marketAnalysisRequestCount,
      tradePreviews: this.tradePreviewCount,
      noteOperations: this.noteOperationCount,
      stateOperations: this.stateOperationCount,
    };
  }

  public observeRound(finalRound: boolean): void {
    this.roundStateObserved = true;
    this.forcedFinalRound = finalRound;
  }

  public get terminalSubmissionObserved(): boolean {
    return this.terminalDecisionSubmitted;
  }

  public get evidenceReadBudgetExhausted(): boolean {
    return (
      this.evidenceSourceReadCount >=
      this.limits.maximumEvidenceSourceReadRequests
    );
  }

  public reopenForTerminalDecisionRepair(maximumAttempts = 1): void {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new TypeError(
        "Maximum terminal decision repair attempts must be a positive safe integer",
      );
    }
    if (!this.terminalDecisionSubmitted) {
      throw new Error("A terminal decision must be submitted before repair");
    }
    if (this.terminalDecisionRepairCount >= maximumAttempts) {
      throw new Error("The terminal decision repair limit was reached");
    }
    this.terminalDecisionSubmitted = false;
    this.terminalDecisionRepairCount += 1;
  }

  public recordProviderWebSearches(
    attemptedCount: number,
    successfulCount = attemptedCount,
  ): void {
    if (!Number.isSafeInteger(attemptedCount) || attemptedCount < 0) {
      throw new TypeError(
        "Provider web-search count must be a non-negative safe integer",
      );
    }
    if (
      !Number.isSafeInteger(successfulCount) ||
      successfulCount < 0 ||
      successfulCount > attemptedCount
    ) {
      throw new TypeError(
        "Successful provider web-search count must be between zero and the attempted count",
      );
    }
    this.webSearchCount += attemptedCount;
    this.successfulWebSearchCount += successfulCount;
  }

  public get passReadiness(): PassResearchReadiness {
    return this.resolvePassReadiness(true);
  }

  public get strictPassReadiness(): PassResearchReadiness {
    return this.resolvePassReadiness(false);
  }

  private priorityResearchUnmet(): readonly string[] {
    const required = [...this.requiredPriorityEvidenceMarketSlugs];
    const missingInspections = required.filter(
      (slug) => !this.inspectedSlugs.has(slug),
    );
    const missingEvidence = required.flatMap((slug) => {
      const details = this.detailsBySlug.get(slug);
      const requiresEvidence =
        details !== undefined &&
        this.passResearchRequirements !== undefined &&
        mechanicallyQualifiedMarket(
          details,
          this.passResearchRequirements.maximumQualifiedSpread,
        );
      if (!requiresEvidence) return [];
      const observedDomains =
        this.priorityEvidenceAttemptDomainsBySlug.get(slug)?.size ?? 0;
      return observedDomains >= MINIMUM_PRIORITY_EVIDENCE_ATTEMPT_DOMAINS
        ? []
        : [
            `${slug} (${observedDomains}/${MINIMUM_PRIORITY_EVIDENCE_ATTEMPT_DOMAINS} distinct source domains)`,
          ];
    });
    return [
      ...(missingInspections.length === 0
        ? []
        : [`inspect required market(s): ${missingInspections.join(", ")}`]),
      ...(missingEvidence.length === 0
        ? []
        : [
            `bind observed current sources from ${MINIMUM_PRIORITY_EVIDENCE_ATTEMPT_DOMAINS} distinct domains with read_evidence_source for required quoted market(s): ${missingEvidence.join(", ")}`,
          ]),
    ];
  }

  private resolvePassReadiness(allowWaivers: boolean): PassResearchReadiness {
    const requirements = this.passResearchRequirements;
    const qualifiedCandidateReviews = [...this.qualifiedAnalysisSlugs].filter(
      (slug) => this.qualifiedPreviewSlugs.has(slug),
    ).length;
    const qualifiedNonHeldSlugs = [...this.qualifiedSlugs].filter(
      (slug) => this.detailsBySlug.get(slug)?.held !== true,
    );
    const qualifiedNonHeldCandidateReviews = qualifiedNonHeldSlugs.filter(
      (slug) =>
        this.qualifiedAnalysisSlugs.has(slug) &&
        this.qualifiedPreviewSlugs.has(slug),
    ).length;
    const requiredPriorityEvidenceMarketSlugs = [
      ...this.requiredPriorityEvidenceMarketSlugs,
    ];
    const base = {
      successfulDiscoveryRequests: this.successfulDiscoveryCount,
      distinctDiscoveryModes: this.successfulDiscoveryModes.size,
      inspectedMarkets: this.inspectedSlugs.size,
      availableDistinctEventFamilies: new Set(
        this.candidateFamilyBySlug.values(),
      ).size,
      inspectedDistinctEventFamilies: this.inspectedFamilies.size,
      qualifiedCandidates: this.qualifiedSlugs.size,
      webSearches: this.successfulWebSearchCount,
      qualifiedMarketAnalyses: this.qualifiedAnalysisSlugs.size,
      qualifiedTradePreviews: this.qualifiedPreviewSlugs.size,
      qualifiedCandidateReviews,
      qualifiedNonHeldCandidateReviews,
      requiredPriorityEvidenceMarketSlugs,
      priorityEvidenceAttemptedMarketSlugs: [
        ...this.priorityEvidenceAttemptDomainsBySlug.keys(),
      ],
      priorityEvidenceAttemptCounts: Object.fromEntries(
        [...this.priorityEvidenceAttemptDomainsBySlug].map(
          ([slug, domains]) => [slug, domains.size],
        ),
      ),
    };
    if (requirements === undefined) {
      return {
        allowed: true,
        status: "DISABLED",
        unmet: [],
        requiredDistinctEventFamilies: 0,
        ...base,
      };
    }

    const candidateCount = this.candidateFamilyBySlug.size;
    if (candidateCount === 0) {
      return {
        allowed: true,
        status: "NO_CANDIDATES",
        unmet: [],
        requiredDistinctEventFamilies: 0,
        ...base,
      };
    }
    const requiredDistinctEventFamilies = Math.min(
      requirements.minimumDistinctEventFamilies,
      base.availableDistinctEventFamilies,
    );
    const requiredInspectedMarkets = Math.min(
      requirements.minimumInspectedMarkets,
      candidateCount,
    );
    const unmet: string[] = [];
    unmet.push(...this.priorityResearchUnmet());
    if (this.successfulDiscoveryCount < requirements.minimumDiscoveryRequests) {
      unmet.push(
        `${requirements.minimumDiscoveryRequests - this.successfulDiscoveryCount} successful market-discovery request(s)`,
      );
    }
    if (
      this.successfulDiscoveryModes.size <
      requirements.minimumDistinctDiscoveryModes
    ) {
      unmet.push(
        `${requirements.minimumDistinctDiscoveryModes - this.successfulDiscoveryModes.size} additional discovery mode(s)`,
      );
    }
    if (this.inspectedSlugs.size < requiredInspectedMarkets) {
      unmet.push(
        `${requiredInspectedMarkets - this.inspectedSlugs.size} successful market inspection(s)`,
      );
    }
    if (this.inspectedFamilies.size < requiredDistinctEventFamilies) {
      unmet.push(
        `${requiredDistinctEventFamilies - this.inspectedFamilies.size} distinct event-family inspection(s)`,
      );
    }
    if (this.qualifiedSlugs.size > 0) {
      if (this.successfulWebSearchCount < requirements.minimumWebSearches) {
        unmet.push(
          `${requirements.minimumWebSearches - this.successfulWebSearchCount} successful web search(es) for qualified candidates`,
        );
      }
      const requiredAnalyses = Math.min(
        requirements.minimumMarketAnalyses,
        this.qualifiedSlugs.size,
      );
      if (this.qualifiedAnalysisSlugs.size < requiredAnalyses) {
        unmet.push(
          `${requiredAnalyses - this.qualifiedAnalysisSlugs.size} qualified-candidate market analysis request(s)`,
        );
      }
      const requiredPreviews = Math.min(
        requirements.minimumTradePreviews,
        this.qualifiedSlugs.size,
      );
      if (this.qualifiedPreviewSlugs.size < requiredPreviews) {
        unmet.push(
          `${requiredPreviews - this.qualifiedPreviewSlugs.size} qualified-candidate trade preview request(s)`,
        );
      }
      const requiredCompletedReviews = Math.min(
        requiredAnalyses,
        requiredPreviews,
      );
      if (qualifiedCandidateReviews < requiredCompletedReviews) {
        unmet.push(
          `${requiredCompletedReviews - qualifiedCandidateReviews} qualified candidate(s) with both a successful market analysis and trade preview`,
        );
      }
      const requiredNonHeldCompletedReviews = Math.min(
        requiredCompletedReviews,
        qualifiedNonHeldSlugs.length,
      );
      if (qualifiedNonHeldCandidateReviews < requiredNonHeldCompletedReviews) {
        unmet.push(
          `${requiredNonHeldCompletedReviews - qualifiedNonHeldCandidateReviews} additional non-held qualified candidate(s) with both a successful market analysis and trade preview`,
        );
      }
    }
    if (unmet.length === 0) {
      return {
        allowed: true,
        status:
          this.qualifiedSlugs.size === 0
            ? "NO_QUALIFIED_CANDIDATES"
            : "SATISFIED",
        unmet,
        requiredDistinctEventFamilies,
        ...base,
      };
    }
    if (allowWaivers && !this.roundStateObserved) {
      return {
        allowed: true,
        status: "WAIVED_PROVIDER_BYPASS",
        unmet,
        requiredDistinctEventFamilies,
        ...base,
      };
    }
    if (allowWaivers && this.forcedFinalRound) {
      return {
        allowed: true,
        status: "WAIVED_FINAL_ROUND",
        unmet,
        requiredDistinctEventFamilies,
        ...base,
      };
    }
    return {
      allowed: false,
      status: "REQUIRED",
      unmet,
      requiredDistinctEventFamilies,
      ...base,
    };
  }

  private get discoveryBudget(): Readonly<{
    maximum: number;
    used: number;
    remaining: number;
  }> {
    return {
      maximum: this.limits.maximumMarketDiscoveryRequests,
      used: this.marketDiscoveryCount,
      remaining: Math.max(
        0,
        this.limits.maximumMarketDiscoveryRequests - this.marketDiscoveryCount,
      ),
    };
  }

  private discoveryMetadata(
    details: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return { ...details, discoveryBudget: this.discoveryBudget };
  }

  public async execute(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.terminalDecisionSubmitted) {
      throw new Error("No tools may run after submit_trade_plan");
    }

    switch (name) {
      case "list_market_facets":
        return this.executeMarketFacets(input, signal);
      case "discover_markets":
        return this.executeMarketDiscovery(input, signal);
      case "web_search":
        return this.executeWebSearch(input, signal);
      case "read_evidence_source":
        return this.executeEvidenceSourceRead(input, signal);
      case "get_market_details":
        return this.executeMarketDetails(input, signal);
      case "get_market_family_details":
        return this.executeMarketFamilyDetails(input, signal);
      case "get_market_analysis":
        return this.executeMarketAnalysis(input, signal);
      case "preview_trade":
        return this.executeTradePreview(input, signal);
      case "manage_notes":
        return this.executeAgentNotes(input, signal);
      case "manage_state":
        return this.executeAgentState(input, signal);
      case "submit_trade_plan": {
        let decision: AgentDecision;
        try {
          decision = parseModelAgentDecision(input);
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
          return safeToolError(
            "INVALID_TRADE_PLAN_INPUT",
            this.messages.invalidTradePlanInput,
            {
              issues: decisionInputValidationIssues(error),
              issueCount: error.issues.length,
              issuesTruncated:
                error.issues.length > MAXIMUM_DECISION_INPUT_ISSUES,
            },
          );
        }
        const priorityResearchUnmet = this.priorityResearchUnmet();
        const enforceRequiredResearch =
          this.requiredResearchGate?.(decision, this.detailsBySlug) ?? true;
        if (enforceRequiredResearch && priorityResearchUnmet.length > 0) {
          return safeToolError(
            "PRIORITY_RESEARCH_REQUIRED",
            this.messages.passResearchRequired,
            {
              requiredPriorityEvidenceMarketSlugs: [
                ...this.requiredPriorityEvidenceMarketSlugs,
              ],
              priorityEvidenceAttemptedMarketSlugs: [
                ...this.priorityEvidenceAttemptDomainsBySlug.keys(),
              ],
              priorityEvidenceAttemptCounts: Object.fromEntries(
                [...this.priorityEvidenceAttemptDomainsBySlug].map(
                  ([slug, domains]) => [slug, domains.size],
                ),
              ),
              unmet: priorityResearchUnmet,
            },
          );
        }
        if (
          decision.portfolioTargets.length === 0 &&
          decision.proposals.length === 0
        ) {
          const readiness = this.passReadiness;
          if (!readiness.allowed) {
            return safeToolError(
              "PASS_RESEARCH_REQUIRED",
              this.messages.passResearchRequired,
              { readiness },
            );
          }
        }
        this.terminalDecisionSubmitted = true;
        return { kind: "DECISION", decision };
      }
      default:
        return safeToolError("UNKNOWN_TOOL", this.messages.unknownTool);
    }
  }

  private async executeMarketFacets(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = MarketFacetInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidMarketFacetInput,
        this.discoveryMetadata(),
      );
    }

    const protectedCursor = parsed.data.cursor;
    const baseRequest: MarketFacetRequest = {
      ...(parsed.data.kind === undefined || parsed.data.kind === "ALL"
        ? {}
        : { kind: parsed.data.kind }),
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    };
    const fingerprint = requestFingerprint("facets", {
      ...baseRequest,
      limit: baseRequest.limit ?? 25,
    });
    let rawCursor: string | undefined;
    try {
      rawCursor =
        protectedCursor === undefined
          ? undefined
          : unprotectCursor(
              this.cursorSecret,
              "facets",
              fingerprint,
              protectedCursor,
            );
    } catch (error) {
      if (!(error instanceof InvalidProtectedCursorError)) throw error;
      return safeToolError(
        "INVALID_DISCOVERY_CURSOR",
        this.messages.invalidMarketDiscoveryCursor,
        this.discoveryMetadata(),
      );
    }
    const request: MarketFacetRequest = {
      ...baseRequest,
      ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    };
    const callKey = `${fingerprint}\0${rawCursor ?? ""}`;
    if (this.completedDiscoveryRequests.has(callKey)) {
      return safeToolError(
        "DUPLICATE_DISCOVERY_REQUEST",
        this.messages.duplicateMarketDiscoveryRequest,
        this.discoveryMetadata(),
      );
    }
    if (
      this.marketDiscoveryCount >= this.limits.maximumMarketDiscoveryRequests
    ) {
      return safeToolError(
        "DISCOVERY_LIMIT_REACHED",
        this.messages.marketDiscoveryLimitReached,
        this.discoveryMetadata(),
      );
    }
    this.marketDiscoveryCount += 1;
    this.recordCall("list_market_facets");
    if (this.listMarketFacets === undefined) {
      return safeToolError(
        "FACETS_UNAVAILABLE",
        this.messages.marketFacetsUnavailable,
        this.discoveryMetadata(),
      );
    }

    try {
      const page = await this.listMarketFacets(request, signal);
      const consumedCursors =
        this.consumedDiscoveryCursors.get(fingerprint) ?? new Set<string>();
      if (rawCursor !== undefined) consumedCursors.add(rawCursor);
      this.consumedDiscoveryCursors.set(fingerprint, consumedCursors);
      let nextCursor: string | undefined;
      if (!page.eof) {
        if (
          page.nextCursor === undefined ||
          page.nextCursor === rawCursor ||
          consumedCursors.has(page.nextCursor)
        ) {
          this.completedDiscoveryRequests.add(callKey);
          return safeToolError(
            "DISCOVERY_CURSOR_LOOP",
            this.messages.marketDiscoveryCursorLoop,
            this.discoveryMetadata(),
          );
        }
        try {
          nextCursor = protectCursor(
            this.cursorSecret,
            "facets",
            fingerprint,
            page.nextCursor,
          );
        } catch (error) {
          if (!(error instanceof InvalidProtectedCursorError)) throw error;
          this.completedDiscoveryRequests.add(callKey);
          return safeToolError(
            "DISCOVERY_CURSOR_LOOP",
            this.messages.marketDiscoveryCursorLoop,
            this.discoveryMetadata(),
          );
        }
      }
      this.completedDiscoveryRequests.add(callKey);
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.marketFacetsSecurityNotice,
          ...page,
          nextCursor,
          discoveryBudget: this.discoveryBudget,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "FACETS_FAILED",
        this.messages.marketFacetsFailed,
        this.discoveryMetadata(),
      );
    }
  }

  private async executeMarketDiscovery(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = MarketDiscoveryInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidMarketDiscoveryInput,
        this.discoveryMetadata(),
      );
    }

    const protectedCursor = parsed.data.cursor;
    const baseRequest: MarketDiscoveryRequest = {
      ...parsed.data,
      cursor: undefined,
    };
    const fingerprint = requestFingerprint("markets", {
      ...baseRequest,
      limit: baseRequest.limit ?? 20,
    });
    let rawCursor: string | undefined;
    try {
      rawCursor =
        protectedCursor === undefined
          ? undefined
          : unprotectCursor(
              this.cursorSecret,
              "markets",
              fingerprint,
              protectedCursor,
            );
    } catch (error) {
      if (!(error instanceof InvalidProtectedCursorError)) throw error;
      return safeToolError(
        "INVALID_DISCOVERY_CURSOR",
        this.messages.invalidMarketDiscoveryCursor,
        this.discoveryMetadata(),
      );
    }
    const request: MarketDiscoveryRequest = {
      ...baseRequest,
      ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    };
    const callKey = `${fingerprint}\0${rawCursor ?? ""}`;
    if (this.completedDiscoveryRequests.has(callKey)) {
      return safeToolError(
        "DUPLICATE_DISCOVERY_REQUEST",
        this.messages.duplicateMarketDiscoveryRequest,
        this.discoveryMetadata(),
      );
    }
    if (
      this.marketDiscoveryCount >= this.limits.maximumMarketDiscoveryRequests
    ) {
      return safeToolError(
        "DISCOVERY_LIMIT_REACHED",
        this.messages.marketDiscoveryLimitReached,
        this.discoveryMetadata(),
      );
    }
    this.marketDiscoveryCount += 1;
    this.recordCall("discover_markets");
    if (this.discoverMarkets === undefined) {
      return safeToolError(
        "DISCOVERY_UNAVAILABLE",
        this.messages.marketDiscoveryUnavailable,
        this.discoveryMetadata(),
      );
    }

    try {
      const page = await this.discoverMarkets(request, signal);
      const consumedCursors =
        this.consumedDiscoveryCursors.get(fingerprint) ?? new Set<string>();
      if (rawCursor !== undefined) consumedCursors.add(rawCursor);
      this.consumedDiscoveryCursors.set(fingerprint, consumedCursors);
      let nextCursor: string | undefined;
      if (!page.eof) {
        if (
          page.nextCursor === undefined ||
          page.nextCursor === rawCursor ||
          consumedCursors.has(page.nextCursor)
        ) {
          this.completedDiscoveryRequests.add(callKey);
          return safeToolError(
            "DISCOVERY_CURSOR_LOOP",
            this.messages.marketDiscoveryCursorLoop,
            this.discoveryMetadata(),
          );
        }
        try {
          nextCursor = protectCursor(
            this.cursorSecret,
            "markets",
            fingerprint,
            page.nextCursor,
          );
        } catch (error) {
          if (!(error instanceof InvalidProtectedCursorError)) throw error;
          this.completedDiscoveryRequests.add(callKey);
          return safeToolError(
            "DISCOVERY_CURSOR_LOOP",
            this.messages.marketDiscoveryCursorLoop,
            this.discoveryMetadata(),
          );
        }
      }
      this.completedDiscoveryRequests.add(callKey);
      this.successfulDiscoveryCount += 1;
      this.successfulDiscoveryModes.add(request.mode);
      for (const item of page.items) {
        const seed = catalogRowFamilySeed(item);
        const nativeFamily = nativeMarketFamilyKey(seed);
        this.candidateFamilyBySlug.set(
          seed.marketSlug,
          preserveAdvisoryResearchFamily(
            this.candidateFamilyBySlug.get(seed.marketSlug) ??
              this.researchFamilyAliases.get(seed.marketSlug),
            nativeFamily,
          ),
        );
      }
      this.recordDiscovery(request, page);
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.marketDiscoverySecurityNotice,
          ...page,
          nextCursor,
          discoveryBudget: this.discoveryBudget,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof MarketDiscoveryNarrowingRequiredError) {
        this.completedDiscoveryRequests.add(callKey);
        if (rawCursor !== undefined) {
          const consumedCursors =
            this.consumedDiscoveryCursors.get(fingerprint) ?? new Set<string>();
          consumedCursors.add(rawCursor);
          this.consumedDiscoveryCursors.set(fingerprint, consumedCursors);
        }
        return safeToolError(
          error.code,
          this.messages.marketDiscoveryNarrowingRequired,
          this.discoveryMetadata({ narrowing: error.toJSON() }),
        );
      }
      return safeToolError(
        "DISCOVERY_FAILED",
        this.messages.marketDiscoveryFailed,
        this.discoveryMetadata(),
      );
    }
  }

  private async executeWebSearch(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = WebSearchInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidWebSearchInput,
      );
    }
    if (this.webSearchCount >= this.limits.maximumWebSearches) {
      return safeToolError(
        "TOOL_LIMIT_REACHED",
        "Maximum web-search count reached. Do not call web_search again this cycle; use the evidence already observed and submit the complete trade plan.",
      );
    }
    const attributedMarketSlugs =
      parsed.data.marketSlug === undefined
        ? (parsed.data.marketSlugs ?? [])
        : [parsed.data.marketSlug];
    if (
      attributedMarketSlugs.some(
        (marketSlug) => !this.detailsBySlug.has(marketSlug),
      )
    ) {
      return safeToolError(
        "MARKET_DETAILS_REQUIRED",
        this.messages.marketDetailsRequired,
      );
    }
    this.webSearchCount += 1;
    this.recordCall("web_search");
    if (this.webSearch === undefined) {
      return safeToolError(
        "SEARCH_UNAVAILABLE",
        this.messages.searchUnavailable,
      );
    }

    try {
      const rawResults = await this.webSearch(parsed.data.query, signal);
      const results = rawResults
        .slice(0, this.maximumResultsPerSearch)
        .map((result) => WebSearchResultSchema.parse(result))
        .map((result) => ({
          title: sanitizeExternalText(result.title),
          url: result.url,
          snippet: sanitizeExternalText(result.snippet),
          ...(result.publishedAt === undefined
            ? {}
            : { publishedAt: result.publishedAt }),
        }));
      const observedAt = new Date().toISOString();
      for (const result of results) {
        this.evidenceSources.register({
          url: result.url,
          title: result.title,
          excerpt: result.snippet,
          observedAt,
          ...(result.publishedAt === undefined
            ? {}
            : { publishedAt: result.publishedAt }),
          provider: "CLIENT_WEB_SEARCH",
        });
      }
      this.successfulWebSearchCount += 1;
      for (const marketSlug of attributedMarketSlugs) {
        this.recordResearched(marketSlug);
      }
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.searchResultsSecurityNotice,
          ...(attributedMarketSlugs.length === 0
            ? {}
            : { attributedMarketSlugs }),
          results,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError("SEARCH_FAILED", this.messages.searchFailed);
    }
  }

  private async executeEvidenceSourceRead(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = EvidenceSourceReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidEvidenceSourceReadInput,
      );
    }

    const attributedMarketSlug = parsed.data.marketSlug;
    if (
      attributedMarketSlug !== undefined &&
      !this.detailsBySlug.has(attributedMarketSlug)
    ) {
      return safeToolError(
        "MARKET_DETAILS_REQUIRED",
        this.messages.marketDetailsRequired,
      );
    }

    const url = canonicalEvidenceUrl(parsed.data.url);
    const observed = this.evidenceSources.get(url);
    if (observed === undefined) {
      return safeToolError(
        "EVIDENCE_SOURCE_NOT_OBSERVED",
        this.messages.evidenceSourceNotObserved,
      );
    }

    if (attributedMarketSlug !== undefined) {
      // Requiring an already-observed URL makes this a verifiable follow-up to
      // current-cycle search rather than a model assertion. Record the attempt
      // before fetching so an inaccessible primary page can still support an
      // honest INSUFFICIENT_CURRENT_EVIDENCE disposition.
      const domain = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
      for (const marketSlug of relatedPriorityEvidenceAttributionSlugs({
        attributedMarketSlug,
        researchFamilyBySlug: this.candidateFamilyBySlug,
        requiredPriorityMarketSlugs: this.requiredPriorityEvidenceMarketSlugs,
      })) {
        const attemptedDomains =
          this.priorityEvidenceAttemptDomainsBySlug.get(marketSlug) ??
          new Set<string>();
        attemptedDomains.add(domain);
        this.priorityEvidenceAttemptDomainsBySlug.set(
          marketSlug,
          attemptedDomains,
        );
        this.recordResearched(marketSlug);
      }
    }

    if (
      this.evidenceSourceReadCount >=
      this.limits.maximumEvidenceSourceReadRequests
    ) {
      return safeToolError(
        "EVIDENCE_SOURCE_READ_LIMIT_REACHED",
        "The cycle snapshot evidence-read limit was reached. Repeated reads cannot monitor or refresh a source; use the evidence already returned and submit the trade plan.",
      );
    }
    this.evidenceSourceReadCount += 1;

    let pending = this.evidencePageCache.get(url);
    if (pending === undefined) {
      pending = this.evidencePageReader(url, signal);
      this.evidencePageCache.set(url, pending);
    }

    try {
      const page = await pending;
      const finalUrl = canonicalEvidenceUrl(page.finalUrl);
      const rawSelection = selectEvidenceSourceText(
        page.text,
        parsed.data.find,
      );
      const selection =
        observed.provider === "SYSTEM_LIVE_FEED" &&
        rawSelection.selectionMode === "NO_MATCH_PREFIX"
          ? {
              ...rawSelection,
              text: "No matching live-score record was present in this feed snapshot.",
              truncated: false,
            }
          : rawSelection;
      this.evidenceSources.register({
        ...observed,
        excerpt: selection.text,
        ...(page.publishedAt === undefined
          ? {}
          : { publishedAt: page.publishedAt }),
      });
      this.successfulEvidenceSourceReadCount += 1;
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.evidenceSourceSecurityNotice,
          url,
          finalUrl,
          title: sanitizeExternalText(observed.title),
          observedAt: observed.observedAt,
          ...(attributedMarketSlug === undefined
            ? {}
            : { attributedMarketSlug }),
          ...(page.publishedAt === undefined
            ? {}
            : { publishedAt: page.publishedAt }),
          find: parsed.data.find ?? null,
          ...selection,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (this.evidencePageCache.get(url) === pending) {
        this.evidencePageCache.delete(url);
      }
      return safeToolError(
        "EVIDENCE_SOURCE_READ_FAILED",
        this.messages.evidenceSourceReadFailed,
      );
    }
  }

  private async executeMarketDetails(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = MarketDetailsInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidMarketDetailsInput,
      );
    }
    if (
      this.marketDetailRequestCount >= this.limits.maximumMarketDetailRequests
    ) {
      return safeToolError(
        "TOOL_LIMIT_REACHED",
        "Maximum market-detail request count reached. Do not request more market or family details this cycle; use the inspected candidates and submit the complete trade plan.",
      );
    }
    this.marketDetailRequestCount += 1;
    this.recordCall("get_market_details");
    const slug = parsed.data.marketSlug;
    let details = this.detailsBySlug.get(slug);
    if (details === undefined && this.marketDetailsHandler !== undefined) {
      try {
        details = DetailedMarketContextSchema.parse(
          await this.marketDetailsHandler(slug, signal),
        ) as DetailedMarketContext;
        this.detailsBySlug.set(slug, details);
      } catch (error) {
        if (signal.aborted) throw error;
        return safeToolError(
          "MARKET_DETAILS_FAILED",
          this.messages.marketDetailsFailed,
        );
      }
    }
    if (details === undefined) {
      return safeToolError(
        "MARKET_NOT_IN_CATALOG",
        this.messages.marketNotInContext,
      );
    }
    const familySeed = detailedMarketFamilySeed(details);
    const family = preserveAdvisoryResearchFamily(
      this.candidateFamilyBySlug.get(slug) ??
        this.researchFamilyAliases.get(slug),
      nativeMarketFamilyKey(familySeed),
    );
    this.candidateFamilyBySlug.set(slug, family);
    this.inspectedSlugs.add(slug);
    this.inspectedFamilies.add(family);
    const qualified =
      this.passResearchRequirements !== undefined &&
      mechanicallyQualifiedMarket(
        details,
        this.passResearchRequirements.maximumQualifiedSpread,
      );
    if (qualified) this.qualifiedSlugs.add(slug);
    this.recordInspected(slug, details, qualified);
    const liveEvidenceSources = await this.registerSystemLiveEvidenceSources(
      details,
      signal,
    );
    return {
      kind: "TOOL_RESULT",
      content: JSON.stringify({
        ok: true,
        securityNotice: this.messages.marketDetailsSecurityNotice,
        market: details,
        ...(liveEvidenceSources.length === 0 ? {} : { liveEvidenceSources }),
      }),
      isError: false,
    };
  }

  private async executeMarketFamilyDetails(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = MarketFamilyDetailsInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidMarketFamilyDetailsInput,
      );
    }
    if (this.familyDetailSnapshotSlugs.has(parsed.data.marketSlug)) {
      return safeToolError(
        "MARKET_FAMILY_ALREADY_INSPECTED",
        "This market family already has an immutable snapshot for this cycle. Do not poll it; use the prior result and submit_trade_plan now.",
      );
    }
    if (
      this.marketDetailRequestCount >= this.limits.maximumMarketDetailRequests
    ) {
      return safeToolError(
        "TOOL_LIMIT_REACHED",
        "Maximum market-detail request count reached. Do not request more market or family details this cycle; use the inspected candidates and submit the complete trade plan.",
      );
    }
    this.marketDetailRequestCount += 1;
    this.recordCall("get_market_family_details");
    if (this.marketFamilyDetailsHandler === undefined) {
      return safeToolError(
        "MARKET_FAMILY_DETAILS_UNAVAILABLE",
        this.messages.marketFamilyDetailsUnavailable,
      );
    }

    try {
      const result = MarketFamilyDetailsResultSchema.parse(
        await this.marketFamilyDetailsHandler(parsed.data, signal),
      ) as MarketFamilyDetailsResult;
      if (result.seedMarketSlug !== parsed.data.marketSlug) {
        throw new Error(
          "Market-family result returned a different seed market",
        );
      }
      const seedDetails = result.members.find(
        (details) => details.slug === result.seedMarketSlug,
      );
      if (seedDetails === undefined) {
        throw new Error("Market-family result omitted its seed market");
      }
      const seedFamily = detailedMarketFamilySeed(seedDetails);
      if (nativeMarketFamilyKey(seedFamily) !== result.family.key) {
        throw new Error(
          `Seed market ${seedDetails.slug} does not belong to ${result.family.key}`,
        );
      }
      const liveEvidenceSources = new Map<string, SystemLiveEvidenceSource>();
      const liveEvidenceSourcesByMarket: {
        readonly marketSlug: string;
        readonly sources: readonly SystemLiveEvidenceSource[];
      }[] = [];
      for (const details of result.members) {
        if (
          !isInNativeMarketFamily(seedFamily, detailedMarketFamilySeed(details))
        ) {
          throw new Error(
            `Market ${details.slug} does not belong to ${result.family.key}`,
          );
        }
      }

      const seedResearchFamily = preserveAdvisoryResearchFamily(
        this.candidateFamilyBySlug.get(result.seedMarketSlug) ??
          this.researchFamilyAliases.get(result.seedMarketSlug),
        result.family.key,
      );

      for (const details of result.members) {
        this.familyDetailSnapshotSlugs.add(details.slug);
        this.detailsBySlug.set(details.slug, details);
        const researchFamily = preserveAdvisoryResearchFamily(
          this.candidateFamilyBySlug.get(details.slug) ??
            this.researchFamilyAliases.get(details.slug) ??
            seedResearchFamily,
          result.family.key,
        );
        this.candidateFamilyBySlug.set(details.slug, researchFamily);
        this.inspectedSlugs.add(details.slug);
        this.inspectedFamilies.add(researchFamily);
        const qualified =
          this.passResearchRequirements !== undefined &&
          mechanicallyQualifiedMarket(
            details,
            this.passResearchRequirements.maximumQualifiedSpread,
          );
        if (qualified) this.qualifiedSlugs.add(details.slug);
        this.recordInspected(details.slug, details, qualified);
        const marketLiveEvidenceSources =
          await this.registerSystemLiveEvidenceSources(details, signal);
        if (marketLiveEvidenceSources.length > 0) {
          liveEvidenceSourcesByMarket.push({
            marketSlug: details.slug,
            sources: marketLiveEvidenceSources,
          });
        }
        for (const source of marketLiveEvidenceSources) {
          liveEvidenceSources.set(source.url, source);
        }
      }

      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.marketFamilyDetailsSecurityNotice,
          marketFamily: result,
          ...(liveEvidenceSources.size === 0
            ? {}
            : { liveEvidenceSources: [...liveEvidenceSources.values()] }),
          ...(liveEvidenceSourcesByMarket.length === 0
            ? {}
            : { liveEvidenceSourcesByMarket }),
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "MARKET_FAMILY_DETAILS_FAILED",
        this.messages.marketFamilyDetailsFailed,
      );
    }
  }

  private async executeMarketAnalysis(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = MarketAnalysisInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidMarketAnalysisInput,
      );
    }
    if (
      this.marketAnalysisRequestCount >=
      this.limits.maximumMarketAnalysisRequests
    ) {
      return safeToolError(
        "TOOL_LIMIT_REACHED",
        "Maximum market-analysis request count reached. Do not call get_market_analysis again this cycle; use the completed analyses and submit the complete trade plan.",
      );
    }
    this.marketAnalysisRequestCount += 1;
    this.recordCall("get_market_analysis");
    if (this.marketAnalysisHandler === undefined) {
      return safeToolError(
        "MARKET_ANALYSIS_UNAVAILABLE",
        this.messages.marketAnalysisUnavailable,
      );
    }
    if (!this.detailsBySlug.has(parsed.data.marketSlug)) {
      return safeToolError(
        "MARKET_DETAILS_REQUIRED",
        this.messages.marketDetailsRequired,
      );
    }
    try {
      const analysis = await this.marketAnalysisHandler(parsed.data, signal);
      this.recordResearched(parsed.data.marketSlug);
      if (this.qualifiedSlugs.has(parsed.data.marketSlug)) {
        this.qualifiedAnalysisSlugs.add(parsed.data.marketSlug);
      }
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.marketAnalysisSecurityNotice,
          analysis,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "MARKET_ANALYSIS_FAILED",
        this.messages.marketAnalysisFailed,
      );
    }
  }

  private async executeTradePreview(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = TradePreviewInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidTradePreviewInput,
      );
    }
    if (this.tradePreviewCount >= this.limits.maximumTradePreviewRequests) {
      return safeToolError(
        "TOOL_LIMIT_REACHED",
        "Maximum trade-preview request count reached. Do not call preview_trade again this cycle; use the completed previews and submit the complete trade plan.",
      );
    }
    this.tradePreviewCount += 1;
    this.recordCall("preview_trade");
    if (this.tradePreviewHandler === undefined) {
      return safeToolError(
        "TRADE_PREVIEW_UNAVAILABLE",
        this.messages.tradePreviewUnavailable,
      );
    }
    if (!this.detailsBySlug.has(parsed.data.marketSlug)) {
      return safeToolError(
        "MARKET_DETAILS_REQUIRED",
        this.messages.marketDetailsRequired,
      );
    }
    try {
      const preview = await this.tradePreviewHandler(parsed.data, signal);
      this.recordPreviewed(parsed.data.marketSlug);
      if (this.qualifiedSlugs.has(parsed.data.marketSlug)) {
        this.qualifiedPreviewSlugs.add(parsed.data.marketSlug);
      }
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.tradePreviewSecurityNotice,
          preview,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "TRADE_PREVIEW_FAILED",
        this.messages.tradePreviewFailed,
      );
    }
  }

  private async executeAgentNotes(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = AgentNoteInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidAgentNoteInput,
      );
    }
    const persistentKnowledgeOperations =
      this.noteOperationCount + this.stateOperationCount;
    if (persistentKnowledgeOperations >= this.limits.maximumNoteOperations) {
      return safeToolError(
        "PERSISTENT_KNOWLEDGE_LIMIT_REACHED",
        this.messages.agentNotesFailed,
      );
    }
    this.noteOperationCount += 1;
    this.recordCall("manage_notes");
    if (this.agentNotesHandler === undefined) {
      return safeToolError(
        "AGENT_NOTES_UNAVAILABLE",
        this.messages.agentNotesUnavailable,
      );
    }
    try {
      signal.throwIfAborted();
      const result = await this.agentNotesHandler(parsed.data, signal);
      signal.throwIfAborted();
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.agentNotesSecurityNotice,
          ...result,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "AGENT_NOTES_FAILED",
        this.messages.agentNotesFailed,
      );
    }
  }

  private async executeAgentState(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const parsed = AgentStateInputSchema.safeParse(input);
    if (!parsed.success) {
      return safeToolError(
        "INVALID_TOOL_INPUT",
        this.messages.invalidAgentStateInput,
      );
    }
    const persistentKnowledgeOperations =
      this.noteOperationCount + this.stateOperationCount;
    if (persistentKnowledgeOperations >= this.limits.maximumNoteOperations) {
      return safeToolError(
        "PERSISTENT_KNOWLEDGE_LIMIT_REACHED",
        this.messages.agentStateFailed,
      );
    }
    this.stateOperationCount += 1;
    this.recordCall("manage_state");
    if (this.agentStateHandler === undefined) {
      return safeToolError(
        "AGENT_STATE_UNAVAILABLE",
        this.messages.agentStateUnavailable,
      );
    }
    try {
      signal.throwIfAborted();
      const result = await this.agentStateHandler(parsed.data, signal);
      signal.throwIfAborted();
      return {
        kind: "TOOL_RESULT",
        content: JSON.stringify({
          ok: true,
          securityNotice: this.messages.agentStateSecurityNotice,
          ...result,
        }),
        isError: false,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return safeToolError(
        "AGENT_STATE_FAILED",
        this.messages.agentStateFailed,
      );
    }
  }
}
