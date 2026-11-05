import { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { Market, MarketBbo, OrderBook } from "../domain/market.js";
import type { MarketId, OutcomeSide } from "../domain/primitives.js";
import {
  canonicalBookLevels,
  totalEligibleQuantity,
} from "../execution/depth.js";
import { alignQuantity } from "../execution/price-rounding.js";
import type {
  ProposalValidationResult,
  RejectedProposal,
  RiskProposal,
  ValidatedProposal,
} from "../risk/validate.js";
import type {
  AgentDecision,
  CandidateDisposition,
  PortfolioTarget,
  TradeProposal,
} from "./decision-schema.js";
import type { AdvisoryTradePreviewResult } from "./trade-preview.js";

export interface AdvisoryLiquidityPreview {
  readonly marketId: MarketId;
  readonly preview: AdvisoryTradePreviewResult;
}

/** Captured only after ordinary market/book freshness validation succeeds. */
export interface ExecutionLiquiditySnapshot {
  readonly proposal: RiskProposal;
  readonly market: Market;
  readonly bbo: MarketBbo;
  readonly book: OrderBook;
}

export interface BuyLiquidityBaseline {
  readonly key: string;
  readonly marketId: MarketId;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly limitPrice: Decimal;
  readonly availableQuantity: Decimal;
  readonly requestedQuantity: Decimal;
  readonly bookObservedAt: Date;
  readonly source: "ADVISORY_PREVIEW" | "REASSESSMENT_BOOK";
  readonly preview?: AdvisoryTradePreviewResult;
}

export interface BuyLiquidityDeterioration {
  readonly key: string;
  readonly baseline: BuyLiquidityBaseline;
  readonly snapshot: ExecutionLiquiditySnapshot;
  readonly retainedLiquidityFraction: Decimal;
  readonly currentAvailableAtOriginalLimit: Decimal;
  readonly currentAvailableQuantity: Decimal;
  readonly currentLimitPrice: Decimal;
  readonly intendedQuantity: Decimal;
  readonly riskBudget: Decimal;
  readonly accepted?: ValidatedProposal;
  readonly rejected?: RejectedProposal;
}

export interface BuyLiquidityIdentity {
  readonly marketId: MarketId;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
}

/** Amount, decision index, and array ordering are deliberately absent. */
export function buyLiquidityKey(identity: BuyLiquidityIdentity): string {
  return JSON.stringify([
    identity.marketId.exchange,
    identity.marketId.value,
    identity.marketSlug,
    identity.side,
  ]);
}

function finite(value: Decimal, minimum: number, maximum?: number): boolean {
  return (
    value.isFinite() &&
    value.gte(minimum) &&
    (maximum === undefined || value.lte(maximum))
  );
}

function parsed(value: string): Decimal | undefined {
  try {
    const result = new Decimal(value);
    return result.isFinite() ? result : undefined;
  } catch {
    return undefined;
  }
}

function sameMarket(left: MarketId, right: MarketId): boolean {
  return left.exchange === right.exchange && left.value === right.value;
}

/** Input order is capture order; an unsuccessful preview never erases success. */
export function collectBuyLiquidityBaselines(
  previews: readonly AdvisoryLiquidityPreview[],
): readonly BuyLiquidityBaseline[] {
  const latest = new Map<string, BuyLiquidityBaseline>();
  for (const { marketId, preview } of previews) {
    if (preview.action !== "BUY" || !preview.feePreview.accepted) continue;
    const limitPrice = parsed(preview.limitPrice);
    const availableQuantity = parsed(
      preview.depth.maximumImmediatelyFillableQuantity,
    );
    const requestedQuantity = parsed(preview.quantity);
    const fillable = parsed(preview.depth.requestedFillableQuantity);
    const bookObservedAt = new Date(preview.bookObservedAt);
    if (
      limitPrice === undefined ||
      !finite(limitPrice, 0, 1) ||
      limitPrice.isZero() ||
      availableQuantity === undefined ||
      availableQuantity.lte(0) ||
      requestedQuantity === undefined ||
      requestedQuantity.lte(0) ||
      fillable === undefined ||
      fillable.lte(0) ||
      !Number.isFinite(bookObservedAt.getTime())
    ) {
      continue;
    }
    const identity = {
      marketId,
      marketSlug: preview.marketSlug,
      side: preview.side,
    };
    const key = buyLiquidityKey(identity);
    latest.set(key, {
      ...identity,
      key,
      limitPrice,
      availableQuantity,
      requestedQuantity,
      bookObservedAt,
      source: "ADVISORY_PREVIEW",
      preview,
    });
  }
  return [...latest.values()];
}

function validLevels(snapshot: ExecutionLiquiditySnapshot): boolean {
  return canonicalBookLevels(
    snapshot.book,
    snapshot.proposal.side,
    "BUY",
  ).every((level) => finite(level.price, 0, 1) && finite(level.quantity, 0));
}

function validBuy(proposal: RiskProposal): boolean {
  return (
    proposal.action === "BUY" &&
    finite(proposal.maximumRiskUsd, 0) &&
    proposal.maximumRiskUsd.gt(0) &&
    (proposal.maximumQuantity === undefined ||
      (finite(proposal.maximumQuantity, 0) &&
        proposal.maximumQuantity.gt(0))) &&
    finite(proposal.estimatedProbability, 0, 1) &&
    finite(proposal.probabilityLowerBound, 0, 1) &&
    finite(proposal.probabilityUpperBound, 0, 1) &&
    proposal.probabilityLowerBound.lte(proposal.estimatedProbability) &&
    proposal.estimatedProbability.lte(proposal.probabilityUpperBound)
  );
}

function proposalMatches(
  proposal: RiskProposal,
  snapshot: ExecutionLiquiditySnapshot,
): boolean {
  return (
    proposal.action === "BUY" &&
    proposal.marketSlug === snapshot.proposal.marketSlug &&
    proposal.side === snapshot.proposal.side
  );
}

export interface DetectBuyLiquidityDeteriorationInput {
  readonly previews?: readonly AdvisoryLiquidityPreview[];
  readonly baselines?: readonly BuyLiquidityBaseline[];
  readonly snapshots: readonly ExecutionLiquiditySnapshot[];
  readonly validation: ProposalValidationResult;
  /** Required deployment policy: no materiality threshold is assumed here. */
  readonly maximumRetainedLiquidityFraction: Decimal;
  readonly consumedKeys?: ReadonlySet<string>;
}

/**
 * Compare depth at the original preview limit, then require it to constrain
 * the currently risk-sized order at its actual execution limit. Losing excess
 * depth, allocation headroom, or a minimum-lot rounding remainder is not enough.
 */
export function detectBuyLiquidityDeterioration(
  input: DetectBuyLiquidityDeteriorationInput,
): readonly BuyLiquidityDeterioration[] {
  if (
    !finite(input.maximumRetainedLiquidityFraction, 0, 1) ||
    input.maximumRetainedLiquidityFraction.isZero() ||
    input.maximumRetainedLiquidityFraction.eq(1)
  ) {
    throw new RangeError(
      "Retained liquidity fraction must be strictly between zero and one",
    );
  }
  const baselines = new Map(
    [
      ...collectBuyLiquidityBaselines(input.previews ?? []),
      ...(input.baselines ?? []),
    ].map((baseline) => [baseline.key, baseline]),
  );
  const affected = new Map<string, BuyLiquidityDeterioration>();
  for (const snapshot of input.snapshots) {
    if (
      !validBuy(snapshot.proposal) ||
      !sameMarket(snapshot.market.id, snapshot.book.marketId) ||
      !sameMarket(snapshot.market.id, snapshot.bbo.marketId) ||
      snapshot.market.slug !== snapshot.proposal.marketSlug ||
      !finite(snapshot.market.minimumTradeQuantity, 0) ||
      snapshot.market.minimumTradeQuantity.isZero() ||
      !validLevels(snapshot)
    ) {
      continue;
    }
    const key = buyLiquidityKey({
      marketId: snapshot.market.id,
      marketSlug: snapshot.market.slug,
      side: snapshot.proposal.side,
    });
    if (input.consumedKeys?.has(key) === true) continue;
    const baseline = baselines.get(key);
    if (baseline === undefined) continue;
    if (
      baseline.key !== buyLiquidityKey(baseline) ||
      !sameMarket(baseline.marketId, snapshot.market.id) ||
      !finite(baseline.availableQuantity, 0) ||
      baseline.availableQuantity.isZero() ||
      !finite(baseline.limitPrice, 0, 1) ||
      baseline.limitPrice.isZero() ||
      !Number.isFinite(snapshot.book.observedAt.getTime()) ||
      !Number.isFinite(baseline.bookObservedAt.getTime()) ||
      snapshot.book.observedAt.getTime() < baseline.bookObservedAt.getTime()
    ) {
      continue;
    }
    const accepted = input.validation.accepted.find(
      (item) =>
        proposalMatches(item.proposal, snapshot) &&
        sameMarket(item.market.id, snapshot.market.id),
    );
    const rejections = input.validation.rejected.filter((item) =>
      proposalMatches(item.proposal, snapshot),
    );
    if (
      rejections.some(
        (item) =>
          item.code !== "NO_DEPTH" && item.code !== "PRICE_LIMIT_EXCEEDED",
      ) ||
      (accepted === undefined && rejections.length === 0)
    ) {
      continue;
    }
    const currentLimitPrice =
      accepted?.order.canonicalLimitPrice ??
      snapshot.proposal.maximumEntryPrice ??
      baseline.limitPrice;
    const riskBudget = accepted?.riskBudget ?? snapshot.proposal.maximumRiskUsd;
    if (
      !finite(currentLimitPrice, 0, 1) ||
      currentLimitPrice.isZero() ||
      !finite(riskBudget, 0) ||
      riskBudget.isZero()
    ) {
      continue;
    }
    const levels = canonicalBookLevels(
      snapshot.book,
      snapshot.proposal.side,
      "BUY",
    );
    const currentAvailableAtOriginalLimit = totalEligibleQuantity(
      levels,
      "BUY",
      baseline.limitPrice,
    );
    const retainedLiquidityFraction = currentAvailableAtOriginalLimit.div(
      baseline.availableQuantity,
    );
    if (retainedLiquidityFraction.gt(input.maximumRetainedLiquidityFraction)) {
      continue;
    }
    const currentAvailableQuantity = totalEligibleQuantity(
      levels,
      "BUY",
      currentLimitPrice,
    );
    // Use the accepted reserve rather than interpreting principal-only cash as
    // executable size. The quantity increment removes fee/lot rounding noise.
    const feePerContract =
      accepted?.order.quantity.gt(0) === true
        ? accepted.conservativeFeeReserve.div(accepted.order.quantity)
        : new Decimal(0);
    if (!finite(feePerContract, 0)) continue;
    let intendedQuantity = alignQuantity(
      riskBudget.div(currentLimitPrice.plus(feePerContract)),
      snapshot.market.minimumTradeQuantity,
    );
    if (snapshot.proposal.maximumQuantity !== undefined) {
      intendedQuantity = Decimal.min(
        intendedQuantity,
        snapshot.proposal.maximumQuantity,
      );
    }
    if (
      intendedQuantity.lte(0) ||
      alignQuantity(
        currentAvailableQuantity,
        snapshot.market.minimumTradeQuantity,
      ).gte(intendedQuantity)
    ) {
      continue;
    }
    affected.set(key, {
      key,
      baseline,
      snapshot,
      retainedLiquidityFraction,
      currentAvailableAtOriginalLimit,
      currentAvailableQuantity,
      currentLimitPrice,
      intendedQuantity,
      riskBudget,
      ...(accepted === undefined ? {} : { accepted }),
      ...(rejections[0] === undefined ? {} : { rejected: rejections[0] }),
    });
  }
  return [...affected.values()];
}

/** An intentionally bounded, account-free description for a single response. */
export function buildBuyLiquidityReassessmentFeedback(
  affected: readonly BuyLiquidityDeterioration[],
) {
  return affected.map((item) => ({
    key: item.key,
    marketSlug: item.snapshot.market.slug,
    side: item.snapshot.proposal.side,
    originalPreview: {
      source: item.baseline.source,
      limitPrice: item.baseline.limitPrice.toFixed(),
      requestedQuantity: item.baseline.requestedQuantity.toFixed(),
      maximumAvailableQuantity: item.baseline.availableQuantity.toFixed(),
      bookObservedAt: item.baseline.bookObservedAt.toISOString(),
      ...(item.baseline.preview === undefined
        ? {}
        : {
            requestedFillableQuantity:
              item.baseline.preview.depth.requestedFillableQuantity,
            expectedSpendUsd: item.baseline.preview.costs.expectedBookSpend,
            maximumSpendUsd: item.baseline.preview.costs.maximumSpendAtLimit,
            estimatedFeesUsd: item.baseline.preview.feePreview.estimatedFees,
            conservativeFeeReserveUsd:
              item.baseline.preview.costs.conservativeFeeReserve,
          }),
    },
    modelRequestedBudgetUsd: item.snapshot.proposal.maximumRiskUsd.toFixed(),
    retainedLiquidityFraction: item.retainedLiquidityFraction.toFixed(),
    freshBook: {
      bookObservedAt: item.snapshot.book.observedAt.toISOString(),
      levels: reviewedLevels(item).map((level) => ({
        price: level.price.toFixed(),
        quantity: level.quantity.toFixed(),
      })),
    },
    currentExecution: {
      limitPrice: item.currentLimitPrice.toFixed(),
      maximumFillableQuantity: item.currentAvailableQuantity.toFixed(),
      intendedRiskSizedQuantity: item.intendedQuantity.toFixed(),
      riskBudgetUsd: item.riskBudget.toFixed(),
      ...(item.accepted === undefined
        ? { rejectionCode: item.rejected?.code }
        : {
            quantity: item.accepted.order.quantity.toFixed(),
            expectedSpendUsd: item.accepted.expectedSpend.toFixed(),
            maximumSpendUsd: item.accepted.maximumExecutionSpend.toFixed(),
            estimatedFeesUsd: item.accepted.estimatedFees.toFixed(),
            conservativeFeeReserveUsd:
              item.accepted.conservativeFeeReserve.toFixed(),
            authorizationProbability:
              item.accepted.authorizationProbability.toFixed(),
            ...(item.accepted.netEdge === undefined
              ? {}
              : { netEdge: item.accepted.netEdge.toFixed() }),
          }),
    },
    forecast: {
      estimatedProbability:
        item.snapshot.proposal.estimatedProbability.toFixed(),
      probabilityLowerBound:
        item.snapshot.proposal.probabilityLowerBound.toFixed(),
      probabilityUpperBound:
        item.snapshot.proposal.probabilityUpperBound.toFixed(),
      confidence: item.snapshot.proposal.confidence,
    },
  }));
}

function keyFor(
  item: { readonly marketSlug: string; readonly side: OutcomeSide },
  marketsBySlug: ReadonlyMap<string, Market>,
): string | undefined {
  const market = marketsBySlug.get(item.marketSlug);
  return market === undefined
    ? undefined
    : buyLiquidityKey({
        marketId: market.id,
        marketSlug: item.marketSlug,
        side: item.side,
      });
}

type BuyIntent = PortfolioTarget | TradeProposal;

function intents(decision: AgentDecision): readonly BuyIntent[] {
  return [
    ...decision.portfolioTargets,
    ...decision.proposals.filter((item) => item.action === "BUY"),
  ];
}

function heldCostBasis(
  intent: BuyIntent,
  snapshot: AccountSnapshot,
  market: Market,
): Decimal {
  return snapshot.positions
    .filter(
      (position) =>
        sameMarket(position.marketId, market.id) &&
        position.marketSlug === intent.marketSlug &&
        position.side === intent.side &&
        position.quantity.gt(0),
    )
    .reduce(
      (total, position) => total.plus(position.costBasis),
      new Decimal(0),
    );
}

export interface StripAffectedBuysInput {
  readonly decision: AgentDecision;
  readonly affectedKeys: ReadonlySet<string>;
  readonly snapshot: AccountSnapshot;
  readonly marketsBySlug: ReadonlyMap<string, Market>;
  readonly riskEquity: Decimal;
}

/** Remove only affected entry intent; retain an explicit hold for held exposure. */
export function stripAffectedBuys(
  input: StripAffectedBuysInput,
): AgentDecision {
  const affected = intents(input.decision).filter((item) => {
    const key = keyFor(item, input.marketsBySlug);
    return key !== undefined && input.affectedKeys.has(key);
  });
  const affectedSlugs = new Set(affected.map((item) => item.marketSlug));
  const isAffected = (item: BuyIntent): boolean => {
    const key = keyFor(item, input.marketsBySlug);
    return key !== undefined && input.affectedKeys.has(key);
  };
  const dispositions: CandidateDisposition[] = [];
  for (const item of affected) {
    if (
      dispositions.some(
        (disposition) => disposition.marketSlug === item.marketSlug,
      )
    )
      continue;
    const market = input.marketsBySlug.get(item.marketSlug);
    if (market === undefined) continue;
    const held = input.snapshot.positions.some(
      (position) =>
        sameMarket(position.marketId, market.id) &&
        position.marketSlug === item.marketSlug &&
        position.side === item.side &&
        position.quantity.gt(0),
    );
    dispositions.push({
      marketSlug: item.marketSlug,
      side: item.side,
      outcome: held ? "HOLD_UNCHANGED" : "PASS",
      reasonCode: "MARKET_STRUCTURE",
      rationale:
        "BUY skipped because materially deteriorated executable liquidity was not safely reassessed; any existing position remains unchanged.",
      ...("probabilityLowerBound" in item
        ? {
            estimatedProbability: item.estimatedProbability,
            probabilityLowerBound: item.probabilityLowerBound,
            probabilityUpperBound: item.probabilityUpperBound,
          }
        : {}),
      evidence: item.evidence,
      ...(item.evidenceBundleIds === undefined
        ? {}
        : { evidenceBundleIds: item.evidenceBundleIds }),
    });
  }
  return {
    ...input.decision,
    portfolioTargets: [
      ...input.decision.portfolioTargets.filter((item) => !isAffected(item)),
    ],
    proposals: input.decision.proposals.filter(
      (item) => item.action !== "BUY" || !isAffected(item),
    ),
    candidateDispositions: [
      ...input.decision.candidateDispositions.filter(
        (item) => !affectedSlugs.has(item.marketSlug),
      ),
      ...dispositions,
    ],
  };
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Decimal.isDecimal(value)) return JSON.stringify(value.toFixed());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function invariantIntent(intent: BuyIntent): string {
  const mutable = new Set([
    "maximumEntryPrice",
    "targetCostBasisFraction",
    "maximumRiskUsd",
    "thesis",
  ]);
  return canonical(
    Object.fromEntries(
      Object.entries(intent).filter(([key]) => !mutable.has(key)),
    ),
  );
}

export interface MergeBuyLiquidityReassessmentInput extends Omit<
  StripAffectedBuysInput,
  "decision"
> {
  readonly original: AgentDecision;
  readonly replacement: AgentDecision;
  /** Freeze an originally automatic price to the disclosed execution limit. */
  readonly currentExecutionLimitByKey?: ReadonlyMap<string, Decimal>;
}

export interface BuyLiquidityReassessmentMergeResult {
  readonly decision: AgentDecision;
  readonly acknowledgedKeys: ReadonlySet<string>;
  readonly rejectedKeys: ReadonlySet<string>;
  readonly issues: readonly string[];
}

/**
 * Apply only permitted per-entry changes. The complete original decision owns
 * every unaffected target, SELL, evidence bundle, and summary regardless of the
 * response's ordering or attempted unrelated modifications.
 */
export function mergeBuyLiquidityReassessment(
  input: MergeBuyLiquidityReassessmentInput,
): BuyLiquidityReassessmentMergeResult {
  const acknowledgedKeys = new Set<string>();
  const rejectedKeys = new Set<string>();
  const issues: string[] = [];
  const replacements = intents(input.replacement);
  const originalIntents = intents(input.original);
  const evidenceChanged =
    canonical(input.original.evidenceBundles ?? []) !==
    canonical(input.replacement.evidenceBundles ?? []);
  const selected = new Map<string, BuyIntent>();
  const dropped = new Set<string>();
  for (const key of input.affectedKeys) {
    const originals = originalIntents.filter(
      (item) => keyFor(item, input.marketsBySlug) === key,
    );
    const original = originals[0];
    if (original === undefined) {
      rejectedKeys.add(key);
      issues.push(`Unknown affected BUY identity ${key}`);
      continue;
    }
    const candidates = replacements.filter(
      (item) => item.marketSlug === original.marketSlug,
    );
    const dispositions = input.replacement.candidateDispositions.filter(
      (item) => item.marketSlug === original.marketSlug,
    );
    let reason: string | undefined;
    const candidate = candidates[0];
    const proposedLimit =
      candidate?.maximumEntryPrice ??
      (original.maximumEntryPrice === undefined
        ? input.currentExecutionLimitByKey?.get(key)
        : undefined);
    const disposition = dispositions[0];
    if (evidenceChanged) reason = "Evidence bundles changed";
    else if (
      originals.length !== 1 ||
      candidates.length > 1 ||
      dispositions.length > 1 ||
      (candidate !== undefined && disposition !== undefined)
    )
      reason = "Ambiguous affected BUY replacement";
    else if (candidate !== undefined) {
      if (
        keyFor(candidate, input.marketsBySlug) !== key ||
        "action" in original !== "action" in candidate ||
        invariantIntent(candidate) !== invariantIntent(original)
      )
        reason =
          "Affected BUY identity, forecast, evidence, or immutable fields changed";
      else if (
        proposedLimit === undefined ||
        !finite(proposedLimit, 0, 1) ||
        proposedLimit.isZero()
      )
        reason = "Affected BUY must retain an explicit positive price limit";
      else if (
        "targetCostBasisFraction" in original &&
        "targetCostBasisFraction" in candidate
      ) {
        const market = input.marketsBySlug.get(original.marketSlug);
        const costBasis =
          market === undefined
            ? new Decimal(0)
            : heldCostBasis(original, input.snapshot, market);
        if (
          !finite(candidate.targetCostBasisFraction, 0, 1) ||
          candidate.targetCostBasisFraction.gt(original.targetCostBasisFraction)
        )
          reason = "Affected BUY target budget increased";
        else if (
          costBasis.gt(0) &&
          (!finite(input.riskEquity, 0) ||
            input.riskEquity.isZero() ||
            candidate.targetCostBasisFraction
              .mul(input.riskEquity)
              .lt(costBasis))
        )
          reason = "Affected BUY revision would reduce an existing position";
      } else if (
        "maximumRiskUsd" in original &&
        "maximumRiskUsd" in candidate
      ) {
        if (
          !finite(candidate.maximumRiskUsd, 0) ||
          candidate.maximumRiskUsd.gt(original.maximumRiskUsd)
        )
          reason = "Affected BUY risk budget increased";
      }
    } else if (disposition !== undefined) {
      const forecastFields = [
        "estimatedProbability",
        "probabilityLowerBound",
        "probabilityUpperBound",
      ] as const;
      if (
        (disposition.side !== undefined &&
          disposition.side !== null &&
          disposition.side !== original.side) ||
        disposition.reasonCode !== "MARKET_STRUCTURE" ||
        canonical(disposition.evidence) !== canonical(original.evidence) ||
        canonical(disposition.evidenceBundleIds ?? []) !==
          canonical(original.evidenceBundleIds ?? []) ||
        forecastFields.some(
          (field) =>
            disposition[field] !== undefined &&
            disposition[field] !== null &&
            (!(field in original) ||
              canonical(disposition[field]) !==
                canonical(original[field as keyof BuyIntent])),
        )
      )
        reason = "Affected disposition changed identity, evidence, or forecast";
      else if (disposition.outcome === "HOLD_UNCHANGED") {
        const market = input.marketsBySlug.get(original.marketSlug);
        if (
          market === undefined ||
          !input.snapshot.positions.some(
            (position) =>
              sameMarket(position.marketId, market.id) &&
              position.marketSlug === original.marketSlug &&
              position.side === original.side &&
              position.quantity.gt(0),
          )
        )
          reason = "HOLD_UNCHANGED requires an existing position";
      }
    } else reason = "Affected BUY was omitted without an explicit PASS or hold";
    if (reason !== undefined) {
      rejectedKeys.add(key);
      dropped.add(key);
      issues.push(`${original.marketSlug}: ${reason}`);
    } else {
      acknowledgedKeys.add(key);
      if (
        candidate === undefined ||
        ("targetCostBasisFraction" in candidate
          ? candidate.targetCostBasisFraction.isZero()
          : candidate.maximumRiskUsd.isZero())
      )
        dropped.add(key);
      else
        selected.set(
          key,
          candidate.maximumEntryPrice === undefined &&
            proposedLimit !== undefined
            ? { ...candidate, maximumEntryPrice: proposedLimit }
            : candidate,
        );
    }
  }
  for (const item of [
    ...replacements,
    ...input.replacement.proposals.filter(
      (proposal) => proposal.action === "SELL",
    ),
  ]) {
    const key = keyFor(item, input.marketsBySlug);
    if (key !== undefined && input.affectedKeys.has(key)) continue;
    const original = [
      ...originalIntents,
      ...input.original.proposals.filter(
        (proposal) => proposal.action === "SELL",
      ),
    ].find(
      (candidate) =>
        candidate.marketSlug === item.marketSlug &&
        candidate.side === item.side &&
        ("action" in candidate ? candidate.action : "TARGET") ===
          ("action" in item ? item.action : "TARGET"),
    );
    if (original === undefined || canonical(original) !== canonical(item))
      issues.push(`${item.marketSlug}: unrelated replacement ignored`);
  }
  const decision: AgentDecision = {
    ...input.original,
    portfolioTargets: input.original.portfolioTargets.map((item) => {
      const key = keyFor(item, input.marketsBySlug);
      const replacement = key === undefined ? undefined : selected.get(key);
      return replacement !== undefined &&
        "targetCostBasisFraction" in replacement
        ? replacement
        : item;
    }),
    proposals: input.original.proposals.map((item) => {
      const key = keyFor(item, input.marketsBySlug);
      const replacement =
        item.action !== "BUY" || key === undefined
          ? undefined
          : selected.get(key);
      return replacement !== undefined && "action" in replacement
        ? replacement
        : item;
    }),
  };
  return {
    decision: stripAffectedBuys({ ...input, decision, affectedKeys: dropped }),
    acknowledgedKeys,
    rejectedKeys,
    issues,
  };
}

/**
 * Anchor a consumed review to the book actually supplied to that response at
 * its chosen revised limit. An unfillable review book cannot authorize a BUY.
 */
export function buildReviewedLiquidityBaselines(
  affected: readonly BuyLiquidityDeterioration[],
  revisedDecision: AgentDecision,
  marketsBySlug: ReadonlyMap<string, Market>,
): readonly BuyLiquidityBaseline[] {
  const result: BuyLiquidityBaseline[] = [];
  for (const item of affected) {
    if (
      revisedDecision.candidateDispositions.some(
        (disposition) => disposition.marketSlug === item.snapshot.market.slug,
      )
    )
      continue;
    const intent = intents(revisedDecision).find(
      (candidate) => keyFor(candidate, marketsBySlug) === item.key,
    );
    const limitPrice = intent?.maximumEntryPrice;
    if (
      intent === undefined ||
      limitPrice === undefined ||
      !finite(limitPrice, 0, 1) ||
      limitPrice.isZero()
    )
      continue;
    const availableQuantity = totalEligibleQuantity(
      reviewedLevels(item),
      "BUY",
      limitPrice,
    );
    if (availableQuantity.lte(0)) continue;
    result.push({
      key: item.key,
      marketId: item.snapshot.market.id,
      marketSlug: item.snapshot.market.slug,
      side: item.snapshot.proposal.side,
      limitPrice,
      availableQuantity,
      requestedQuantity: item.intendedQuantity,
      bookObservedAt: item.snapshot.book.observedAt,
      source: "REASSESSMENT_BOOK",
    });
  }
  return result;
}

function reviewedLevels(item: BuyLiquidityDeterioration) {
  return canonicalBookLevels(
    item.snapshot.book,
    item.snapshot.proposal.side,
    "BUY",
  )
    .filter((level) => level.quantity.gt(0))
    .toSorted((left, right) => left.price.comparedTo(right.price))
    .slice(0, 5);
}
