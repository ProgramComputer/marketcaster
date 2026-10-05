import type { RiskProposal } from "../risk/validate.js";
import type { AgentDecision } from "./decision-schema.js";

/** A final-plan guard issue, as reported by coverage, evidence or targets. */
export interface RejectedPlanIssueInput {
  readonly code: string;
  readonly marketSlug: string;
  readonly message: string;
  readonly url?: string;
}

export interface RejectedPlanSource {
  readonly relevance: string;
  readonly claimExcerpt: string | null;
}

export interface RejectedPlanMarket {
  readonly marketSlug: string;
  readonly target: {
    readonly side: string;
    readonly targetCostBasisFraction: string;
    readonly maximumEntryPrice: string | null;
    readonly minimumExitPrice: string | null;
  } | null;
  readonly orders: readonly {
    readonly action: string;
    readonly side: string;
    readonly price: string | null;
    readonly maximumRiskUsd: string;
  }[];
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly url?: string;
    readonly sources?: readonly RejectedPlanSource[];
  }[];
}

/**
 * Describes each market behind a rejected final plan: the model's target, the
 * orders it would have produced, and every guard issue with the cited note
 * and quote, so a console log explains the rejection without the journal.
 */
export function summarizeRejectedPlan(input: {
  readonly decision: AgentDecision;
  readonly orders: readonly RiskProposal[];
  readonly issues: readonly RejectedPlanIssueInput[];
}): readonly RejectedPlanMarket[] {
  const marketSlugs = [
    ...new Set(input.issues.map((issue) => issue.marketSlug)),
  ];
  return marketSlugs.map((marketSlug) => {
    const target = input.decision.portfolioTargets.find(
      (candidate) => candidate.marketSlug === marketSlug,
    );
    const evidence = [
      ...input.decision.portfolioTargets,
      ...input.decision.proposals,
      ...input.decision.candidateDispositions,
    ]
      .filter((item) => item.marketSlug === marketSlug)
      .flatMap((item) => item.evidence);
    return {
      marketSlug,
      target:
        target === undefined
          ? null
          : {
              side: target.side,
              targetCostBasisFraction:
                target.targetCostBasisFraction.toFixed(4),
              maximumEntryPrice: target.maximumEntryPrice?.toFixed() ?? null,
              minimumExitPrice: target.minimumExitPrice?.toFixed() ?? null,
            },
      orders: input.orders
        .filter((order) => order.marketSlug === marketSlug)
        .map((order) => ({
          action: order.action,
          side: order.side,
          price:
            (order.action === "BUY"
              ? order.maximumEntryPrice
              : order.minimumExitPrice
            )?.toFixed() ?? null,
          maximumRiskUsd: order.maximumRiskUsd.toFixed(2),
        })),
      issues: input.issues
        .filter((issue) => issue.marketSlug === marketSlug)
        .map((issue) => {
          // Copy named fields only: evidence issues also carry page text.
          const summary = { code: issue.code, message: issue.message };
          if (issue.url === undefined) return summary;
          const sources = evidence
            .filter((item) => item.url === issue.url)
            .map((item) => ({
              relevance: item.relevance,
              claimExcerpt: item.claimExcerpt ?? null,
            }));
          return { ...summary, url: issue.url, sources };
        }),
    };
  });
}
