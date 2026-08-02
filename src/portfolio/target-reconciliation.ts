import { Decimal } from "decimal.js";
import type { PortfolioTarget } from "../agent/decision-schema.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { Position } from "../domain/position.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";
import type {
  PortfolioTargetExecutionPlan,
  RiskProposal,
} from "../risk/validate.js";

export type PortfolioTargetDispositionReason =
  | "INCREASE_TO_TARGET"
  | "TRIM_TO_TARGET"
  | "EXIT_TO_ZERO"
  | "TARGET_REACHED"
  | "NO_POSITION_TO_EXIT"
  | "OPPOSITE_SIDE_POSITION"
  | "MISSING_ENTRY_PRICE"
  | "MISSING_EXIT_PRICE"
  | "NO_AVAILABLE_QUANTITY"
  | "INVALID_POSITION_STATE"
  | "DUPLICATE_MARKET_TARGET";

interface PortfolioTargetDispositionBase {
  readonly targetIndex: number;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly targetCostBasisUsd: Decimal;
  readonly currentCostBasisUsd: Decimal;
  readonly reason: PortfolioTargetDispositionReason;
}

export interface ProposedPortfolioTargetDisposition extends PortfolioTargetDispositionBase {
  readonly kind: "PROPOSED";
  readonly action: TradeAction;
  readonly proposalIndex: number;
}

export interface HeldPortfolioTargetDisposition extends PortfolioTargetDispositionBase {
  readonly kind: "HOLD";
}

export interface BlockedPortfolioTargetDisposition extends PortfolioTargetDispositionBase {
  readonly kind: "BLOCKED";
  readonly message: string;
}

export type PortfolioTargetDisposition =
  | ProposedPortfolioTargetDisposition
  | HeldPortfolioTargetDisposition
  | BlockedPortfolioTargetDisposition;

export interface ReconcilePortfolioTargetsInput {
  readonly targets: readonly PortfolioTarget[];
  readonly snapshot: AccountSnapshot;
  readonly riskEquity: Decimal;
}

export interface PortfolioTargetReconciliationResult {
  readonly proposals: readonly RiskProposal[];
  readonly dispositions: readonly PortfolioTargetDisposition[];
  /** Indexed like `proposals`; each value identifies its source target. */
  readonly proposalTargetIndexes: readonly number[];
}

function positionsFor(
  positions: readonly Position[],
  marketSlug: string,
  side: OutcomeSide,
): readonly Position[] {
  return positions.filter(
    (position) => position.marketSlug === marketSlug && position.side === side,
  );
}

function oppositeSide(side: OutcomeSide): OutcomeSide {
  return side === "YES" ? "NO" : "YES";
}

function isValidPosition(position: Position | undefined): boolean {
  return (
    position === undefined ||
    (position.quantity.isFinite() &&
      position.quantity.gte(0) &&
      position.availableQuantity.isFinite() &&
      position.availableQuantity.gte(0) &&
      position.availableQuantity.lte(position.quantity) &&
      position.costBasis.isFinite() &&
      position.costBasis.gte(0) &&
      (!position.quantity.isZero() ||
        (position.availableQuantity.isZero() && position.costBasis.isZero())))
  );
}

function riskProposalFromTarget(
  target: PortfolioTarget,
  action: TradeAction,
  maximumRiskUsd: Decimal,
  portfolioTargetPlan: PortfolioTargetExecutionPlan,
  maximumQuantity?: Decimal,
): RiskProposal {
  return {
    marketSlug: target.marketSlug,
    side: target.side,
    action,
    estimatedProbability: target.estimatedProbability,
    probabilityLowerBound: target.probabilityLowerBound,
    probabilityUpperBound: target.probabilityUpperBound,
    ...(action === "BUY" && target.maximumEntryPrice !== undefined
      ? { maximumEntryPrice: target.maximumEntryPrice }
      : {}),
    ...(action === "SELL" && target.minimumExitPrice !== undefined
      ? { minimumExitPrice: target.minimumExitPrice }
      : {}),
    maximumRiskUsd,
    ...(maximumQuantity === undefined ? {} : { maximumQuantity }),
    portfolioTargetPlan,
    confidence: target.confidence,
    thesis: target.thesis,
    settlementVerification: target.settlementVerification,
    invalidationConditions: target.invalidationConditions,
    evidence: target.evidence.map((item) => {
      const { publishedAt, ...required } = item;
      return {
        ...required,
        ...(publishedAt === undefined ? {} : { publishedAt }),
      };
    }),
  };
}

