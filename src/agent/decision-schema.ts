import { Decimal } from "decimal.js";
import { z } from "zod";
import { DecisionEvidenceSchema } from "./decision-evidence.js";
import {
  EvidenceBundleCollectionSchema,
  EvidenceBundleIdsSchema,
  collectEvidenceBundleReferenceIssues,
  resolveEvidenceForProposals,
} from "./evidence-bundles.js";

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const DecimalStringSchema = z
  .string()
  .trim()
  .regex(DECIMAL_PATTERN, "Expected a base-10 decimal string")
  .refine((value) => new Decimal(value).isFinite(), "Expected a finite decimal")
  .transform((value) => new Decimal(value));

/**
 * Canonical decisions already contain Decimal instances. Accepting both the
 * serialized and canonical representations makes schema validation
 * idempotent without accepting JavaScript numbers or coercing arbitrary
 * values at the model-controlled boundary.
 */
const DecimalSchema = z.union([
  DecimalStringSchema,
  z
    .instanceof(Decimal)
    .refine((value) => value.isFinite(), "Expected a finite decimal"),
]);

const ProbabilitySchema = DecimalSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a probability between zero and one",
);

const PriceSchema = DecimalSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a price between zero and one",
);

const MaximumRiskSchema = DecimalSchema.refine(
  (value) => value.gte(0),
  "Expected a non-negative risk amount",
);

const CostBasisFractionSchema = DecimalSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a cost-basis fraction between zero and one",
);

export { DecisionEvidenceSchema } from "./decision-evidence.js";
export type { DecisionEvidence } from "./decision-evidence.js";

export const TradeProposalSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    estimatedProbability: ProbabilitySchema,
    maximumEntryPrice: PriceSchema.optional(),
    minimumExitPrice: PriceSchema.optional(),
    maximumRiskUsd: MaximumRiskSchema,
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string().trim().min(1).max(4000),
    settlementVerification: z.string().trim().min(1).max(2000),
    invalidationConditions: z.string().trim().min(1).max(2000),
    evidence: z.array(DecisionEvidenceSchema).max(10),
    evidenceBundleIds: EvidenceBundleIdsSchema.optional(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.action === "BUY" && proposal.minimumExitPrice !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["minimumExitPrice"],
        message: "BUY proposals cannot set minimumExitPrice",
      });
    }
    if (
      proposal.action === "SELL" &&
      proposal.maximumEntryPrice !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumEntryPrice"],
        message: "SELL proposals cannot set maximumEntryPrice",
      });
    }
  });

export const PortfolioTargetSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    targetCostBasisFraction: CostBasisFractionSchema,
    estimatedProbability: ProbabilitySchema,
    probabilityLowerBound: ProbabilitySchema,
    probabilityUpperBound: ProbabilitySchema,
    maximumEntryPrice: PriceSchema.optional(),
    minimumExitPrice: PriceSchema.optional(),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string().trim().min(1).max(4000),
    settlementVerification: z.string().trim().min(1).max(2000),
    invalidationConditions: z.string().trim().min(1).max(2000),
    evidence: z.array(DecisionEvidenceSchema).max(10),
    evidenceBundleIds: EvidenceBundleIdsSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.probabilityLowerBound.gt(target.estimatedProbability)) {
      context.addIssue({
        code: "custom",
        path: ["probabilityLowerBound"],
        message: "probabilityLowerBound cannot exceed estimatedProbability",
      });
    }
    if (target.estimatedProbability.gt(target.probabilityUpperBound)) {
      context.addIssue({
        code: "custom",
        path: ["probabilityUpperBound"],
        message: "probabilityUpperBound cannot be below estimatedProbability",
      });
    }
  });

