import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  DecimalInputSchema,
  NonNegativeDecimalSchema,
} from "../domain/primitives.js";

const FractionSchema = DecimalInputSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a fraction between zero and one",
);

const PositiveIntegerSchema = z.number().int().positive();

const FamilyScoutConfigSchema = z
  .object({
    enabled: z.boolean(),
    reservedPromptMarkets: z.number().int().nonnegative().max(100),
    maximumFamilies: PositiveIntegerSchema.max(50),
    maximumMembersPerFamily: PositiveIntegerSchema.max(10),
    minimumFamilyMembers: PositiveIntegerSchema.max(30),
    enrichmentRequestBudget: z.number().int().nonnegative().max(24).optional(),
    maximumMarketsPerCategory: PositiveIntegerSchema.max(100).optional(),
    maximumClimateMarkets: z.number().int().nonnegative().max(100).optional(),
  })
  .strict();

const AgentMemoryConfigSchema = z
  .object({
    enabled: z.boolean(),
    maximumNotes: PositiveIntegerSchema.max(500),
    maximumContextNotes: PositiveIntegerSchema.max(100),
    maximumNoteCharacters: PositiveIntegerSchema.max(4_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maximumContextNotes > value.maximumNotes) {
      context.addIssue({
        code: "custom",
        path: ["maximumContextNotes"],
        message: "maximumContextNotes cannot exceed maximumNotes",
      });
    }
  });

const AgentStateConfigSchema = z
  .object({
    enabled: z.boolean(),
    maximumBeliefs: PositiveIntegerSchema.max(500),
    maximumContextBeliefs: PositiveIntegerSchema.max(100),
    maximumBeliefCharacters: PositiveIntegerSchema.max(4_000),
    maximumPlanCharacters: PositiveIntegerSchema.max(8_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maximumContextBeliefs > value.maximumBeliefs) {
      context.addIssue({
        code: "custom",
        path: ["maximumContextBeliefs"],
        message: "maximumContextBeliefs cannot exceed maximumBeliefs",
      });
    }
  });

const PassResearchConfigSchema = z
  .object({
    minimumDiscoveryRequests: z.number().int().nonnegative().max(20),
    minimumDistinctDiscoveryModes: z.number().int().nonnegative().max(10),
    minimumInspectedMarkets: z.number().int().nonnegative().max(25),
    minimumDistinctEventFamilies: z.number().int().nonnegative().max(25),
    minimumWebSearches: z.number().int().nonnegative().max(25),
    minimumMarketAnalyses: z.number().int().nonnegative().max(20),
    minimumTradePreviews: z.number().int().nonnegative().max(12),
  })
  .strict();

const FamilyScoutScoringWeightsSchema = z
  .object({
    liquidityOrDepth: FractionSchema,
    volume24h: FractionSchema,
    uncertainty: FractionSchema,
    exchangeRankQuality: FractionSchema,
    cappedRecurrence: FractionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const total = value.liquidityOrDepth
      .plus(value.volume24h)
      .plus(value.uncertainty)
      .plus(value.exchangeRankQuality)
      .plus(value.cappedRecurrence);
    if (!total.eq(1)) {
      context.addIssue({
        code: "custom",
        message: "Family-scout scoring weights must sum to one",
      });
    }
  });

