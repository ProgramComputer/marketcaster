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

export interface RejectedPlanOrder {
  readonly marketSlug: string;
  readonly action: string;
  readonly side: string;
  readonly price: string | null;
  readonly maximumRiskUsd: string;
}

export interface RejectedPlanMarket {
  readonly marketSlug: string;
  readonly target: {
    readonly side: string;
    readonly targetCostBasisFraction: string;
    readonly maximumEntryPrice: string | null;
    readonly minimumExitPrice: string | null;
  } | null;
  readonly orders: readonly RejectedPlanOrder[];
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly url?: string;
    readonly sources?: readonly RejectedPlanSource[];
  }[];
}

export interface RejectedPlanSummary {
  readonly rejectedMarkets: readonly RejectedPlanMarket[];
  /** Orders on markets without an issue, discarded with the rest of the plan. */
  readonly droppedOrders: readonly RejectedPlanOrder[];
}

function summarizeOrder(order: RiskProposal): RejectedPlanOrder {
  return {
    marketSlug: order.marketSlug,
    action: order.action,
    side: order.side,
    price:
      (order.action === "BUY"
        ? order.maximumEntryPrice
        : order.minimumExitPrice
      )?.toFixed() ?? null,
    maximumRiskUsd: order.maximumRiskUsd.toFixed(2),
  };
}

/**
 * Describes a rejected final plan: for each market with a guard issue, the
 * model's target, the orders it would have produced, and every issue with the
 * cited note and quote; then every other order discarded with the plan. A
 * console log can then explain the rejection without the journal.
 */
export function summarizeRejectedPlan(input: {
  readonly decision: AgentDecision;
  readonly orders: readonly RiskProposal[];
  readonly issues: readonly RejectedPlanIssueInput[];
}): RejectedPlanSummary {
  const marketSlugs = new Set(input.issues.map((issue) => issue.marketSlug));
  const rejectedMarkets = [...marketSlugs].map((marketSlug) => {
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
        .map(summarizeOrder),
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
  return {
    rejectedMarkets,
    droppedOrders: input.orders
      .filter((order) => !marketSlugs.has(order.marketSlug))
      .map(summarizeOrder),
  };
}
