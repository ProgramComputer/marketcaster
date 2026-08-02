import { Decimal } from "decimal.js";

/**
 * A proposal that has already passed market, evidence, edge, liquidity, and
 * per-position risk assessment. `maximumSpend` is the proposal's final
 * individual ceiling after those checks; it is not merely the requested size.
 */
export interface BatchAllocationCandidate {
  readonly id: string;
  readonly conservativeNetEdge: Decimal;
  readonly minimumSpend: Decimal;
  readonly maximumSpend: Decimal;
}

export interface AllocateBatchBudgetInput<
  Candidate extends BatchAllocationCandidate,
> {
  readonly cycleBudget: Decimal;
  readonly candidates: readonly Candidate[];
}

export interface FundedBatchAllocation<
  Candidate extends BatchAllocationCandidate,
> {
  readonly candidate: Candidate;
  /** Zero-based position after edge and deterministic tie-break sorting. */
  readonly rank: number;
  readonly allocatedSpend: Decimal;
  readonly minimumSpend: Decimal;
  readonly additionalSpend: Decimal;
}

export type UnfundedBatchAllocationReason = "MINIMUM_UNFUNDED";

export interface UnfundedBatchAllocation<
  Candidate extends BatchAllocationCandidate,
> {
  readonly candidate: Candidate;
  /** Zero-based position after edge and deterministic tie-break sorting. */
  readonly rank: number;
  readonly reason: UnfundedBatchAllocationReason;
  readonly availableSpendAtDecision: Decimal;
}

export interface BatchAllocationResult<
  Candidate extends BatchAllocationCandidate,
> {
  /** Funded candidates in deterministic allocation/execution priority order. */
  readonly allocations: readonly FundedBatchAllocation<Candidate>[];
  /** Candidates whose minimum executable spend did not fit the cycle budget. */
  readonly unfunded: readonly UnfundedBatchAllocation<Candidate>[];
  readonly committedSpend: Decimal;
  readonly unallocatedSpend: Decimal;
}

interface RankedCandidate<Candidate extends BatchAllocationCandidate> {
  readonly candidate: Candidate;
  readonly inputIndex: number;
}

interface MutableAllocation<Candidate extends BatchAllocationCandidate> {
  readonly candidate: Candidate;
  readonly rank: number;
  allocatedSpend: Decimal;
}

function assertFiniteNonNegative(value: Decimal, name: string): void {
  if (!value.isFinite() || value.lt(0)) {
    throw new RangeError(`${name} must be a finite non-negative decimal`);
  }
}

function assertCandidate(
  candidate: BatchAllocationCandidate,
  inputIndex: number,
): void {
  const prefix = `candidates[${inputIndex}]`;
  if (candidate.id.length === 0) {
    throw new RangeError(`${prefix}.id must not be empty`);
  }
  if (
    !candidate.conservativeNetEdge.isFinite() ||
    candidate.conservativeNetEdge.lte(0)
  ) {
    throw new RangeError(
      `${prefix}.conservativeNetEdge must be a positive finite decimal`,
    );
  }
  if (!candidate.minimumSpend.isFinite() || candidate.minimumSpend.lte(0)) {
    throw new RangeError(
      `${prefix}.minimumSpend must be a positive finite decimal`,
    );
  }
  if (!candidate.maximumSpend.isFinite() || candidate.maximumSpend.lte(0)) {
    throw new RangeError(
      `${prefix}.maximumSpend must be a positive finite decimal`,
    );
  }
  if (candidate.maximumSpend.lt(candidate.minimumSpend)) {
    throw new RangeError(
      `${prefix}.maximumSpend must be at least minimumSpend`,
    );
  }
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rankCandidates<Candidate extends BatchAllocationCandidate>(
  candidates: readonly Candidate[],
): readonly RankedCandidate<Candidate>[] {
  return candidates
    .map((candidate, inputIndex) => ({ candidate, inputIndex }))
    .sort((left, right) => {
      const byEdge = right.candidate.conservativeNetEdge.comparedTo(
        left.candidate.conservativeNetEdge,
      );
      if (byEdge !== 0) return byEdge;
      const byId = compareIds(left.candidate.id, right.candidate.id);
      return byId === 0 ? left.inputIndex - right.inputIndex : byId;
    });
}

function remainingCapacity<Candidate extends BatchAllocationCandidate>(
  allocation: MutableAllocation<Candidate>,
): Decimal {
  return Decimal.max(
    0,
    allocation.candidate.maximumSpend.minus(allocation.allocatedSpend),
  );
}

/**
 * Concentrates spend left after minimum funding in conservative-net-edge
 * order. `allocations` is already ranked by `rankCandidates`, so the strongest
 * candidate receives its full remaining capacity before the next candidate.
 * This preserves a small executable allocation for every funded positive-edge
 * target while making the residual portfolio reflect the edge ranking instead
 * of the relative sizes of model-authored target caps.
 */
function distributeRemainingBudget<Candidate extends BatchAllocationCandidate>(
  allocations: readonly MutableAllocation<Candidate>[],
  budget: Decimal,
): void {
  let remaining = budget;
  for (const allocation of allocations) {
    if (remaining.lte(0)) return;
    const addition = Decimal.min(remaining, remainingCapacity(allocation));
    allocation.allocatedSpend = allocation.allocatedSpend.plus(addition);
    remaining = Decimal.max(0, remaining.minus(addition));
  }
}

/**
 * Allocates a fixed cycle-spend budget across already-assessed candidates.
 *
 * Minimum executable spends are greedily funded by conservative net edge
 * (descending), candidate id (ascending), then original input order. A minimum
 * that does not fit is skipped so a cheaper lower-ranked candidate can still be
 * funded. Remaining spend is concentrated by conservative net edge without
 * exceeding any individual cap or the cycle budget.
 */
export function allocateBatchBudget<Candidate extends BatchAllocationCandidate>(
  input: AllocateBatchBudgetInput<Candidate>,
): BatchAllocationResult<Candidate> {
  assertFiniteNonNegative(input.cycleBudget, "cycleBudget");
  input.candidates.forEach(assertCandidate);

  const ranked = rankCandidates(input.candidates);
  const allocations: MutableAllocation<Candidate>[] = [];
  const unfunded: UnfundedBatchAllocation<Candidate>[] = [];
  let available = input.cycleBudget;

  for (const [rank, rankedCandidate] of ranked.entries()) {
    const { candidate } = rankedCandidate;
    if (candidate.minimumSpend.lte(available)) {
      allocations.push({
        candidate,
        rank,
        allocatedSpend: candidate.minimumSpend,
      });
      available = available.minus(candidate.minimumSpend);
    } else {
      unfunded.push({
        candidate,
        rank,
        reason: "MINIMUM_UNFUNDED",
        availableSpendAtDecision: available,
      });
    }
  }

  distributeRemainingBudget(allocations, available);

  const committedSpend = Decimal.sum(
    0,
    ...allocations.map((allocation) => allocation.allocatedSpend),
  );
  const unallocatedSpend = Decimal.max(
    0,
    input.cycleBudget.minus(committedSpend),
  );

  return {
    allocations: allocations.map((allocation) => ({
      candidate: allocation.candidate,
      rank: allocation.rank,
      allocatedSpend: allocation.allocatedSpend,
      minimumSpend: allocation.candidate.minimumSpend,
      additionalSpend: allocation.allocatedSpend.minus(
        allocation.candidate.minimumSpend,
      ),
    })),
    unfunded,
    committedSpend,
    unallocatedSpend,
  };
}
