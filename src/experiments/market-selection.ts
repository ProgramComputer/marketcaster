import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import type { Market } from "../domain/market.js";
import type { MarketCatalog } from "../agent/discovery.js";
import {
  buildOpportunityBoard,
  type OpportunityBoardItem,
  type OpportunityBoardVariant,
  type SelectionExperimentDefinition,
} from "../agent/opportunity-board.js";
import { reportJsonReplacer } from "../reporting/artifact.js";

export const SelectionExperimentDefinitionSchema = z
  .object({
    experimentId: z.string().min(1),
    hypothesis: z.string().min(1),
    controlVariant: z.string().min(1),
    treatmentVariant: z.string().min(1),
    limitations: z.array(z.string()),
  })
  .strict();

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const EXPERIMENT_SCHEMA_VERSION = 1 as const;

const DecimalStringSchema = z.string().refine((value) => {
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}, "Expected a finite decimal string");

const IsoTimestampSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected an ISO timestamp",
  );

const FrozenFamilyScoutPolicySchema = z.object({
  enabled: z.boolean(),
  reservedPromptMarkets: z.number().int().nonnegative(),
  maximumFamilies: z.number().int().nonnegative(),
  maximumMembersPerFamily: z.number().int().positive(),
  minimumFamilyMembers: z.number().int().positive(),
  enrichmentRequestBudget: z.number().int().nonnegative().optional(),
  maximumMarketsPerCategory: z.number().int().positive().optional(),
  maximumClimateMarkets: z.number().int().nonnegative().optional(),
  scoringWeights: z.object({
    liquidityOrDepth: DecimalStringSchema,
    volume24h: DecimalStringSchema,
    uncertainty: DecimalStringSchema,
    exchangeRankQuality: DecimalStringSchema,
    cappedRecurrence: DecimalStringSchema,
  }),
});

const FrozenPolicySchema = z.object({
  opportunityBoardVariant: z.string().min(1),
  maximumPromptMarkets: z.number().int().positive(),
  minimumMinutesToClose: z.number().nonnegative(),
  maximumDaysToClose: z.number().positive(),
  maximumSpread: DecimalStringSchema,
  minimumLiquidityUsd: DecimalStringSchema,
  minimumVolume24hUsd: DecimalStringSchema,
  allowIfLiquidityOrVolumePasses: z.boolean(),
  familyScouts: FrozenFamilyScoutPolicySchema.optional(),
});