function blocked(
  target: PortfolioTarget,
  targetIndex: number,
  targetCostBasisUsd: Decimal,
  currentCostBasisUsd: Decimal,
  reason:
    | Extract<PortfolioTargetDispositionReason, `INVALID_${string}`>
    | Extract<
        PortfolioTargetDispositionReason,
        | "DUPLICATE_MARKET_TARGET"
        | "MISSING_ENTRY_PRICE"
        | "MISSING_EXIT_PRICE"
        | "NO_AVAILABLE_QUANTITY"
        | "NO_POSITION_TO_EXIT"
        | "OPPOSITE_SIDE_POSITION"
      >,
  message: string,
): BlockedPortfolioTargetDisposition {
  return {
    kind: "BLOCKED",
    targetIndex,
    marketSlug: target.marketSlug,
    side: target.side,
    targetCostBasisUsd,
    currentCostBasisUsd,
    reason,
    message,
  };
}

/**
 * Converts absolute model targets into one-cycle proposal deltas. This function
 * is intentionally pure and read-only: fresh market, risk, liquidity, fee, and
 * placement checks remain the responsibility of `validateProposals` and the
 * live executor.
 *
 * Holdings omitted from `targets` are left untouched. An opposite-side holding
 * blocks an increase rather than assuming that an exit will fill in the same
 * cycle.
 */
