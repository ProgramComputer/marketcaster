import type { AgentDecision } from "./decision-schema.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { OutcomeSide } from "../domain/primitives.js";

export type DecisionCoverageIssueCode =
  | "MISSING_HELD_POSITION_DECISION"
  | "FRESH_LIVE_STATE_UNAVAILABLE"
  | "STALE_LIVE_PROBABILITY"
  | "RESOLVED_LOSING_POSITION_NOT_EXITED"
  | "CONTRADICTORY_NO_POSITIVE_EDGE"
  | "MISSING_SERIOUSLY_EVALUATED_CANDIDATE_DECISION"
  | "MISSING_PRIORITY_SIGNAL_DECISION"
  | "TARGET_DISPOSITION_OVERLAP"
  | "UNEXPECTED_DECISION_MARKET"
  | "HELD_SIDE_MISMATCH"
  | "UNINSPECTED_HELD_TARGET"
  | "INVALID_HELD_DISPOSITION"
  | "INVALID_CANDIDATE_DISPOSITION"
  | "CONFLICTING_HELD_SIDES"
  | "LEGACY_PROPOSAL_UNSUPPORTED";

export interface DecisionCoverageIssue {
  readonly code: DecisionCoverageIssueCode;
  readonly marketSlug: string;
  readonly message: string;
}

export interface DecisionCoverageReport {
  readonly valid: boolean;
  readonly heldPositionsDefaultedToNoChange: readonly {
    readonly marketSlug: string;
    readonly side: OutcomeSide;
  }[];
  readonly requiredSeriouslyEvaluatedMarketSlugs: readonly string[];
  readonly requiredPrioritySignalMarketSlugs: readonly string[];
  readonly explicitlyTargeted: number;
  readonly explicitlyDispositioned: number;
  readonly issues: readonly DecisionCoverageIssue[];
}

function heldPositions(snapshot: AccountSnapshot): readonly {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
}[] {
  return snapshot.positions
    .filter(
      (position) =>
        position.quantity.gt(0) ||
        position.availableQuantity.gt(0) ||
        position.costBasis.gt(0),
    )
    .map((position) => ({
      marketSlug: position.marketSlug,
      side: position.side,
    }));
}