const FrozenMarketSchema = z.object({
  exchangeRank: z.number().int().positive(),
  held: z.boolean(),
  id: z.object({
    exchange: z.enum(["polymarket-us", "polymarket-international", "kalshi"]),
    value: z.string().min(1),
  }),
  slug: z.string().min(1),
  eventId: z.string().optional(),
  eventSlug: z.string().optional(),
  seriesId: z.string().optional(),
  seriesSlug: z.string().optional(),
  tags: z
    .array(
      z.object({
        id: z.string().optional(),
        slug: z.string(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  title: z.string(),
  hasSettlementRules: z.boolean(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  active: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean(),
  closesAt: IsoTimestampSchema.optional(),
  liquidity: DecimalStringSchema.optional(),
  volume: DecimalStringSchema.optional(),
  volume24h: DecimalStringSchema.optional(),
  lastPrice: DecimalStringSchema.optional(),
});

export const MarketSelectionSnapshotSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  frozenAt: IsoTimestampSchema,
  exchangeRankingBasis: z.enum(["VOLUME_DESC", "EXCHANGE_DEFAULT"]),
  warnings: z.array(z.string()),
  categoryCounts: z.record(z.string(), z.number().int().nonnegative()),
  policy: FrozenPolicySchema,
  markets: z.array(FrozenMarketSchema),
});

export type MarketSelectionSnapshot = z.infer<
  typeof MarketSelectionSnapshotSchema
>;

export interface MarketSelectionArmSummary {
  readonly selectionCount: number;
  readonly exchangeRankLaneCount: number;
  readonly familyScoutLaneCount: number;
  readonly prioritySignalCount: number;
  readonly medianHoursToClose: number | null;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly prioritySignalCounts: Readonly<Record<string, number>>;
}

export interface MarketSelectionExperimentArm {
  readonly variant: OpportunityBoardVariant;
  readonly summary: MarketSelectionArmSummary;
  readonly selections: readonly OpportunityBoardItem[];
}

export interface MarketSelectionExperimentReport {
  readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly hypothesis: string;
  readonly frozenAt: string;
  readonly mode: "PAIRED_SELECTION_REPLAY";
  readonly control: MarketSelectionExperimentArm;
  readonly treatment: MarketSelectionExperimentArm;
  readonly comparison: {
    readonly overlapCount: number;
    readonly unionCount: number;
    readonly jaccard: number;
    readonly controlOnlySlugs: readonly string[];
    readonly treatmentOnlySlugs: readonly string[];
  };
  readonly limitations: readonly string[];
}

export interface MarketSelectionTreatmentObservation {
  readonly actualTreatmentSlugs: readonly string[];
  readonly treatmentPrioritySlugs: readonly string[];
  readonly surfacedPrioritySlugs: readonly string[];
  readonly inspectedPrioritySlugs: readonly string[];
  readonly researchedPrioritySlugs: readonly string[];
  readonly previewedPrioritySlugs: readonly string[];
  readonly dispositionedPrioritySlugs: readonly string[];
  readonly proposedPrioritySlugs: readonly string[];
  readonly priorityInspectionRate: number | null;
  readonly priorityResearchRate: number | null;
  readonly priorityProposalRate: number | null;
}

function optionalDecimal(value: Decimal | undefined): string | undefined {
  return value?.toFixed();
}

function freezePolicy(
  policy: AgentConfig["marketSelection"],
): z.infer<typeof FrozenPolicySchema> {
  return {
    opportunityBoardVariant: policy.opportunityBoardVariant,
    maximumPromptMarkets: policy.maximumPromptMarkets,
    minimumMinutesToClose: policy.minimumMinutesToClose,
    maximumDaysToClose: policy.maximumDaysToClose,
    maximumSpread: policy.maximumSpread.toFixed(),
    minimumLiquidityUsd: policy.minimumLiquidityUsd.toFixed(),
    minimumVolume24hUsd: policy.minimumVolume24hUsd.toFixed(),
    allowIfLiquidityOrVolumePasses: policy.allowIfLiquidityOrVolumePasses,
    ...(policy.familyScouts === undefined
      ? {}
      : {
          familyScouts: {
            enabled: policy.familyScouts.enabled,
            reservedPromptMarkets: policy.familyScouts.reservedPromptMarkets,
            maximumFamilies: policy.familyScouts.maximumFamilies,
            maximumMembersPerFamily:
              policy.familyScouts.maximumMembersPerFamily,
            minimumFamilyMembers: policy.familyScouts.minimumFamilyMembers,
            ...(policy.familyScouts.enrichmentRequestBudget === undefined
              ? {}
              : {
                  enrichmentRequestBudget:
                    policy.familyScouts.enrichmentRequestBudget,
                }),
            ...(policy.familyScouts.maximumMarketsPerCategory === undefined
              ? {}
              : {
                  maximumMarketsPerCategory:
                    policy.familyScouts.maximumMarketsPerCategory,
                }),
            ...(policy.familyScouts.maximumClimateMarkets === undefined
              ? {}
              : {
                  maximumClimateMarkets:
                    policy.familyScouts.maximumClimateMarkets,
                }),
            scoringWeights: {
              liquidityOrDepth:
                policy.familyScouts.scoringWeights.liquidityOrDepth.toFixed(),
              volume24h: policy.familyScouts.scoringWeights.volume24h.toFixed(),
              uncertainty:
                policy.familyScouts.scoringWeights.uncertainty.toFixed(),
              exchangeRankQuality:
                policy.familyScouts.scoringWeights.exchangeRankQuality.toFixed(),
              cappedRecurrence:
                policy.familyScouts.scoringWeights.cappedRecurrence.toFixed(),
            },
          },
        }),
  };
}

function freezeMarket(
  market: Market,
  exchangeRank: number,
  held: boolean,
): z.infer<typeof FrozenMarketSchema> {
  return {
    exchangeRank,
    held,
    id: { ...market.id },
    slug: market.slug,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    ...(market.tags === undefined
      ? {}
      : { tags: market.tags.map((tag) => ({ ...tag })) }),
    title: market.title,
    hasSettlementRules: market.settlementRules.trim().length > 0,
    ...(market.category === undefined ? {} : { category: market.category }),
    ...(market.subcategory === undefined
      ? {}
      : { subcategory: market.subcategory }),
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    ...(market.closesAt === undefined
      ? {}
      : { closesAt: market.closesAt.toISOString() }),
    ...(optionalDecimal(market.liquidity) === undefined
      ? {}
      : { liquidity: optionalDecimal(market.liquidity) }),
    ...(optionalDecimal(market.volume) === undefined
      ? {}
      : { volume: optionalDecimal(market.volume) }),
    ...(optionalDecimal(market.volume24h) === undefined
      ? {}
      : { volume24h: optionalDecimal(market.volume24h) }),
    ...(optionalDecimal(market.lastPrice) === undefined
      ? {}
      : { lastPrice: optionalDecimal(market.lastPrice) }),
  };
}

export function freezeMarketSelectionSnapshot(
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  frozenAt: Date,
): MarketSelectionSnapshot {
  if (Number.isNaN(frozenAt.getTime())) {
    throw new TypeError("Market-selection snapshot time must be valid");
  }
  return MarketSelectionSnapshotSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    frozenAt: frozenAt.toISOString(),
    exchangeRankingBasis: catalog.exchangeRankingBasis,
    warnings: [...catalog.warnings],
    categoryCounts: { ...catalog.categoryCounts },
    policy: freezePolicy(policy),
    markets: catalog.markets.map((market, index) =>
      freezeMarket(
        market,
        catalog.exchangeRanks.get(market.slug) ?? index + 1,
        catalog.heldSlugs.has(market.slug),
      ),
    ),
  });
}

function date(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function decimal(value: string | undefined): Decimal | undefined {
  return value === undefined ? undefined : new Decimal(value);
}

function thawMarket(row: z.infer<typeof FrozenMarketSchema>): Market {
  const closesAt = date(row.closesAt);
  const liquidity = decimal(row.liquidity);
  const volume = decimal(row.volume);
  const volume24h = decimal(row.volume24h);
  const lastPrice = decimal(row.lastPrice);
  return {
    id: { exchange: row.id.exchange, value: row.id.value },
    slug: row.slug,
    ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
    ...(row.eventSlug === undefined ? {} : { eventSlug: row.eventSlug }),
    ...(row.seriesId === undefined ? {} : { seriesId: row.seriesId }),
    ...(row.seriesSlug === undefined ? {} : { seriesSlug: row.seriesSlug }),
    ...(row.tags === undefined
      ? {}
      : {
          tags: row.tags.map((tag) => ({
            slug: tag.slug,
            ...(tag.id === undefined ? {} : { id: tag.id }),
            ...(tag.label === undefined ? {} : { label: tag.label }),
          })),
        }),
    title: row.title,
    description: "",
    settlementRules: row.hasSettlementRules
      ? "Present in frozen market-selection snapshot"
      : "",
    ...(row.category === undefined ? {} : { category: row.category }),
    ...(row.subcategory === undefined ? {} : { subcategory: row.subcategory }),
    active: row.active,
    closed: row.closed,
    archived: row.archived,
    ...(closesAt === undefined ? {} : { closesAt }),
    ...(liquidity === undefined ? {} : { liquidity }),
    ...(volume === undefined ? {} : { volume }),
    ...(volume24h === undefined ? {} : { volume24h }),
    ...(lastPrice === undefined ? {} : { lastPrice }),
    minimumTradeQuantity: new Decimal(1),
    priceTick: new Decimal("0.01"),
  };
}

function thawPolicy(
  value: z.infer<typeof FrozenPolicySchema>,
): AgentConfig["marketSelection"] {
  return {
    opportunityBoardVariant: value.opportunityBoardVariant,
    maximumPromptMarkets: value.maximumPromptMarkets,
    minimumMinutesToClose: value.minimumMinutesToClose,
    maximumDaysToClose: value.maximumDaysToClose,
    maximumSpread: new Decimal(value.maximumSpread),
    minimumLiquidityUsd: new Decimal(value.minimumLiquidityUsd),
    minimumVolume24hUsd: new Decimal(value.minimumVolume24hUsd),
    allowIfLiquidityOrVolumePasses: value.allowIfLiquidityOrVolumePasses,
    ...(value.familyScouts === undefined
      ? {}
      : {
          familyScouts: {
            ...value.familyScouts,
            scoringWeights: {
              liquidityOrDepth: new Decimal(
                value.familyScouts.scoringWeights.liquidityOrDepth,
              ),
              volume24h: new Decimal(
                value.familyScouts.scoringWeights.volume24h,
              ),
              uncertainty: new Decimal(
                value.familyScouts.scoringWeights.uncertainty,
              ),
              exchangeRankQuality: new Decimal(
                value.familyScouts.scoringWeights.exchangeRankQuality,
              ),
              cappedRecurrence: new Decimal(
                value.familyScouts.scoringWeights.cappedRecurrence,
              ),
            },
          },
        }),
  };
}

function thawSnapshot(snapshot: MarketSelectionSnapshot): {
  readonly catalog: MarketCatalog;
  readonly policy: AgentConfig["marketSelection"];
  readonly frozenAt: Date;
} {
  const parsed = MarketSelectionSnapshotSchema.parse(snapshot);
  const markets = parsed.markets.map(thawMarket);
  return {
    frozenAt: new Date(parsed.frozenAt),
    policy: thawPolicy(parsed.policy),
    catalog: {
      markets,
      bySlug: new Map(markets.map((market) => [market.slug, market])),
      exchangeRanks: new Map(
        parsed.markets.map((market) => [market.slug, market.exchangeRank]),
      ),
      heldSlugs: new Set(
        parsed.markets
          .filter((market) => market.held)
          .map((market) => market.slug),
      ),
      categoryCounts: { ...parsed.categoryCounts },
      exchangeRankingBasis: parsed.exchangeRankingBasis,
      warnings: [...parsed.warnings],
    },
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (right === undefined) return null;
  if (sorted.length % 2 === 1) return Number(right.toFixed(2));
  const left = sorted[middle - 1];
  return left === undefined ? null : Number(((left + right) / 2).toFixed(2));
}

function summarize(
  selections: readonly OpportunityBoardItem[],
  frozenAt: Date,
): MarketSelectionArmSummary {
  const categoryCounts: Record<string, number> = {};
  const prioritySignalCounts: Record<string, number> = {};
  const hoursToClose: number[] = [];
  for (const item of selections) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
    const hours = (Date.parse(item.closesAt) - frozenAt.getTime()) / 3_600_000;
    if (Number.isFinite(hours)) hoursToClose.push(hours);
    const signal = item.prioritySignal;
    if (signal === undefined) continue;
    const key = signal.kind;
    prioritySignalCounts[key] = (prioritySignalCounts[key] ?? 0) + 1;
  }
  return {
    selectionCount: selections.length,
    exchangeRankLaneCount: selections.filter(
      (item) => item.selectionLane === "EXCHANGE_RANK",
    ).length,
    familyScoutLaneCount: selections.filter(
      (item) => item.selectionLane === "FAMILY_SCOUT",
    ).length,
    prioritySignalCount: selections.filter(
      (item) => item.prioritySignal !== undefined,
    ).length,
    medianHoursToClose: median(hoursToClose),
    categoryCounts,
    prioritySignalCounts,
  };
}

function arm(
  buildBoard: typeof buildOpportunityBoard,
  variant: OpportunityBoardVariant,
  catalog: MarketCatalog,
  policy: AgentConfig["marketSelection"],
  frozenAt: Date,
): MarketSelectionExperimentArm {
  const selections = buildBoard(catalog, policy, frozenAt, variant);
  return {
    variant,
    summary: summarize(selections, frozenAt),
    selections,
  };
}

export function replayMarketSelectionExperiment(
  snapshot: MarketSelectionSnapshot,
  definition: SelectionExperimentDefinition,
  buildBoard: typeof buildOpportunityBoard = buildOpportunityBoard,
): MarketSelectionExperimentReport {
  const { catalog, policy, frozenAt } = thawSnapshot(snapshot);
  const control = arm(
    buildBoard,
    definition.controlVariant,
    catalog,
    policy,
    frozenAt,
  );
  const treatment = arm(
    buildBoard,
    definition.treatmentVariant,
    catalog,
    policy,
    frozenAt,
  );
  const controlSlugs = new Set(control.selections.map((item) => item.slug));
  const treatmentSlugs = new Set(treatment.selections.map((item) => item.slug));
  const overlap = [...controlSlugs].filter((slug) => treatmentSlugs.has(slug));
  const union = new Set([...controlSlugs, ...treatmentSlugs]);
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: definition.experimentId,
    hypothesis: definition.hypothesis,
    frozenAt: frozenAt.toISOString(),
    mode: "PAIRED_SELECTION_REPLAY",
    control,
    treatment,
    comparison: {
      overlapCount: overlap.length,
      unionCount: union.size,
      jaccard:
        union.size === 0 ? 1 : Number((overlap.length / union.size).toFixed(6)),
      controlOnlySlugs: [...controlSlugs].filter(
        (slug) => !treatmentSlugs.has(slug),
      ),
      treatmentOnlySlugs: [...treatmentSlugs].filter(
        (slug) => !controlSlugs.has(slug),
      ),
    },
    limitations: [...definition.limitations],
  };
}

function intersection(
  ordered: readonly string[],
  observed: ReadonlySet<string>,
): readonly string[] {
  return ordered.filter((slug) => observed.has(slug));
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0
    ? null
    : Number((numerator / denominator).toFixed(6));
}

export function observeMarketSelectionTreatment(input: {
  readonly actualTreatment: readonly OpportunityBoardItem[];
  readonly surfaced: ReadonlySet<string>;
  readonly inspected: ReadonlySet<string>;
  readonly researched: ReadonlySet<string>;
  readonly previewed: ReadonlySet<string>;
  readonly dispositioned: ReadonlySet<string>;
  readonly proposed: ReadonlySet<string>;
}): MarketSelectionTreatmentObservation {
  const actualTreatmentSlugs = input.actualTreatment.map((item) => item.slug);
  const treatmentPrioritySlugs = input.actualTreatment
    .filter((item) => item.prioritySignal !== undefined)
    .map((item) => item.slug);
  const surfacedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.surfaced,
  );
  const inspectedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.inspected,
  );
  const researchedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.researched,
  );
  const previewedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.previewed,
  );
  const dispositionedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.dispositioned,
  );
  const proposedPrioritySlugs = intersection(
    treatmentPrioritySlugs,
    input.proposed,
  );
  return {
    actualTreatmentSlugs,
    treatmentPrioritySlugs,
    surfacedPrioritySlugs,
    inspectedPrioritySlugs,
    researchedPrioritySlugs,
    previewedPrioritySlugs,
    dispositionedPrioritySlugs,
    proposedPrioritySlugs,
    priorityInspectionRate: rate(
      inspectedPrioritySlugs.length,
      treatmentPrioritySlugs.length,
    ),
    priorityResearchRate: rate(
      researchedPrioritySlugs.length,
      treatmentPrioritySlugs.length,
    ),
    priorityProposalRate: rate(
      proposedPrioritySlugs.length,
      treatmentPrioritySlugs.length,
    ),
  };
}

