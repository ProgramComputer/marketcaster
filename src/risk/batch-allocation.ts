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
  readonly allocationPolicy?: BatchAllocationPolicy | undefined;
}

export interface FundedBatchAllocation<
  Candidate extends BatchAllocationCandidate,
> {
  readonly candidate: Candidate;
  /** Zero-based position in the policy output. */
  readonly rank: number;
  readonly allocatedSpend: Decimal;
  readonly minimumSpend: Decimal;
  readonly additionalSpend: Decimal;
}

export type UnfundedBatchAllocationReason = "POLICY_UNFUNDED";

export interface UnfundedBatchAllocation<
  Candidate extends BatchAllocationCandidate,
> {
  readonly candidate: Candidate;
  /** Zero-based position in the policy output. */
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

export interface AllocationInstruction {
  readonly id: string;
  readonly spend: Decimal;
}
export type BatchAllocationPolicy = (input: {
  readonly cycleBudget: Decimal;
  readonly candidates: readonly BatchAllocationCandidate[];
}) => readonly AllocationInstruction[];

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

/** Validates private allocation instructions against already-assessed risk ceilings. */
export function allocateBatchBudget<Candidate extends BatchAllocationCandidate>(
  input: AllocateBatchBudgetInput<Candidate>,
): BatchAllocationResult<Candidate> {
  assertFiniteNonNegative(input.cycleBudget, "cycleBudget");
  input.candidates.forEach(assertCandidate);
  const byId = new Map(
    input.candidates.map((candidate) => [candidate.id, candidate]),
  );
  if (byId.size !== input.candidates.length)
    throw new RangeError("Candidate IDs must be unique");
  // Copy scalar inputs: policy cannot replace or mutate the assessed candidates.
  const instructions =
    input.allocationPolicy?.({
      cycleBudget: new Decimal(input.cycleBudget),
      candidates: input.candidates.map((candidate) =>
        Object.freeze({
          id: candidate.id,
          conservativeNetEdge: new Decimal(candidate.conservativeNetEdge),
          minimumSpend: new Decimal(candidate.minimumSpend),
          maximumSpend: new Decimal(candidate.maximumSpend),
        }),
      ),
    }) ?? [];
  if (!Array.isArray(instructions))
    throw new TypeError("Allocation policy must return an array");
  const allocations: FundedBatchAllocation<Candidate>[] = [];
  const seen = new Set<string>();
  let committedSpend = new Decimal(0);
  for (const [rank, instruction] of (
    instructions as readonly AllocationInstruction[]
  ).entries()) {
    const candidate = byId.get(instruction.id);
    if (candidate === undefined || seen.has(instruction.id))
      throw new RangeError(
        "Allocation contains an unknown or repeated candidate",
      );
    const spend = new Decimal(instruction.spend);
    assertFiniteNonNegative(spend, "allocated spend");
    if (spend.lt(candidate.minimumSpend) || spend.gt(candidate.maximumSpend))
      throw new RangeError("Allocation exceeds assessed candidate bounds");
    committedSpend = committedSpend.plus(spend);
    if (committedSpend.gt(input.cycleBudget))
      throw new RangeError("Allocation exceeds the cycle budget");
    seen.add(candidate.id);
    allocations.push({
      candidate,
      rank,
      allocatedSpend: spend,
      minimumSpend: candidate.minimumSpend,
      additionalSpend: spend.minus(candidate.minimumSpend),
    });
  }
  const unallocatedSpend = input.cycleBudget.minus(committedSpend);
  const unfunded = input.candidates
    .filter((candidate) => !seen.has(candidate.id))
    .map((candidate, index) => ({
      candidate,
      rank: allocations.length + index,
      reason: "POLICY_UNFUNDED" as const,
      availableSpendAtDecision: unallocatedSpend,
    }));
  return { allocations, unfunded, committedSpend, unallocatedSpend };
}