export const CandidateDispositionSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]).nullable().optional(),
    outcome: z.enum(["HOLD_UNCHANGED", "PASS"]),
    reasonCode: z.enum([
      "NO_POSITIVE_EDGE",
      "INSUFFICIENT_CURRENT_EVIDENCE",
      "RISK_OR_CORRELATION_LIMIT",
      "MARKET_STRUCTURE",
      "SETTLEMENT_AMBIGUITY",
    ]),
    rationale: z.string().trim().min(1).max(4_000),
    estimatedProbability: ProbabilitySchema.nullable().optional(),
    probabilityLowerBound: ProbabilitySchema.nullable().optional(),
    probabilityUpperBound: ProbabilitySchema.nullable().optional(),
    evidence: z.array(DecisionEvidenceSchema).max(10),
    evidenceBundleIds: EvidenceBundleIdsSchema.optional(),
  })
  .strict()
  .superRefine((disposition, context) => {
    const probabilities = [
      disposition.estimatedProbability,
      disposition.probabilityLowerBound,
      disposition.probabilityUpperBound,
    ];
    const defined = probabilities.filter(
      (value) => value !== undefined && value !== null,
    );
    if (defined.length !== 0 && defined.length !== 3) {
      context.addIssue({
        code: "custom",
        path: ["estimatedProbability"],
        message:
          "Disposition probabilities must be supplied as a complete triplet",
      });
    }
    if (disposition.reasonCode === "NO_POSITIVE_EDGE" && defined.length !== 3) {
      context.addIssue({
        code: "custom",
        path: ["estimatedProbability"],
        message: "NO_POSITIVE_EDGE requires a probability triplet",
      });
    }
    if (defined.length === 3) {
      const estimate = disposition.estimatedProbability;
      const lower = disposition.probabilityLowerBound;
      const upper = disposition.probabilityUpperBound;
      if (
        estimate !== undefined &&
        estimate !== null &&
        lower !== undefined &&
        lower !== null &&
        upper !== undefined &&
        upper !== null
      ) {
        if (lower.gt(estimate)) {
          context.addIssue({
            code: "custom",
            path: ["probabilityLowerBound"],
            message: "probabilityLowerBound cannot exceed estimatedProbability",
          });
        }
        if (estimate.gt(upper)) {
          context.addIssue({
            code: "custom",
            path: ["probabilityUpperBound"],
            message:
              "probabilityUpperBound cannot be below estimatedProbability",
          });
        }
      }
    }
  });

const PortfolioTargetCollectionSchema = z
  .array(PortfolioTargetSchema)
  .max(100)
  .superRefine((targets, context) => {
    const firstIndexByMarketSlug = new Map<string, number>();
    targets.forEach((target, index) => {
      const firstIndex = firstIndexByMarketSlug.get(target.marketSlug);
      if (firstIndex === undefined) {
        firstIndexByMarketSlug.set(target.marketSlug, index);
        return;
      }
      context.addIssue({
        code: "custom",
        path: [index, "marketSlug"],
        message: `Duplicate portfolio target for marketSlug "${target.marketSlug}"; first declared at index ${firstIndex}`,
      });
    });
  });

const CandidateDispositionCollectionSchema = z
  .array(CandidateDispositionSchema)
  .max(100)
  .superRefine((dispositions, context) => {
    const firstIndexByMarketSlug = new Map<string, number>();
    dispositions.forEach((disposition, index) => {
      const firstIndex = firstIndexByMarketSlug.get(disposition.marketSlug);
      if (firstIndex === undefined) {
        firstIndexByMarketSlug.set(disposition.marketSlug, index);
        return;
      }
      context.addIssue({
        code: "custom",
        path: [index, "marketSlug"],
        message: `Duplicate candidate disposition for marketSlug "${disposition.marketSlug}"; first declared at index ${firstIndex}`,
      });
    });
  });