const ArtifactEnvelopeSchema = z.object({
  kind: z.literal("market-selection-snapshot"),
  data: MarketSelectionSnapshotSchema,
});

export async function replayMarketSelectionArtifact(
  artifactPath: string,
  definition: SelectionExperimentDefinition,
  buildBoard: typeof buildOpportunityBoard = buildOpportunityBoard,
): Promise<MarketSelectionExperimentReport> {
  const raw: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
  const parsed = ArtifactEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(
      `Invalid market-selection snapshot artifact: ${z.prettifyError(parsed.error)}`,
    );
  }
  return replayMarketSelectionExperiment(
    parsed.data.data,
    definition,
    buildBoard,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const artifactPath = argv[2];
  const definitionPath = argv[3];
  if (artifactPath === undefined || definitionPath === undefined) {
    process.stderr.write(
      "Usage: node dist/src/experiments/market-selection.js <market-selection-snapshot.json> <experiment-definition.json>\n",
    );
    return 2;
  }
  try {
    const definition = SelectionExperimentDefinitionSchema.parse(
      JSON.parse(await readFile(definitionPath, "utf8")),
    );
    const report = await replayMarketSelectionArtifact(
      artifactPath,
      definition,
    );
    process.stdout.write(`${JSON.stringify(report, reportJsonReplacer, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Market-selection replay failed"}\n`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await main(process.argv);
}
