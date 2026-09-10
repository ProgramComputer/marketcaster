import type { AgentDecision } from "./decision-schema.js";
import type { DecisionCoverageReport } from "./decision-coverage.js";
import type { EvidenceValidationReport } from "./evidence-provenance.js";
import type { ProposalValidationResult } from "../risk/validate.js";

export interface DecisionSubmissionAudit {
  readonly attempt: number;
  readonly submittedAt: string;
  readonly targets: readonly {
    readonly marketSlug: string;
    readonly side: "YES" | "NO";
    readonly estimatedProbability: string;
    readonly targetCostBasisFraction: string;
  }[];
  readonly issues: readonly {
    readonly stage: "EVIDENCE" | "COVERAGE" | "RISK";
    readonly marketSlug: string;
    readonly code: string;
    readonly message: string;
    readonly url?: string;
  }[];
}

/** Capture attempted intent before a replacement plan can erase its failures. */
export function captureDecisionSubmission(input: {
  readonly attempt: number;
  readonly submittedAt: string;
  readonly decision: AgentDecision;
  readonly evidence: EvidenceValidationReport;
  readonly coverage: DecisionCoverageReport;
  readonly validation: ProposalValidationResult;
}): DecisionSubmissionAudit {
  return {
    attempt: input.attempt,
    submittedAt: input.submittedAt,
    targets: input.decision.portfolioTargets.map((target) => ({
      marketSlug: target.marketSlug,
      side: target.side,
      estimatedProbability: target.estimatedProbability.toFixed(),
      targetCostBasisFraction: target.targetCostBasisFraction.toFixed(),
    })),
    issues: [
      ...input.evidence.issues.map((issue) => ({
        stage: "EVIDENCE" as const,
        marketSlug: issue.marketSlug,
        code: issue.code,
        message: issue.message,
        ...(issue.url === undefined ? {} : { url: issue.url }),
      })),
      ...input.coverage.issues.map((issue) => ({
        stage: "COVERAGE" as const,
        ...issue,
      })),
      ...input.validation.rejected.map((issue) => ({
        stage: "RISK" as const,
        marketSlug: issue.proposal.marketSlug,
        code: issue.code,
        message: issue.reason,
      })),
    ],
  };
}

export function summarizeDecisionSubmissions(
  attempts: readonly DecisionSubmissionAudit[],
  finalTargets: AgentDecision["portfolioTargets"],
) {
  const finalKeys = new Set(
    finalTargets.map((target) => `${target.marketSlug}:${target.side}`),
  );
  const omitted = new Map<string, DecisionSubmissionAudit["targets"][number]>();
  for (const attempt of attempts) {
    for (const target of attempt.targets) {
      const key = `${target.marketSlug}:${target.side}`;
      if (!finalKeys.has(key)) omitted.set(key, target);
    }
  }
  return {
    attempts,
    omittedTargets: [...omitted.values()].map((target) => ({
      ...target,
      priorIssueCodes: [
        ...new Set(
          attempts.flatMap((attempt) =>
            attempt.issues
              .filter((issue) => issue.marketSlug === target.marketSlug)
              .map((issue) => issue.code),
          ),
        ),
      ],
    })),
  };
}

export type DecisionSubmissionHistory = ReturnType<
  typeof summarizeDecisionSubmissions
>;