export const RepositoryConfigSchema = z
  .object({
    cycle: z
      .object({
        timeoutSeconds: PositiveIntegerSchema,
        stageBudgetsSeconds: z
          .object({
            marketDiscovery: PositiveIntegerSchema,
            agentResearch: PositiveIntegerSchema,
            validationExecution: PositiveIntegerSchema,
            reconciliationReporting: PositiveIntegerSchema,
          })
          .strict(),
      })
      .strict(),
    marketSelection: z
      .object({
        opportunityBoardVariant: z.enum([
          "GENERALIST_CONTROL",
          "RESOLVER_LAG_TREATMENT",
        ]),
        maximumPromptMarkets: PositiveIntegerSchema,
        minimumMinutesToClose: z.number().nonnegative(),
        maximumDaysToClose: z.number().positive(),
        maximumSpread: FractionSchema,
        minimumLiquidityUsd: NonNegativeDecimalSchema,
        minimumVolume24hUsd: NonNegativeDecimalSchema,
        allowIfLiquidityOrVolumePasses: z.boolean(),
        familyScouts: FamilyScoutConfigSchema.extend({
          scoringWeights: FamilyScoutScoringWeightsSchema,
        }).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.familyScouts !== undefined &&
          value.familyScouts.reservedPromptMarkets > value.maximumPromptMarkets
        ) {
          context.addIssue({
            code: "custom",
            path: ["familyScouts", "reservedPromptMarkets"],
            message: "reservedPromptMarkets cannot exceed maximumPromptMarkets",
          });
        }
      }),
    agent: z
      .object({
        maximumRounds: PositiveIntegerSchema.max(40),
        maximumWebSearches: z.number().int().nonnegative().max(25),
        maximumProviderWebSearchesPerResponse: PositiveIntegerSchema.max(2),
        maximumEvidenceSourceReadRequests: z
          .number()
          .int()
          .nonnegative()
          .max(16),
        maximumMarketDiscoveryRequests: z.number().int().nonnegative().max(20),
        maximumMarketDetailRequests: z.number().int().nonnegative().max(25),
        maximumMarketAnalysisRequests: z.number().int().nonnegative().max(20),
        maximumTradePreviewRequests: z.number().int().nonnegative().max(12),
        maximumNoteOperations: z.number().int().nonnegative().max(20),
        passResearch: PassResearchConfigSchema,
        memory: AgentMemoryConfigSchema,
        state: AgentStateConfigSchema,
        timeoutSeconds: PositiveIntegerSchema.max(1_500),
      })
      .strict(),
    risk: z
      .object({
        maximumPositionCostBasisFraction: FractionSchema,
        maximumCycleSpendFraction: FractionSchema,
        maximumExecutionSpread: FractionSchema,
        kellyFraction: FractionSchema,
        uncertaintyBoundWeight: FractionSchema,
        duplicateWindowMinutes: PositiveIntegerSchema,
        minimumIndependentSources: z.number().int().nonnegative(),
        allowNakedShorts: z.literal(false),
        emergencyExitEnabled: z.boolean(),
      })
      .strict(),
    exchange: z
      .object({
        maximumConcurrentRequests: PositiveIntegerSchema.max(20),
        targetRequestsPerSecond: PositiveIntegerSchema.max(20),
        maximumGetRetries: z.number().int().nonnegative(),
        baseRetryDelayMilliseconds: PositiveIntegerSchema,
        maximumRetryDelayMilliseconds: PositiveIntegerSchema,
        activityLookbackDays: PositiveIntegerSchema,
        cleanupUnexpectedOpenOrders: z.literal(false),
      })
      .strict(),
    reporting: z
      .object({
        directory: z.string().min(1),
        shadowLedger: z
          .object({
            enabled: z.boolean(),
            maximumObservationsPerCycle: PositiveIntegerSchema.max(50),
            maximumSettlementChecksPerCycle: PositiveIntegerSchema.max(100),
            maximumMarkChecksPerCycle: z.number().int().nonnegative().max(100),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const stageBudget = Object.values(value.cycle.stageBudgetsSeconds).reduce(
      (total, seconds) => total + seconds,
      0,
    );
    if (value.cycle.timeoutSeconds > stageBudget) {
      context.addIssue({
        code: "custom",
        path: ["cycle", "timeoutSeconds"],
        message: "Cycle timeout cannot exceed the combined stage budgets",
      });
    }
    if (
      value.exchange.baseRetryDelayMilliseconds >
      value.exchange.maximumRetryDelayMilliseconds
    ) {
      context.addIssue({
        code: "custom",
        path: ["exchange", "baseRetryDelayMilliseconds"],
        message: "Base retry delay cannot exceed the retry delay cap",
      });
    }
    const passResearchBounds = [
      [
        "minimumDiscoveryRequests",
        value.agent.passResearch.minimumDiscoveryRequests,
        value.agent.maximumMarketDiscoveryRequests,
      ],
      [
        "minimumInspectedMarkets",
        value.agent.passResearch.minimumInspectedMarkets,
        value.agent.maximumMarketDetailRequests,
      ],
      [
        "minimumDistinctEventFamilies",
        value.agent.passResearch.minimumDistinctEventFamilies,
        value.agent.maximumMarketDetailRequests,
      ],
      [
        "minimumWebSearches",
        value.agent.passResearch.minimumWebSearches,
        value.agent.maximumWebSearches,
      ],
      [
        "minimumMarketAnalyses",
        value.agent.passResearch.minimumMarketAnalyses,
        value.agent.maximumMarketAnalysisRequests,
      ],
      [
        "minimumTradePreviews",
        value.agent.passResearch.minimumTradePreviews,
        value.agent.maximumTradePreviewRequests,
      ],
    ] as const;
    for (const [field, minimum, maximum] of passResearchBounds) {
      if (minimum > maximum) {
        context.addIssue({
          code: "custom",
          path: ["agent", "passResearch", field],
          message: `${field} cannot exceed its corresponding agent tool limit`,
        });
      }
    }
    if (
      value.agent.passResearch.minimumDistinctDiscoveryModes >
      value.agent.passResearch.minimumDiscoveryRequests
    ) {
      context.addIssue({
        code: "custom",
        path: ["agent", "passResearch", "minimumDistinctDiscoveryModes"],
        message:
          "minimumDistinctDiscoveryModes cannot exceed minimumDiscoveryRequests",
      });
    }
    if (
      value.agent.passResearch.minimumDistinctEventFamilies >
      value.agent.passResearch.minimumInspectedMarkets
    ) {
      context.addIssue({
        code: "custom",
        path: ["agent", "passResearch", "minimumDistinctEventFamilies"],
        message:
          "minimumDistinctEventFamilies cannot exceed minimumInspectedMarkets",
      });
    }
    if (value.agent.state.enabled && value.agent.maximumNoteOperations < 1) {
      context.addIssue({
        code: "custom",
        path: ["agent", "maximumNoteOperations"],
        message:
          "maximumNoteOperations must reserve at least one next-cycle plan operation when structured state is enabled",
      });
    }
  });

export type AgentConfig = z.infer<typeof RepositoryConfigSchema>;

export async function loadRepositoryConfig(
  path = resolve(process.cwd(), "config", "default.json"),
): Promise<AgentConfig> {
  const contents = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in configuration file ${path}`, {
      cause: error,
    });
  }
  return RepositoryConfigSchema.parse(raw);
}
