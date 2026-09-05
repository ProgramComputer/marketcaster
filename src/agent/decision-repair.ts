import type { AgentDecision } from "./decision-schema.js";
import type { TerminalDecisionRepairFeedback } from "../llm/decision-provider.js";
import type {
  ProposalValidationResult,
  RiskProposal,
} from "../risk/validate.js";
import type { RiskRejectionCode } from "../risk/policy.js";

export function isRepairableRiskRejection(code: RiskRejectionCode): boolean {
  // Every named risk rejection is deterministic feedback the model can address
  // by correcting, dropping, or replacing a proposal. EXCHANGE_ERROR is the
  // catch-all for infrastructure/read failures and is deliberately not fed
  // back as a repair opportunity.
  return code !== "EXCHANGE_ERROR";
}

export function buildTerminalDecisionRepairFeedback(
  decision: AgentDecision,
  riskProposals: readonly RiskProposal[],
  validation: ProposalValidationResult,
  minimumIndependentSources: number,
): TerminalDecisionRepairFeedback | undefined {
  if (
    !validation.rejected.some((rejection) =>
      isRepairableRiskRejection(rejection.code),
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