export const AgentDecisionSchema = z
  .object({
    cycleSummary: z.string().trim().min(1).max(5000),
    evidenceBundles: EvidenceBundleCollectionSchema.optional(),
    portfolioTargets: PortfolioTargetCollectionSchema.default([]),
    candidateDispositions: CandidateDispositionCollectionSchema.default([]),
    proposals: z.array(TradeProposalSchema).default([]),
  })
  .strict()
  .superRefine((decision, context) => {
    const proposalCount = decision.proposals.length;
    const targetCount = decision.portfolioTargets.length;
    // Legacy model-authored proposals must carry explicit price limits. A
    // materialized portfolio-target decision also contains derived proposals,
    // whose immediate price guards are intentionally calculated later from a
    // fresh book. Allow the latter to serialize and replay without weakening
    // the legacy model boundary; mixed target/proposal decisions are rejected
    // by materialization before execution.
    if (targetCount === 0) {
      decision.proposals.forEach((proposal, index) => {
        if (
          proposal.action === "BUY" &&
          proposal.maximumEntryPrice === undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["proposals", index, "maximumEntryPrice"],
            message: "BUY proposals require maximumEntryPrice",
          });
        }
        if (
          proposal.action === "SELL" &&
          proposal.minimumExitPrice === undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["proposals", index, "minimumExitPrice"],
            message: "SELL proposals require minimumExitPrice",
          });
        }
      });
    }
    const issues = collectEvidenceBundleReferenceIssues(
      decision.evidenceBundles ?? [],
      [
        ...decision.proposals.map((proposal) => ({
          evidence: proposal.evidence,
          evidenceBundleIds: proposal.evidenceBundleIds ?? [],
        })),
        ...decision.portfolioTargets.map((target) => ({
          evidence: target.evidence,
          evidenceBundleIds: target.evidenceBundleIds ?? [],
        })),
        ...decision.candidateDispositions.map((disposition) => ({
          evidence: disposition.evidence,
          evidenceBundleIds: disposition.evidenceBundleIds ?? [],
        })),
      ],
    );
    for (const issue of issues) {
      const path = [...issue.path];
      let message = issue.message;
      if (
        path[0] === "proposals" &&
        typeof path[1] === "number" &&
        path[1] >= proposalCount
      ) {
        const combinedIndex = path[1];
        if (combinedIndex < proposalCount + targetCount) {
          const targetIndex = combinedIndex - proposalCount;
          path[0] = "portfolioTargets";
          path[1] = targetIndex;
          message = message.replace(
            `Proposal ${combinedIndex}`,
            `Portfolio target ${targetIndex}`,
          );
        } else {
          const dispositionIndex = combinedIndex - proposalCount - targetCount;
          path[0] = "candidateDispositions";
          path[1] = dispositionIndex;
          message = message.replace(
            `Proposal ${combinedIndex}`,
            `Candidate disposition ${dispositionIndex}`,
          );
        }
      }
      context.addIssue({
        code: "custom",
        path,
        message,
      });
    }
  });

export type TradeProposal = z.infer<typeof TradeProposalSchema>;
export type PortfolioTarget = z.infer<typeof PortfolioTargetSchema>;
export type CandidateDisposition = z.infer<typeof CandidateDispositionSchema>;
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

