import type { AgentDecision } from "./decision-schema.js";
import type { TerminalDecisionRepairFeedback } from "../llm/decision-provider.js";
import type {
  ProposalValidationResult,
  RiskProposal,
} from "../risk/validate.js";
import type { RiskRejectionCode } from "../risk/policy.js";

export function isRepairableRiskRejection(code: RiskRejectionCode): boolean {
  // Infrastructure failures and an operator-disabled capability cannot be
  // repaired by changing the model's intended portfolio.
  return (
    code !== "EXCHANGE_ERROR" &&
    code !== "POSITION_REDUCTION_DISABLED" &&
    code !== "NEW_ENTRIES_BLOCKED" &&
    code !== "POLICY_UNFUNDED"
  );
}

/** Keep policy-blocked intent visible while independent targets are repaired. */
export function retainPositionReductionRequests(
  decision: AgentDecision,
  previous: AgentDecision | undefined,
  blockedMarketSlugs: ReadonlySet<string>,
): AgentDecision {
  if (previous === undefined || blockedMarketSlugs.size === 0) return decision;
  const targets = previous.portfolioTargets.filter((target) =>
    blockedMarketSlugs.has(target.marketSlug),
  );
  const proposals = previous.proposals.filter((proposal) =>
    blockedMarketSlugs.has(proposal.marketSlug),
  );
  const retainedBundleIds = new Set(
    [...targets, ...proposals].flatMap((item) => item.evidenceBundleIds ?? []),
  );
  const retainedBundles = (previous.evidenceBundles ?? []).filter((bundle) =>
    retainedBundleIds.has(bundle.id),
  );
  const evidenceBundles = [
    ...(decision.evidenceBundles ?? []).filter(
      (bundle) => !retainedBundleIds.has(bundle.id),
    ),
    ...retainedBundles,
  ];
  return {
    ...decision,
    portfolioTargets: [
      ...decision.portfolioTargets.filter(
        (target) => !blockedMarketSlugs.has(target.marketSlug),
      ),
      ...targets,
    ],
    proposals: [
      ...decision.proposals.filter(
        (proposal) => !blockedMarketSlugs.has(proposal.marketSlug),
      ),
      ...proposals,
    ],
    candidateDispositions: decision.candidateDispositions.filter(
      (disposition) => !blockedMarketSlugs.has(disposition.marketSlug),
    ),
    ...(evidenceBundles.length === 0 ? {} : { evidenceBundles }),
  };
}

export function buildTerminalDecisionRepairFeedback(
  decision: AgentDecision,
  riskProposals: readonly RiskProposal[],
  validation: ProposalValidationResult,
  minimumIndependentSources: number,
): TerminalDecisionRepairFeedback | undefined {
  if (
    !validation.rejected.some(
      (rejection) =>
        isRepairableRiskRejection(rejection.code) ||
        rejection.code === "POSITION_REDUCTION_DISABLED",
    )
  ) {
    return undefined;
  }

  const proposalIndexes = new Map(
    riskProposals.map((proposal, index) => [proposal, index] as const),
  );
  const requiredIndex = (proposal: RiskProposal): number => {
    const index = proposalIndexes.get(proposal);
    if (index === undefined || decision.proposals[index] === undefined) {
      throw new Error("Validation returned an unknown proposal reference");
    }
    return index;
  };
  const marketStructureRejections = new Set<RiskRejectionCode>([
    "NO_DEPTH",
    "PRICE_LIMIT_EXCEEDED",
    "SPREAD_TOO_WIDE",
  ]);
  const mustDropUnexecutableTargets = validation.rejected.some((rejection) =>
    marketStructureRejections.has(rejection.code),
  );

  return {
    acceptedProposalIndexes: validation.accepted.map(({ proposal }) =>
      requiredIndex(proposal),
    ),
    rejectedProposals: validation.rejected.map((rejection) => ({
      proposalIndex: requiredIndex(rejection.proposal),
      marketSlug: rejection.proposal.marketSlug,
      side: rejection.proposal.side,
      action: rejection.proposal.action,
      code: rejection.code,
      reason: rejection.reason,
      repairable: isRepairableRiskRejection(rejection.code),
    })),
    instructions: [
      "Resubmit the complete intended target portfolio, not only changed items; keep an accepted target only if it is still intended.",
      ...(validation.rejected.some(
        (rejection) => rejection.code === "POSITION_REDUCTION_DISABLED",
      )
        ? [
            "POSITION_REDUCTION_DISABLED is a fixed runtime policy, not a repair opportunity. Its original requested reduction and rejection will be retained. Repair only independent issues; do not replace the blocked reduction with a hold or try to override the policy.",
          ]
        : []),
      ...(validation.rejected.some(
        (rejection) => rejection.code === "NEW_ENTRIES_BLOCKED",
      )
        ? [
            "NEW_ENTRIES_BLOCKED is fixed for this cycle: BUY targets in markets without a current position cannot execute. Drop them or record them as passes; do not research replacements.",
          ]
        : []),
      ...(validation.rejected.some(
        (rejection) => rejection.code === "POLICY_UNFUNDED",
      )
        ? [
            "POLICY_UNFUNDED is final for this cycle: the allocation policy will not fund that target at any size, for the stated reason. Drop it or record it as a pass; do not resize or resubmit it.",
          ]
        : []),
      "Use fresh evidence or research to correct a target, replace it, or omit it. Do not invent evidence or change a probability merely to force validation to pass.",
      ...(mustDropUnexecutableTargets
        ? [
            "Drop every target rejected for NO_DEPTH, PRICE_LIMIT_EXCEEDED, or SPREAD_TOO_WIDE immediately. Do not raise its maximum price, weaken its probability estimate, or spend another round trying to chase the quote.",
          ]
        : []),
      ...(minimumIndependentSources === 0
        ? []
        : [
            `A target that derives a BUY needs at least ${minimumIndependentSources} independent source domains; exchange market pages do not become independent merely because they use different URLs.`,
          ]),
      "If policy-compliant repair is not supported, submit an empty target plan or retain only independently valid targets.",
    ],
  };
}