/** Requires one explicit target or disposition for every material decision. */
export function validateDecisionCoverage(input: {
  readonly decision: AgentDecision;
  readonly snapshot: AccountSnapshot;
  readonly qualifiedMarketSlugs: ReadonlySet<string>;
  readonly seriouslyEvaluatedMarketSlugs: ReadonlySet<string>;
  readonly inspectedMarketSlugs: ReadonlySet<string>;
  readonly requiredPrioritySignalMarketSlugs: ReadonlySet<string>;
}): DecisionCoverageReport {
  const held = heldPositions(input.snapshot);
  const seriouslyEvaluated = [...input.seriouslyEvaluatedMarketSlugs];
  const requiredPrioritySignals = [...input.requiredPrioritySignalMarketSlugs];
  const requiredSlugs = new Set([
    ...held.map((position) => position.marketSlug),
    ...seriouslyEvaluated,
    ...requiredPrioritySignals,
    ...input.decision.portfolioTargets.map((target) => target.marketSlug),
    ...input.decision.candidateDispositions.map(
      (disposition) => disposition.marketSlug,
    ),
  ]);
  const permittedSlugs = new Set([
    ...held.map((position) => position.marketSlug),
    ...input.inspectedMarketSlugs,
  ]);
  const heldBySlug = new Map(
    held.map((position) => [position.marketSlug, position] as const),
  );
  const targetBySlug = new Map(
    input.decision.portfolioTargets.map((target) => [
      target.marketSlug,
      target,
    ]),
  );
  const dispositionBySlug = new Map(
    input.decision.candidateDispositions.map((disposition) => [
      disposition.marketSlug,
      disposition,
    ]),
  );
  const issues: DecisionCoverageIssue[] = [];

  for (const position of held) {
    if (
      targetBySlug.has(position.marketSlug) ||
      dispositionBySlug.has(position.marketSlug)
    ) {
      continue;
    }
    issues.push({
      code: "MISSING_HELD_POSITION_DECISION",
      marketSlug: position.marketSlug,
      message: `${position.marketSlug} is held on ${position.side} and requires an explicit portfolio target; use its current cost-basis fraction to hold unchanged or zero to exit`,
    });
  }

  for (const slug of seriouslyEvaluated) {
    if (targetBySlug.has(slug) || dispositionBySlug.has(slug)) continue;
    issues.push({
      code: "MISSING_SERIOUSLY_EVALUATED_CANDIDATE_DECISION",
      marketSlug: slug,
      message: `${slug} was seriously evaluated and requires either a portfolio target or an explicit pass disposition`,
    });
  }

  for (const slug of requiredPrioritySignals) {
    if (targetBySlug.has(slug) || dispositionBySlug.has(slug)) continue;
    issues.push({
      code: "MISSING_PRIORITY_SIGNAL_DECISION",
      marketSlug: slug,
      message: `${slug} carried a required priority signal and requires either a portfolio target or an explicit pass disposition`,
    });
  }

  for (const proposal of input.decision.proposals) {
    issues.push({
      code: "LEGACY_PROPOSAL_UNSUPPORTED",
      marketSlug: proposal.marketSlug,
      message: `${proposal.marketSlug} used a legacy one-cycle proposal instead of a portfolio target`,
    });
  }

  const heldSidesBySlug = new Map<string, Set<OutcomeSide>>();
  for (const position of held) {
    const sides = heldSidesBySlug.get(position.marketSlug) ?? new Set();
    sides.add(position.side);
    heldSidesBySlug.set(position.marketSlug, sides);
  }
  for (const [marketSlug, sides] of heldSidesBySlug) {
    if (sides.size <= 1) continue;
    issues.push({
      code: "CONFLICTING_HELD_SIDES",
      marketSlug,
      message: `${marketSlug} has both YES and NO holdings and cannot be represented by one market-level decision`,
    });
  }

  for (const slug of requiredSlugs) {
    const target = targetBySlug.get(slug);
    const disposition = dispositionBySlug.get(slug);
    const heldPosition = heldBySlug.get(slug);
    if (target !== undefined && disposition !== undefined) {
      issues.push({
        code: "TARGET_DISPOSITION_OVERLAP",
        marketSlug: slug,
        message: `${slug} has both a portfolio target and a candidate disposition`,
      });
      continue;
    }
    if (heldPosition !== undefined) {
      if (target !== undefined && !input.inspectedMarketSlugs.has(slug)) {
        issues.push({
          code: "UNINSPECTED_HELD_TARGET",
          marketSlug: slug,
          message: `${slug} is held and was explicitly targeted without a decision-relevant market inspection`,
        });
      }
      if (target !== undefined && target.side !== heldPosition.side) {
        issues.push({
          code: "HELD_SIDE_MISMATCH",
          marketSlug: slug,
          message: `${slug} target side ${target.side} does not match held side ${heldPosition.side}`,
        });
      }
      if (
        disposition !== undefined &&
        (disposition.outcome !== "HOLD_UNCHANGED" ||
          disposition.side !== heldPosition.side)
      ) {
        issues.push({
          code: "INVALID_HELD_DISPOSITION",
          marketSlug: slug,
          message: `${slug} held position requires HOLD_UNCHANGED with side ${heldPosition.side}`,
        });
      }
    } else if (disposition !== undefined && disposition.outcome !== "PASS") {
      issues.push({
        code: "INVALID_CANDIDATE_DISPOSITION",
        marketSlug: slug,
        message: `${slug} is not held and requires a PASS disposition`,
      });
    }
  }

  for (const slug of new Set([
    ...targetBySlug.keys(),
    ...dispositionBySlug.keys(),
  ])) {
    if (permittedSlugs.has(slug)) continue;
    issues.push({
      code: "UNEXPECTED_DECISION_MARKET",
      marketSlug: slug,
      message: `${slug} was neither held nor an inspected mechanically qualified candidate`,
    });
  }

  return {
    valid: issues.length === 0,
    heldPositionsDefaultedToNoChange: held.filter(
      (position) =>
        !targetBySlug.has(position.marketSlug) &&
        !dispositionBySlug.has(position.marketSlug),
    ),
    requiredSeriouslyEvaluatedMarketSlugs: seriouslyEvaluated,
    requiredPrioritySignalMarketSlugs: requiredPrioritySignals,
    explicitlyTargeted: input.decision.portfolioTargets.length,
    explicitlyDispositioned: input.decision.candidateDispositions.length,
    issues,
  };
}