function deduplicateEquivalentEvidenceClaims(
  evidence: readonly z.infer<typeof DecisionEvidenceSchema>[],
): readonly z.infer<typeof DecisionEvidenceSchema>[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const identity = JSON.stringify([
      item.url,
      item.evidenceClass,
      item.claimExcerpt ?? null,
      item.claimEventYear ?? null,
      item.publishedAt ?? null,
      item.asOf ?? null,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Provider-facing JSON Schema. Strict-output APIs require every property to be
 * listed in `required`; nullable wire fields are normalized away before the
 * canonical Zod schema is applied.
 */
const AgentDecisionModelJsonSchemaWithDispositions = {
  type: "object",
  additionalProperties: false,
  properties: {
    cycleSummary: { type: "string", minLength: 1, maxLength: 1000 },
    evidenceBundles: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          },
          familyKey: { type: "string", minLength: 1, maxLength: 500 },
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 500 },
                url: { type: "string", format: "uri" },
                evidenceClass: {
                  type: "string",
                  enum: ["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"],
                },
                claimExcerpt: { type: ["string", "null"], maxLength: 2000 },
                claimEventYear: {
                  type: ["integer", "null"],
                  minimum: 1900,
                  maximum: 2200,
                },
                publishedAt: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                asOf: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                relevance: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2000,
                },
              },
              required: [
                "title",
                "url",
                "evidenceClass",
                "claimExcerpt",
                "claimEventYear",
                "publishedAt",
                "asOf",
                "relevance",
              ],
            },
          },
        },
        required: ["id", "familyKey", "sources"],
      },
    },
    portfolioTargets: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          marketSlug: { type: "string", minLength: 1, maxLength: 500 },
          side: {
            type: "string",
            enum: ["YES", "NO"],
            description:
              "Selected contract side. All probability fields on this target are P(this side), not always P(YES).",
          },
          targetCostBasisFraction: {
            type: "string",
            pattern: DECIMAL_PATTERN.source,
          },
          estimatedProbability: {
            type: "string",
            pattern: DECIMAL_PATTERN.source,
            description:
              "Point estimate of P(selected side). For side NO, convert a YES probability q to 1-q before recording it.",
          },
          probabilityLowerBound: {
            type: "string",
            pattern: DECIMAL_PATTERN.source,
            description:
              "Lower bound for P(selected side), after normalizing every source to that same side.",
          },
          probabilityUpperBound: {
            type: "string",
            pattern: DECIMAL_PATTERN.source,
            description:
              "Upper bound for P(selected side), after normalizing every source to that same side.",
          },
          maximumEntryPrice: {
            type: ["string", "null"],
            pattern: DECIMAL_PATTERN.source,
          },
          minimumExitPrice: {
            type: ["string", "null"],
            pattern: DECIMAL_PATTERN.source,
          },
          confidence: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH"],
          },
          thesis: { type: "string", minLength: 1, maxLength: 4000 },
          settlementVerification: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
          },
          invalidationConditions: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
          },
          evidence: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 500 },
                url: { type: "string", format: "uri" },
                evidenceClass: {
                  type: "string",
                  enum: ["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"],
                },
                claimExcerpt: { type: ["string", "null"], maxLength: 2000 },
                claimEventYear: {
                  type: ["integer", "null"],
                  minimum: 1900,
                  maximum: 2200,
                },
                publishedAt: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                asOf: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                relevance: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2000,
                },
              },
              required: [
                "title",
                "url",
                "evidenceClass",
                "claimExcerpt",
                "claimEventYear",
                "publishedAt",
                "asOf",
                "relevance",
              ],
            },
          },
          evidenceBundleIds: {
            type: "array",
            maxItems: 20,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
            },
          },
        },
        required: [
          "marketSlug",
          "side",
          "targetCostBasisFraction",
          "estimatedProbability",
          "probabilityLowerBound",
          "probabilityUpperBound",
          "maximumEntryPrice",
          "minimumExitPrice",
          "confidence",
          "thesis",
          "settlementVerification",
          "invalidationConditions",
          "evidence",
          "evidenceBundleIds",
        ],
      },
    },
    candidateDispositions: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          marketSlug: { type: "string", minLength: 1, maxLength: 500 },
          side: {
            type: ["string", "null"],
            enum: ["YES", "NO", null],
            description:
              "Selected contract side. When non-null, all probability fields on this disposition are P(this side), not always P(YES).",
          },
          outcome: { type: "string", enum: ["HOLD_UNCHANGED", "PASS"] },
          reasonCode: {
            type: "string",
            description:
              "NO_POSITIVE_EDGE requires all three probability fields and is valid only when the policy-adjusted authorization probability does not beat the latest executable price plus conservative per-contract fees. Cash preservation, an unrelated fully sized holding, or calling a trade subordinate does not make positive edge non-positive. Use the specific settlement, evidence, correlation, or market-structure reason when that constraint blocks entry. Use INSUFFICIENT_CURRENT_EVIDENCE with null probability fields when required current evidence is unavailable or fails deterministic verification, so a defensible authorization range cannot be established.",
            enum: [
              "NO_POSITIVE_EDGE",
              "INSUFFICIENT_CURRENT_EVIDENCE",
              "RISK_OR_CORRELATION_LIMIT",
              "MARKET_STRUCTURE",
              "SETTLEMENT_AMBIGUITY",
            ],
          },
          rationale: { type: "string", minLength: 1, maxLength: 4000 },
          estimatedProbability: {
            type: ["string", "null"],
            pattern: DECIMAL_PATTERN.source,
            description:
              "P(selected side), not always P(YES). For side NO, convert a YES probability q to 1-q. Required and non-null with probabilityLowerBound and probabilityUpperBound when reasonCode is NO_POSITIVE_EDGE.",
          },
          probabilityLowerBound: {
            type: ["string", "null"],
            pattern: DECIMAL_PATTERN.source,
            description:
              "Lower bound for P(selected side), after normalizing every source to that same side. Required and non-null with estimatedProbability and probabilityUpperBound when reasonCode is NO_POSITIVE_EDGE.",
          },
          probabilityUpperBound: {
            type: ["string", "null"],
            pattern: DECIMAL_PATTERN.source,
            description:
              "Upper bound for P(selected side), after normalizing every source to that same side. Required and non-null with estimatedProbability and probabilityLowerBound when reasonCode is NO_POSITIVE_EDGE.",
          },
          evidence: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1, maxLength: 500 },
                url: { type: "string", format: "uri" },
                evidenceClass: {
                  type: "string",
                  enum: ["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"],
                },
                claimExcerpt: { type: ["string", "null"], maxLength: 2000 },
                claimEventYear: {
                  type: ["integer", "null"],
                  minimum: 1900,
                  maximum: 2200,
                },
                publishedAt: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                asOf: {
                  type: ["string", "null"],
                  format: "date-time",
                },
                relevance: {
                  type: "string",
                  minLength: 1,
                  maxLength: 2000,
                },
              },
              required: [
                "title",
                "url",
                "evidenceClass",
                "claimExcerpt",
                "claimEventYear",
                "publishedAt",
                "asOf",
                "relevance",
              ],
            },
          },
          evidenceBundleIds: {
            type: "array",
            maxItems: 20,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
            },
          },
        },
        required: [
          "marketSlug",
          "side",
          "outcome",
          "reasonCode",
          "rationale",
          "estimatedProbability",
          "probabilityLowerBound",
          "probabilityUpperBound",
          "evidence",
          "evidenceBundleIds",
        ],
      },
    },
  },
  required: [
    "cycleSummary",
    "evidenceBundles",
    "portfolioTargets",
    "candidateDispositions",
  ],
} as const;