export function reconcilePortfolioTargets(
  input: ReconcilePortfolioTargetsInput,
): PortfolioTargetReconciliationResult {
  if (!input.riskEquity.isFinite() || input.riskEquity.lt(0)) {
    throw new RangeError("riskEquity must be a finite non-negative decimal");
  }

  const proposals: RiskProposal[] = [];
  const proposalTargetIndexes: number[] = [];
  const dispositions: PortfolioTargetDisposition[] = [];
  const targetCounts = new Map<string, number>();
  const targetRoundingToleranceUsd = Decimal.min(
    "0.05",
    input.riskEquity.mul("0.0005"),
  );
  for (const target of input.targets) {
    targetCounts.set(
      target.marketSlug,
      (targetCounts.get(target.marketSlug) ?? 0) + 1,
    );
  }

  for (const [targetIndex, target] of input.targets.entries()) {
    const sameSidePositions = positionsFor(
      input.snapshot.positions,
      target.marketSlug,
      target.side,
    );
    const oppositePositions = positionsFor(
      input.snapshot.positions,
      target.marketSlug,
      oppositeSide(target.side),
    );
    const sameSidePosition = sameSidePositions[0];
    const oppositePosition = oppositePositions[0];
    const currentCostBasisUsd = sameSidePosition?.costBasis ?? new Decimal(0);
    const targetCostBasisUsd = input.riskEquity.mul(
      target.targetCostBasisFraction,
    );
    const portfolioTargetPlan: PortfolioTargetExecutionPlan = {
      targetCostBasisUsd,
      baselineCostBasisUsd: currentCostBasisUsd,
      baselineQuantity: sameSidePosition?.quantity ?? new Decimal(0),
      baselineAvailableQuantity:
        sameSidePosition?.availableQuantity ?? new Decimal(0),
      baselineOppositeCostBasisUsd:
        oppositePosition?.costBasis ?? new Decimal(0),
      baselineOppositeQuantity: oppositePosition?.quantity ?? new Decimal(0),
    };

    if ((targetCounts.get(target.marketSlug) ?? 0) > 1) {
      dispositions.push(
        blocked(
          target,
          targetIndex,
          targetCostBasisUsd,
          currentCostBasisUsd,
          "DUPLICATE_MARKET_TARGET",
          "Only one portfolio target is allowed for a market",
        ),
      );
      continue;
    }
    if (
      sameSidePositions.length > 1 ||
      oppositePositions.length > 1 ||
      !targetCostBasisUsd.isFinite() ||
      targetCostBasisUsd.lt(0) ||
      !isValidPosition(sameSidePosition) ||
      !isValidPosition(oppositePosition)
    ) {
      dispositions.push(
        blocked(
          target,
          targetIndex,
          targetCostBasisUsd,
          currentCostBasisUsd,
          "INVALID_POSITION_STATE",
          "The target or authoritative position state is invalid",
        ),
      );
      continue;
    }

    const withinRoundingTolerance =
      !targetCostBasisUsd.isZero() &&
      targetCostBasisUsd
        .minus(currentCostBasisUsd)
        .abs()
        .lte(targetRoundingToleranceUsd);
    const comparison = withinRoundingTolerance
      ? 0
      : targetCostBasisUsd.comparedTo(currentCostBasisUsd);
    const zeroTargetStillHasShares =
      targetCostBasisUsd.isZero() && sameSidePosition?.quantity.gt(0) === true;
    if (
      comparison === 0 &&
      targetCostBasisUsd.isZero() &&
      sameSidePosition === undefined
    ) {
      dispositions.push(
        blocked(
          target,
          targetIndex,
          targetCostBasisUsd,
          currentCostBasisUsd,
          "NO_POSITION_TO_EXIT",
          "A zero target must identify a currently held same-side position",
        ),
      );
      continue;
    }
    if (comparison === 0 && !zeroTargetStillHasShares) {
      dispositions.push({
        kind: "HOLD",
        targetIndex,
        marketSlug: target.marketSlug,
        side: target.side,
        targetCostBasisUsd,
        currentCostBasisUsd,
        reason: "TARGET_REACHED",
      });
      continue;
    }

    if (comparison > 0) {
      if (
        oppositePosition?.quantity.gt(0) === true ||
        oppositePosition?.costBasis.gt(0) === true
      ) {
        dispositions.push(
          blocked(
            target,
            targetIndex,
            targetCostBasisUsd,
            currentCostBasisUsd,
            "OPPOSITE_SIDE_POSITION",
            "An opposite-side position must be exited and authoritatively reconciled before entry",
          ),
        );
        continue;
      }
      const proposalIndex = proposals.length;
      proposals.push(
        riskProposalFromTarget(
          target,
          "BUY",
          targetCostBasisUsd.minus(currentCostBasisUsd),
          portfolioTargetPlan,
        ),
      );
      proposalTargetIndexes.push(targetIndex);
      dispositions.push({
        kind: "PROPOSED",
        targetIndex,
        proposalIndex,
        marketSlug: target.marketSlug,
        side: target.side,
        action: "BUY",
        targetCostBasisUsd,
        currentCostBasisUsd,
        reason: "INCREASE_TO_TARGET",
      });
      continue;
    }

    if (
      sameSidePosition === undefined ||
      sameSidePosition.availableQuantity.lte(0)
    ) {
      dispositions.push(
        blocked(
          target,
          targetIndex,
          targetCostBasisUsd,
          currentCostBasisUsd,
          "NO_AVAILABLE_QUANTITY",
          "The position has no available quantity to reduce",
        ),
      );
      continue;
    }

    const maximumQuantity = targetCostBasisUsd.isZero()
      ? sameSidePosition.availableQuantity
      : Decimal.min(
          sameSidePosition.availableQuantity,
          sameSidePosition.quantity.mul(
            currentCostBasisUsd
              .minus(targetCostBasisUsd)
              .div(currentCostBasisUsd),
          ),
        );
    if (!maximumQuantity.isFinite() || maximumQuantity.lte(0)) {
      dispositions.push(
        blocked(
          target,
          targetIndex,
          targetCostBasisUsd,
          currentCostBasisUsd,
          "INVALID_POSITION_STATE",
          "A positive finite trim quantity could not be derived",
        ),
      );
      continue;
    }

    const proposalIndex = proposals.length;
    proposals.push(
      riskProposalFromTarget(
        target,
        "SELL",
        maximumQuantity,
        portfolioTargetPlan,
        maximumQuantity,
      ),
    );
    proposalTargetIndexes.push(targetIndex);
    dispositions.push({
      kind: "PROPOSED",
      targetIndex,
      proposalIndex,
      marketSlug: target.marketSlug,
      side: target.side,
      action: "SELL",
      targetCostBasisUsd,
      currentCostBasisUsd,
      reason: targetCostBasisUsd.isZero() ? "EXIT_TO_ZERO" : "TRIM_TO_TARGET",
    });
  }

  return { proposals, dispositions, proposalTargetIndexes };
}