// The terminal action is also the auditable decision boundary. Exposure,
// calibrated uncertainty, settlement reasoning, invalidation conditions, and
// the exact current evidence that authorizes a new order must remain together.
// This schema is byte-stable across rounds, so retaining those fields does not
// undermine provider prompt caching.
export const AgentDecisionModelJsonSchema =
  AgentDecisionModelJsonSchemaWithDispositions;

const ModelEvidenceSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    evidenceClass: z
      .enum(["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"])
      .optional(),
    claimExcerpt: z.string().nullable().optional(),
    claimEventYear: z.number().int().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    asOf: z.string().nullable().optional(),
    relevance: z.string(),
  })
  .strict();

const ModelEvidenceBundleSchema = z
  .object({
    id: z.string(),
    familyKey: z.string(),
    sources: z.array(ModelEvidenceSchema),
  })
  .strict();

const ModelProposalSchema = z
  .object({
    marketSlug: z.string(),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    estimatedProbability: z.string(),
    maximumEntryPrice: z.string().nullable().optional(),
    minimumExitPrice: z.string().nullable().optional(),
    maximumRiskUsd: z.string(),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string(),
    settlementVerification: z.string(),
    invalidationConditions: z.string(),
    evidence: z.array(ModelEvidenceSchema),
    evidenceBundleIds: z.array(z.string()).default([]),
  })
  .strict();

const ModelPortfolioTargetSchema = z
  .object({
    marketSlug: z.string(),
    side: z.enum(["YES", "NO"]),
    targetCostBasisFraction: z.string(),
    estimatedProbability: z.string(),
    probabilityLowerBound: z.string(),
    probabilityUpperBound: z.string(),
    maximumEntryPrice: z.string().nullable().optional(),
    minimumExitPrice: z.string().nullable().optional(),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string(),
    settlementVerification: z.string(),
    invalidationConditions: z.string(),
    evidence: z.array(ModelEvidenceSchema),
    evidenceBundleIds: z.array(z.string()).default([]),
  })
  .strict();

const ModelCandidateDispositionSchema = z
  .object({
    marketSlug: z.string(),
    side: z.enum(["YES", "NO"]).nullable().optional(),
    outcome: z.enum(["HOLD_UNCHANGED", "PASS"]),
    reasonCode: z.enum([
      "NO_POSITIVE_EDGE",
      "INSUFFICIENT_CURRENT_EVIDENCE",
      "RISK_OR_CORRELATION_LIMIT",
      "MARKET_STRUCTURE",
      "SETTLEMENT_AMBIGUITY",
    ]),
    rationale: z.string(),
    estimatedProbability: z.string().nullable().optional(),
    probabilityLowerBound: z.string().nullable().optional(),
    probabilityUpperBound: z.string().nullable().optional(),
    evidence: z.array(ModelEvidenceSchema),
    evidenceBundleIds: z.array(z.string()).default([]),
  })
  .strict();

const ModelDecisionSchema = z
  .object({
    cycleSummary: z.string(),
    evidenceBundles: z.array(ModelEvidenceBundleSchema).default([]),
    portfolioTargets: z.array(ModelPortfolioTargetSchema).default([]),
    candidateDispositions: z.array(ModelCandidateDispositionSchema).default([]),
    proposals: z.array(ModelProposalSchema).default([]),
  })
  .strict();

const LiveModelDecisionSchema = z
  .object({
    cycleSummary: z.string(),
    evidenceBundles: z.array(ModelEvidenceBundleSchema).default([]),
    portfolioTargets: z.array(ModelPortfolioTargetSchema),
    candidateDispositions: z.array(ModelCandidateDispositionSchema).default([]),
  })
  .strict();

export function parseAgentDecision(value: unknown): AgentDecision {
  const decision = AgentDecisionSchema.parse(value);
  const resolvedProposals = resolveEvidenceForProposals(
    decision.evidenceBundles ?? [],
    decision.proposals.map((proposal) => ({
      ...proposal,
      evidenceBundleIds: proposal.evidenceBundleIds ?? [],
    })),
  );
  const resolvedTargets = resolveEvidenceForProposals(
    decision.evidenceBundles ?? [],
    decision.portfolioTargets.map((target) => ({
      ...target,
      evidenceBundleIds: target.evidenceBundleIds ?? [],
    })),
  );
  const resolvedDispositions = resolveEvidenceForProposals(
    decision.evidenceBundles ?? [],
    decision.candidateDispositions.map((disposition) => ({
      ...disposition,
      evidenceBundleIds: disposition.evidenceBundleIds ?? [],
    })),
  );
  return {
    ...decision,
    proposals: decision.proposals.map((proposal, index) => ({
      ...proposal,
      evidence: [
        ...deduplicateEquivalentEvidenceClaims(
          resolvedProposals[index]?.resolvedEvidence ?? proposal.evidence,
        ),
      ],
    })),
    portfolioTargets: decision.portfolioTargets.map((target, index) => ({
      ...target,
      evidence: [
        ...deduplicateEquivalentEvidenceClaims(
          resolvedTargets[index]?.resolvedEvidence ?? target.evidence,
        ),
      ],
    })),
    candidateDispositions: decision.candidateDispositions.map(
      (disposition, index) => ({
        ...disposition,
        evidence: [
          ...deduplicateEquivalentEvidenceClaims(
            resolvedDispositions[index]?.resolvedEvidence ??
              disposition.evidence,
          ),
        ],
      }),
    ),
  };
}

function normalizeModelAgentDecision(
  wireDecision: z.infer<typeof ModelDecisionSchema>,
): AgentDecision {
  const normalizeEvidence = (item: z.infer<typeof ModelEvidenceSchema>) => ({
    title: item.title,
    url: item.url,
    ...(item.evidenceClass === undefined
      ? {}
      : { evidenceClass: item.evidenceClass }),
    ...(item.claimExcerpt === null || item.claimExcerpt === undefined
      ? {}
      : { claimExcerpt: item.claimExcerpt }),
    ...(item.claimEventYear === null || item.claimEventYear === undefined
      ? {}
      : { claimEventYear: item.claimEventYear }),
    ...(item.publishedAt === null || item.publishedAt === undefined
      ? {}
      : { publishedAt: item.publishedAt }),
    ...(item.asOf === null || item.asOf === undefined
      ? {}
      : { asOf: item.asOf }),
    relevance: item.relevance,
  });
  const normalized = {
    cycleSummary: wireDecision.cycleSummary,
    ...(wireDecision.evidenceBundles.length === 0
      ? {}
      : {
          evidenceBundles: wireDecision.evidenceBundles.map((bundle) => ({
            id: bundle.id,
            familyKey: bundle.familyKey,
            sources: bundle.sources.map(normalizeEvidence),
          })),
        }),
    portfolioTargets: wireDecision.portfolioTargets.map((target) => ({
      marketSlug: target.marketSlug,
      side: target.side,
      targetCostBasisFraction: target.targetCostBasisFraction,
      estimatedProbability: target.estimatedProbability,
      probabilityLowerBound: target.probabilityLowerBound,
      probabilityUpperBound: target.probabilityUpperBound,
      ...(target.maximumEntryPrice === null ||
      target.maximumEntryPrice === undefined
        ? {}
        : { maximumEntryPrice: target.maximumEntryPrice }),
      ...(target.minimumExitPrice === null ||
      target.minimumExitPrice === undefined
        ? {}
        : { minimumExitPrice: target.minimumExitPrice }),
      confidence: target.confidence,
      thesis: target.thesis,
      settlementVerification: target.settlementVerification,
      invalidationConditions: target.invalidationConditions,
      evidence: target.evidence.map(normalizeEvidence),
      ...(target.evidenceBundleIds.length === 0
        ? {}
        : { evidenceBundleIds: target.evidenceBundleIds }),
    })),
    candidateDispositions: wireDecision.candidateDispositions.map(
      (disposition) => ({
        marketSlug: disposition.marketSlug,
        ...(disposition.side === null || disposition.side === undefined
          ? {}
          : { side: disposition.side }),
        outcome: disposition.outcome,
        reasonCode: disposition.reasonCode,
        rationale: disposition.rationale,
        ...(disposition.estimatedProbability === null ||
        disposition.estimatedProbability === undefined
          ? {}
          : { estimatedProbability: disposition.estimatedProbability }),
        ...(disposition.probabilityLowerBound === null ||
        disposition.probabilityLowerBound === undefined
          ? {}
          : { probabilityLowerBound: disposition.probabilityLowerBound }),
        ...(disposition.probabilityUpperBound === null ||
        disposition.probabilityUpperBound === undefined
          ? {}
          : { probabilityUpperBound: disposition.probabilityUpperBound }),
        evidence: disposition.evidence.map(normalizeEvidence),
        ...(disposition.evidenceBundleIds.length === 0
          ? {}
          : { evidenceBundleIds: disposition.evidenceBundleIds }),
      }),
    ),
    proposals: wireDecision.proposals.map((proposal) => ({
      marketSlug: proposal.marketSlug,
      side: proposal.side,
      action: proposal.action,
      estimatedProbability: proposal.estimatedProbability,
      ...(proposal.maximumEntryPrice === null ||
      proposal.maximumEntryPrice === undefined
        ? {}
        : { maximumEntryPrice: proposal.maximumEntryPrice }),
      ...(proposal.minimumExitPrice === null ||
      proposal.minimumExitPrice === undefined
        ? {}
        : { minimumExitPrice: proposal.minimumExitPrice }),
      maximumRiskUsd: proposal.maximumRiskUsd,
      confidence: proposal.confidence,
      thesis: proposal.thesis,
      settlementVerification: proposal.settlementVerification,
      invalidationConditions: proposal.invalidationConditions,
      evidence: proposal.evidence.map(normalizeEvidence),
      ...(proposal.evidenceBundleIds.length === 0
        ? {}
        : { evidenceBundleIds: proposal.evidenceBundleIds }),
    })),
  };
  return parseAgentDecision(normalized);
}

/** Parses the target-only wire contract exposed to live model providers. */
export function parseModelAgentDecision(value: unknown): AgentDecision {
  const liveDecision = LiveModelDecisionSchema.parse(value);
  return normalizeModelAgentDecision(
    ModelDecisionSchema.parse({
      ...liveDecision,
      proposals: [],
    }),
  );
}

/**
 * Migration helper for bounded historical fixtures/artifacts that used the
 * former proposal wire contract. Never use this at the live tool boundary.
 */
export function parseLegacyModelAgentDecision(value: unknown): AgentDecision {
  return normalizeModelAgentDecision(ModelDecisionSchema.parse(value));
}

export function createPassDecision(cycleSummary: string): AgentDecision {
  return parseAgentDecision({ cycleSummary });
}

export function isPassDecision(decision: AgentDecision): boolean {
  return (
    decision.portfolioTargets.length === 0 && decision.proposals.length === 0
  );
}
