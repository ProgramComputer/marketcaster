import { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type {
  AccountActivity,
  BalanceChangeActivity,
  ResolutionActivity,
  TradeActivity,
} from "../domain/activity.js";
import type { ExchangeId, RuntimeMode } from "../domain/primitives.js";
import type { ExecutionRun } from "../execution/executor.js";
import type { PortfolioValuation } from "../portfolio/valuation.js";
import type { PortfolioTargetReconciliationResult } from "../portfolio/target-reconciliation.js";
import type { ProposalValidationResult } from "../risk/validate.js";
import { calculatePerformance } from "../portfolio/performance.js";
import type { CandidateFunnel } from "../agent/candidate-funnel.js";
import {
  statelessAgentStateContext,
  type AgentStateContext,
} from "../agent/agent-state.js";
import type {
  AccountReport,
  AgentStateReport,
  AgentStateSnapshotReport,
  CycleReport,
  ExchangeObservedActivityReport,
  ExecutionReport,
  ObservedAccountActivityView,
  ObservedBalanceChangeReport,
  ObservedSettlementReport,
  ObservedTradeReport,
  ProposalReport,
  PortfolioTargetReport,
  PortfolioTargetReconciliationReport,
  CandidateDispositionReport,
  DecisionEvidenceReport,
} from "./types.js";

interface DecisionEvidenceReportInput {
  readonly title: string;
  readonly url: string;
  readonly evidenceClass?:
    "CURRENT_REPORT" | "LIVE_DATA" | "BACKGROUND" | undefined;
  readonly claimExcerpt?: string | undefined;
  readonly claimEventYear?: number | null | undefined;
  readonly publishedAt?: string | undefined;
  readonly asOf?: string | undefined;
  readonly relevance: string;
}

export interface DecisionReportInput {
  readonly cycleSummary: string;
  readonly portfolioTargets?: readonly {
    readonly marketSlug: string;
    readonly side: "YES" | "NO";
    readonly targetCostBasisFraction: { toFixed(): string };
    readonly estimatedProbability: { toFixed(): string };
    readonly probabilityLowerBound: { toFixed(): string };
    readonly probabilityUpperBound: { toFixed(): string };
    readonly maximumEntryPrice?: { toFixed(): string } | undefined;
    readonly minimumExitPrice?: { toFixed(): string } | undefined;
    readonly confidence: string;
    readonly thesis: string;
    readonly settlementVerification: string;
    readonly invalidationConditions: string;
    readonly evidence: readonly DecisionEvidenceReportInput[];
  }[];
  readonly candidateDispositions?: readonly {
    readonly marketSlug: string;
    readonly side?: "YES" | "NO" | null | undefined;
    readonly outcome: "HOLD_UNCHANGED" | "PASS";
    readonly reasonCode: string;
    readonly rationale: string;
    readonly estimatedProbability?: { toFixed(): string } | null | undefined;
    readonly probabilityLowerBound?: { toFixed(): string } | null | undefined;
    readonly probabilityUpperBound?: { toFixed(): string } | null | undefined;
    readonly evidence: readonly DecisionEvidenceReportInput[];
  }[];
  readonly proposals: readonly {
    readonly marketSlug: string;
    readonly side: "YES" | "NO";
    readonly action: "BUY" | "SELL";
    readonly estimatedProbability: { toFixed(): string };
    readonly maximumRiskUsd: { toFixed(): string };
    readonly confidence: string;
    readonly thesis: string;
    readonly settlementVerification: string;
    readonly invalidationConditions: string;
    readonly evidence: readonly DecisionEvidenceReportInput[];
  }[];
}

export interface BuildCycleReportInput {
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly exchangeId: ExchangeId;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly accountBefore: AccountSnapshot;
  readonly accountAfter: AccountSnapshot;
  readonly valuationBefore: PortfolioValuation;
  readonly valuationAfter: PortfolioValuation;
  readonly agentStateBefore?: AgentStateContext;
  readonly agentStateAfter?: AgentStateContext;
  readonly marketDiscovery: {
    readonly catalogued: number;
    readonly surfaced: number;
    readonly inspected: number;
    readonly preloadedHeld: number;
    readonly preloadedOpportunities: number;
    readonly exchangeRankedOpportunities?: number;
    readonly familyScoutedOpportunities?: number;
    readonly categories: Readonly<Record<string, number>>;
  };
  readonly provider: string;
  readonly model: string;
  readonly marketDiscoveryCount: number;
  readonly webSearchCount: number;
  readonly evidenceSourceReadCount: number;
  readonly successfulEvidenceSourceReadCount: number;
  readonly marketDetailCount: number;
  readonly marketAnalysisCount: number;
  readonly tradePreviewCount: number;
  readonly noteOperationCount: number;
  readonly stateOperationCount: number;
  readonly candidateFunnel: CandidateFunnel;
  readonly shadowLedger?: NonNullable<CycleReport["shadowLedger"]>;
  readonly tokenUsage?: NonNullable<CycleReport["agent"]["tokenUsage"]>;
  readonly cacheDiagnostics?: NonNullable<
    CycleReport["agent"]["cacheDiagnostics"]
  >;
  readonly decisionAudit?: NonNullable<CycleReport["agent"]["decisionAudit"]>;
  readonly decision: DecisionReportInput;
  readonly targetReconciliation?: PortfolioTargetReconciliationResult;
  readonly validation: ProposalValidationResult;
  readonly execution: ExecutionRun;
  readonly warnings?: readonly string[];
  readonly errors?: CycleReport["errors"];
  readonly statusOverride?: Extract<
    CycleReport["status"],
    "FAILED" | "AMBIGUOUS" | "SAFETY_STOP"
  >;
}

function evidenceReport(
  evidence: DecisionEvidenceReportInput,
): DecisionEvidenceReport {
  return {
    title: evidence.title,
    url: evidence.url,
    ...(evidence.evidenceClass === undefined
      ? {}
      : { evidenceClass: evidence.evidenceClass }),
    ...(evidence.claimExcerpt === undefined
      ? {}
      : { claimExcerpt: evidence.claimExcerpt }),
    ...(evidence.claimEventYear === undefined
      ? {}
      : { claimEventYear: evidence.claimEventYear }),
    ...(evidence.publishedAt === undefined
      ? {}
      : { publishedAt: evidence.publishedAt }),
    ...(evidence.asOf === undefined ? {} : { asOf: evidence.asOf }),
    relevance: evidence.relevance,
  };
}

function proposalReport(
  proposal: DecisionReportInput["proposals"][number],
): ProposalReport {
  return {
    marketSlug: proposal.marketSlug,
    side: proposal.side,
    action: proposal.action,
    estimatedProbability: proposal.estimatedProbability.toFixed(),
    maximumRiskUsd: proposal.maximumRiskUsd.toFixed(),
    confidence: proposal.confidence,
    thesis: proposal.thesis,
    settlementVerification: proposal.settlementVerification,
    invalidationConditions: proposal.invalidationConditions,
    evidence: proposal.evidence.map(evidenceReport),
  };
}

function portfolioTargetReport(
  target: NonNullable<DecisionReportInput["portfolioTargets"]>[number],
): PortfolioTargetReport {
  return {
    marketSlug: target.marketSlug,
    side: target.side,
    targetCostBasisFraction: target.targetCostBasisFraction.toFixed(),
    estimatedProbability: target.estimatedProbability.toFixed(),
    probabilityLowerBound: target.probabilityLowerBound.toFixed(),
    probabilityUpperBound: target.probabilityUpperBound.toFixed(),
    ...(target.maximumEntryPrice === undefined
      ? {}
      : { maximumEntryPrice: target.maximumEntryPrice.toFixed() }),
    ...(target.minimumExitPrice === undefined
      ? {}
      : { minimumExitPrice: target.minimumExitPrice.toFixed() }),
    confidence: target.confidence,
    thesis: target.thesis,
    settlementVerification: target.settlementVerification,
    invalidationConditions: target.invalidationConditions,
    evidence: target.evidence.map(evidenceReport),
  };
}

function candidateDispositionReport(
  disposition: NonNullable<
    DecisionReportInput["candidateDispositions"]
  >[number],
): CandidateDispositionReport {
  return {
    marketSlug: disposition.marketSlug,
    ...(disposition.side === undefined || disposition.side === null
      ? {}
      : { side: disposition.side }),
    outcome: disposition.outcome,
    reasonCode: disposition.reasonCode,
    rationale: disposition.rationale,
    ...(disposition.estimatedProbability === undefined ||
    disposition.estimatedProbability === null
      ? {}
      : { estimatedProbability: disposition.estimatedProbability.toFixed() }),
    ...(disposition.probabilityLowerBound === undefined ||
    disposition.probabilityLowerBound === null
      ? {}
      : {
          probabilityLowerBound: disposition.probabilityLowerBound.toFixed(),
        }),
    ...(disposition.probabilityUpperBound === undefined ||
    disposition.probabilityUpperBound === null
      ? {}
      : {
          probabilityUpperBound: disposition.probabilityUpperBound.toFixed(),
        }),
    evidence: disposition.evidence.map(evidenceReport),
  };
}

function targetReconciliationReport(
  disposition: PortfolioTargetReconciliationResult["dispositions"][number],
): PortfolioTargetReconciliationReport {
  return {
    targetIndex: disposition.targetIndex,
    marketSlug: disposition.marketSlug,
    side: disposition.side,
    kind: disposition.kind,
    targetCostBasisUsd: disposition.targetCostBasisUsd.toFixed(),
    currentCostBasisUsd: disposition.currentCostBasisUsd.toFixed(),
    reason: disposition.reason,
    ...(disposition.kind === "PROPOSED"
      ? {
          action: disposition.action,
          proposalIndex: disposition.proposalIndex,
        }
      : {}),
    ...(disposition.kind === "BLOCKED" ? { message: disposition.message } : {}),
  };
}

function accountReport(
  snapshot: AccountSnapshot,
  valuation: PortfolioValuation,
): AccountReport {
  const performance = calculatePerformance(snapshot.recentActivities);
  const valuesBySlug = new Map(
    valuation.positions.map((position) => [
      `${position.marketSlug}:${position.side}`,
      position,
    ]),
  );
  const positionLiquidationValue = valuation.positions.reduce(
    (total, position) => total.plus(position.liquidationValue),
    new Decimal(0),
  );
  const totalPositionCostBasis = snapshot.positions.reduce(
    (total, position) => total.plus(position.costBasis),
    new Decimal(0),
  );
  const positionRealizedPnl = snapshot.positions.reduce(
    (total, position) => total.plus(position.realizedPnl),
    new Decimal(0),
  );
  const positionUnrealizedPnl = positionLiquidationValue.minus(
    totalPositionCostBasis,
  );
  const realizedOutcomes = [
    ...performance.effectiveTrades
      .filter((trade) => trade.realizedPnl !== undefined)
      .map((trade) => trade.realizedPnl ?? new Decimal(0)),
    ...snapshot.recentActivities
      .filter(
        (activity): activity is ResolutionActivity =>
          activity.kind === "RESOLUTION",
      )
      .map((resolution) => resolution.realizedPnl),
  ];
  const profitableOutcomeCount = realizedOutcomes.filter((pnl) =>
    pnl.gt(0),
  ).length;
  const losingOutcomeCount = realizedOutcomes.filter((pnl) => pnl.lt(0)).length;
  const flatOutcomeCount = realizedOutcomes.filter((pnl) => pnl.eq(0)).length;
  const hasPositiveAccountValue = valuation.arenaAccountValue.gt(0);
  return {
    currentBalance: snapshot.currentBalance.toFixed(),
    buyingPower: snapshot.buyingPower.toFixed(),
    exchangeReportedValue: valuation.exchangeReportedValue.toFixed(),
    arenaAccountValue: valuation.arenaAccountValue.toFixed(),
    riskEquity: valuation.riskEquity.toFixed(),
    positionCount: snapshot.positions.length,
    openOrderCount: snapshot.openOrders.length,
    activityBreakdown: {
      tradingPnl: performance.tradingPnl.toFixed(),
      deposits: performance.deposits.toFixed(),
      withdrawals: performance.withdrawals.toFixed(),
      rebates: performance.rebates.toFixed(),
      programCredits: performance.programCredits.toFixed(),
      otherBalanceChanges: performance.otherBalanceChanges.toFixed(),
    },
    allocation: {
      cashValue: snapshot.buyingPower.toFixed(),
      positionLiquidationValue: positionLiquidationValue.toFixed(),
      totalPositionCostBasis: totalPositionCostBasis.toFixed(),
      ...(hasPositiveAccountValue
        ? {
            cashFraction: snapshot.buyingPower
              .div(valuation.arenaAccountValue)
              .toFixed(),
            positionFraction: positionLiquidationValue
              .div(valuation.arenaAccountValue)
              .toFixed(),
          }
        : {}),
    },
    performance: {
      positionRealizedPnl: positionRealizedPnl.toFixed(),
      positionUnrealizedPnl: positionUnrealizedPnl.toFixed(),
      recentRealizedPnl: performance.tradingPnl.toFixed(),
      realizedOutcomeCount: realizedOutcomes.length,
      profitableOutcomeCount,
      losingOutcomeCount,
      flatOutcomeCount,
      ...(realizedOutcomes.length === 0
        ? {}
        : {
            profitableOutcomeFraction: new Decimal(profitableOutcomeCount)
              .div(realizedOutcomes.length)
              .toFixed(),
          }),
    },
    positions: snapshot.positions.map((position) => {
      const liquidation = valuesBySlug.get(
        `${position.marketSlug}:${position.side}`,
      );
      const liquidationValue = liquidation?.liquidationValue;
      return {
        marketSlug: position.marketSlug,
        side: position.side,
        quantity: position.quantity.toFixed(),
        availableQuantity: position.availableQuantity.toFixed(),
        costBasis: position.costBasis.toFixed(),
        realizedPnl: position.realizedPnl.toFixed(),
        ...(liquidationValue === undefined
          ? {}
          : {
              liquidationValue: liquidationValue.toFixed(),
              unrealizedPnl: liquidationValue
                .minus(position.costBasis)
                .toFixed(),
              ...(hasPositiveAccountValue
                ? {
                    accountValueFraction: liquidationValue
                      .div(valuation.arenaAccountValue)
                      .toFixed(),
                  }
                : {}),
            }),
      };
    }),
  };
}

function latestTradeStates(
  activities: readonly AccountActivity[],
): readonly TradeActivity[] {
  const byTradeId = new Map<string, TradeActivity>();
  for (const activity of activities) {
    if (activity.kind !== "TRADE") continue;
    const previous = byTradeId.get(activity.tradeId);
    if (previous === undefined || activity.updatedAt > previous.updatedAt) {
      byTradeId.set(activity.tradeId, activity);
    }
  }
  return [...byTradeId.values()].toSorted(
    (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
  );
}

function observedTradeReport(trade: TradeActivity): ObservedTradeReport {
  return {
    tradeId: trade.tradeId,
    marketSlug: trade.marketSlug,
    ...(trade.side === undefined ? {} : { side: trade.side }),
    ...(trade.action === undefined ? {} : { action: trade.action }),
    ...(trade.yesPrice === undefined
      ? {}
      : { yesPrice: trade.yesPrice.toFixed() }),
    price: trade.price.toFixed(),
    quantity: trade.quantity.toFixed(),
    costBasis: trade.costBasis.toFixed(),
    ...(trade.fees === undefined ? {} : { fees: trade.fees.toFixed() }),
    ...(trade.realizedPnl === undefined
      ? {}
      : { realizedPnl: trade.realizedPnl.toFixed() }),
    state: trade.state,
    aggressor: trade.aggressor,
    createdAt: trade.createdAt.toISOString(),
    updatedAt: trade.updatedAt.toISOString(),
  };
}

function observedSettlementReport(
  settlement: ResolutionActivity,
): ObservedSettlementReport {
  return {
    marketSlug: settlement.marketSlug,
    realizedPnl: settlement.realizedPnl.toFixed(),
    resolvedAt: settlement.resolvedAt.toISOString(),
  };
}

function observedBalanceChangeReport(
  balanceChange: BalanceChangeActivity,
): ObservedBalanceChangeReport {
  return {
    activityType: balanceChange.activityType,
    amount: balanceChange.amount.toFixed(),
    createdAt: balanceChange.createdAt.toISOString(),
  };
}

function activityView(
  activities: readonly AccountActivity[],
  observedAt: Date,
): ObservedAccountActivityView {
  const latestTrades = latestTradeStates(activities);
  const effectiveTrades = latestTrades.filter(
    (trade) => trade.state !== "TRADE_STATE_BUSTED",
  );
  const closedTrades = effectiveTrades.filter(
    (trade) => trade.realizedPnl !== undefined,
  );
  const settlements = activities
    .filter(
      (activity): activity is ResolutionActivity =>
        activity.kind === "RESOLUTION",
    )
    .toSorted(
      (left, right) => right.resolvedAt.getTime() - left.resolvedAt.getTime(),
    );
  const balanceChanges = activities
    .filter(
      (activity): activity is BalanceChangeActivity =>
        activity.kind === "BALANCE_CHANGE",
    )
    .toSorted(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  return {
    observedAt: observedAt.toISOString(),
    activityCount: activities.length,
    tradeCount: latestTrades.length,
    effectiveTradeCount: effectiveTrades.length,
    closedTradeCount: closedTrades.length,
    settlementCount: settlements.length,
    balanceChangeCount: balanceChanges.length,
    trades: latestTrades.map(observedTradeReport),
    closedTrades: closedTrades.map(observedTradeReport),
    settlements: settlements.map(observedSettlementReport),
    balanceChanges: balanceChanges.map(observedBalanceChangeReport),
    realizedTradingPnl: calculatePerformance(activities).tradingPnl.toFixed(),
  };
}

function activityIdentity(activity: AccountActivity): string {
  if (activity.kind === "TRADE") {
    return [
      activity.kind,
      activity.tradeId,
      activity.marketSlug,
      activity.side ?? "",
      activity.action ?? "",
      activity.yesPrice?.toFixed() ?? "",
      activity.createdAt.toISOString(),
      activity.updatedAt.toISOString(),
      activity.state,
      activity.price.toFixed(),
      activity.quantity.toFixed(),
      activity.costBasis.toFixed(),
      activity.fees?.toFixed() ?? "",
      activity.realizedPnl?.toFixed() ?? "",
      activity.aggressor ? "1" : "0",
    ].join("\u0000");
  }
  if (activity.kind === "RESOLUTION") {
    return [
      activity.kind,
      activity.marketSlug,
      activity.resolvedAt.toISOString(),
      activity.realizedPnl.toFixed(),
    ].join("\u0000");
  }
  return [
    activity.kind,
    activity.activityType,
    activity.createdAt.toISOString(),
    activity.amount.toFixed(),
  ].join("\u0000");
}

function newlyObservedActivities(
  before: readonly AccountActivity[],
  after: readonly AccountActivity[],
): readonly AccountActivity[] {
  const availableBefore = new Map<string, number>();
  for (const activity of before) {
    const key = activityIdentity(activity);
    availableBefore.set(key, (availableBefore.get(key) ?? 0) + 1);
  }
  return after.filter((activity) => {
    const key = activityIdentity(activity);
    const remaining = availableBefore.get(key) ?? 0;
    if (remaining === 0) return true;
    availableBefore.set(key, remaining - 1);
    return false;
  });
}

function exchangeObservedActivity(
  before: AccountSnapshot,
  after: AccountSnapshot,
): ExchangeObservedActivityReport {
  return {
    source: "EXCHANGE_ACCOUNT_SNAPSHOT",
    attribution: "UNATTRIBUTED",
    before: activityView(before.recentActivities, before.observedAt),
    after: activityView(after.recentActivities, after.observedAt),
    newlyObserved: activityView(
      newlyObservedActivities(before.recentActivities, after.recentActivities),
      after.observedAt,
    ),
  };
}

function agentStateSnapshotReport(
  state: AgentStateContext,
): AgentStateSnapshotReport {
  return {
    mode: state.mode,
    beliefs: state.beliefs,
    reportedBeliefCount: state.beliefs.length,
    totalBeliefCount: state.mode === "PERSISTENT" ? state.totalBeliefCount : 0,
    truncated: state.mode === "PERSISTENT" ? state.truncated : false,
    nextCyclePlan: state.nextCyclePlan,
    longTermPlan: state.longTermPlan,
  };
}

function beliefFingerprint(
  belief: AgentStateSnapshotReport["beliefs"][number],
): string {
  return JSON.stringify(belief);
}

function agentStateReport(
  before: AgentStateContext,
  after: AgentStateContext,
): AgentStateReport {
  const beforeReport = agentStateSnapshotReport(before);
  const afterReport = agentStateSnapshotReport(after);
  const beforeById = new Map(
    beforeReport.beliefs.map((belief) => [belief.id, belief] as const),
  );
  const afterById = new Map(
    afterReport.beliefs.map((belief) => [belief.id, belief] as const),
  );
  return {
    before: beforeReport,
    after: afterReport,
    changes: {
      comparisonComplete: !beforeReport.truncated && !afterReport.truncated,
      reportedAddedBeliefIds: afterReport.beliefs
        .filter((belief) => !beforeById.has(belief.id))
        .map((belief) => belief.id),
      reportedUpdatedBeliefIds: afterReport.beliefs
        .filter((belief) => {
          const previous = beforeById.get(belief.id);
          return (
            previous !== undefined &&
            beliefFingerprint(previous) !== beliefFingerprint(belief)
          );
        })
        .map((belief) => belief.id),
      reportedRemovedBeliefIds: beforeReport.beliefs
        .filter((belief) => !afterById.has(belief.id))
        .map((belief) => belief.id),
    },
  };
}

function executionReports(execution: ExecutionRun): readonly ExecutionReport[] {
  return execution.attempts.map((attempt) => {
    const result = attempt.result;
    return {
      marketSlug: attempt.validated.order.marketSlug,
      side: attempt.validated.order.side,
      action: attempt.validated.order.action,
      quantity: attempt.validated.order.quantity.toFixed(),
      canonicalLimitPrice:
        attempt.validated.order.canonicalLimitPrice.toFixed(),
      status: result?.status ?? "SKIPPED",
      ...(result?.orderId === undefined ? {} : { orderId: result.orderId }),
      filledQuantity: result?.filledQuantity.toFixed() ?? "0",
      ...(result?.averageFillPrice === undefined
        ? {}
        : { averageFillPrice: result.averageFillPrice.toFixed() }),
      fees:
        result?.fees.toFixed() ??
        attempt.preview?.estimatedFees.toFixed() ??
        "0",
      finalState: result?.finalState ?? "UNKNOWN",
      ...(attempt.skippedReason === undefined
        ? {}
        : { skippedReason: attempt.skippedReason }),
      ...(result?.ambiguousReason === undefined
        ? {}
        : { ambiguousReason: result.ambiguousReason }),
    };
  });
}

function cycleOutcome(
  input: BuildCycleReportInput,
  executions: readonly ExecutionReport[],
  errors: CycleReport["errors"],
): CycleReport["outcome"] {
  if (input.statusOverride === "SAFETY_STOP") return "SAFETY_STOP";
  if (
    input.statusOverride === "AMBIGUOUS" ||
    executions.some((execution) => execution.status === "AMBIGUOUS")
  ) {
    return "AMBIGUOUS";
  }
  if (input.statusOverride === "FAILED" || errors.length > 0) return "FAILED";
  if (
    executions.some(
      (execution) =>
        execution.status === "FILLED" || execution.status === "PARTIAL",
    )
  ) {
    return "FILLED";
  }
  if (input.decision.proposals.length === 0) return "NO_PROPOSAL";
  if (input.validation.accepted.length === 0) return "ALL_REJECTED";
  if (input.mode !== "live") return "OBSERVE_ONLY";
  if (
    executions.length === 0 ||
    executions.every((execution) => execution.status === "SKIPPED")
  ) {
    return "EXECUTION_SKIPPED";
  }
  return "NO_FILL";
}

function completionReason(
  input: BuildCycleReportInput,
  outcome: CycleReport["outcome"],
  executions: readonly ExecutionReport[],
): string {
  const proposalCount = input.decision.proposals.length;
  const acceptedCount = input.validation.accepted.length;
  const rejectedCount = input.validation.rejected.length;
  const filledCount = executions.filter(
    (execution) =>
      execution.status === "FILLED" || execution.status === "PARTIAL",
  ).length;
  const targetMode = input.targetReconciliation !== undefined;
  switch (outcome) {
    case "NO_PROPOSAL":
      return targetMode
        ? "The cycle completed without a derived order; targets were already satisfied, blocked, or empty."
        : "The cycle completed without a trade proposal.";
    case "ALL_REJECTED":
      return `Risk validation accepted 0 of ${proposalCount} ${targetMode ? "derived orders" : "proposals"} and rejected ${rejectedCount}; no current-cycle order was attempted.`;
    case "OBSERVE_ONLY":
      return `Observe mode accepted ${acceptedCount} of ${proposalCount} ${targetMode ? "derived orders" : "proposals"} but does not place orders.`;
    case "EXECUTION_SKIPPED":
      return `Risk validation accepted ${acceptedCount} ${targetMode ? "derived orders" : "proposals"}, but no current-cycle order was submitted.`;
    case "NO_FILL":
      return `${executions.length} current-cycle execution attempts completed without a fill.`;
    case "FILLED":
      return `${filledCount} current-cycle orders filled or partially filled.`;
    case "FAILED":
      return "The cycle reported an error and did not complete normally.";
    case "AMBIGUOUS":
      return "At least one current-cycle execution had an ambiguous outcome.";
    case "SAFETY_STOP":
      return "A safety guard stopped current-cycle execution.";
  }
}

export function buildCycleReport(input: BuildCycleReportInput): CycleReport {
  const executions = executionReports(input.execution);
  const errors = input.errors ?? [];
  const outcome = cycleOutcome(input, executions, errors);
  const status: CycleReport["status"] =
    outcome === "FILLED"
      ? "SUCCESS"
      : outcome === "FAILED"
        ? "FAILED"
        : outcome === "AMBIGUOUS"
          ? "AMBIGUOUS"
          : outcome === "SAFETY_STOP"
            ? "SAFETY_STOP"
            : "PASS";
  const beforeReport = accountReport(
    input.accountBefore,
    input.valuationBefore,
  );
  const afterReport = accountReport(input.accountAfter, input.valuationAfter);
  const agentStateBefore =
    input.agentStateBefore ?? statelessAgentStateContext();
  const agentStateAfter = input.agentStateAfter ?? agentStateBefore;

  return {
    runId: input.runId,
    cycleId: input.cycleId,
    mode: input.mode,
    exchangeId: input.exchangeId,
    status,
    outcome,
    completionReason: completionReason(input, outcome, executions),
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMilliseconds:
      input.completedAt.getTime() - input.startedAt.getTime(),
    accountBefore: beforeReport,
    accountAfter: afterReport,
    performance: {
      arenaAccountValueChange: input.valuationAfter.arenaAccountValue
        .minus(input.valuationBefore.arenaAccountValue)
        .toFixed(),
      buyingPowerChange: input.accountAfter.buyingPower
        .minus(input.accountBefore.buyingPower)
        .toFixed(),
      recentRealizedPnlChange: new Decimal(
        afterReport.performance.recentRealizedPnl,
      )
        .minus(beforeReport.performance.recentRealizedPnl)
        .toFixed(),
      positionRealizedPnlChange: new Decimal(
        afterReport.performance.positionRealizedPnl,
      )
        .minus(beforeReport.performance.positionRealizedPnl)
        .toFixed(),
      positionUnrealizedPnlChange: new Decimal(
        afterReport.performance.positionUnrealizedPnl,
      )
        .minus(beforeReport.performance.positionUnrealizedPnl)
        .toFixed(),
    },
    exchangeObservedActivity: exchangeObservedActivity(
      input.accountBefore,
      input.accountAfter,
    ),
    agentState: agentStateReport(agentStateBefore, agentStateAfter),
    marketDiscovery: input.marketDiscovery,
    candidateFunnel: input.candidateFunnel,
    ...(input.shadowLedger === undefined
      ? {}
      : { shadowLedger: input.shadowLedger }),
    agent: {
      provider: input.provider,
      model: input.model,
      marketDiscoveryCount: input.marketDiscoveryCount,
      webSearchCount: input.webSearchCount,
      evidenceSourceReadCount: input.evidenceSourceReadCount,
      successfulEvidenceSourceReadCount:
        input.successfulEvidenceSourceReadCount,
      marketDetailCount: input.marketDetailCount,
      marketAnalysisCount: input.marketAnalysisCount,
      tradePreviewCount: input.tradePreviewCount,
      noteOperationCount: input.noteOperationCount,
      stateOperationCount: input.stateOperationCount,
      summary: input.decision.cycleSummary,
      ...(input.targetReconciliation === undefined ||
      input.decision.portfolioTargets === undefined
        ? {}
        : {
            portfolioTargets: input.decision.portfolioTargets.map(
              portfolioTargetReport,
            ),
          }),
      ...(input.targetReconciliation === undefined
        ? {}
        : {
            targetReconciliations: input.targetReconciliation.dispositions.map(
              targetReconciliationReport,
            ),
          }),
      candidateDispositions: (input.decision.candidateDispositions ?? []).map(
        candidateDispositionReport,
      ),
      proposals: input.decision.proposals.map(proposalReport),
      ...(input.tokenUsage === undefined
        ? {}
        : { tokenUsage: input.tokenUsage }),
      ...(input.cacheDiagnostics === undefined
        ? {}
        : { cacheDiagnostics: input.cacheDiagnostics }),
      ...(input.decisionAudit === undefined
        ? {}
        : { decisionAudit: input.decisionAudit }),
    },
    risk: {
      accepted: input.validation.accepted.map((accepted) => ({
        ...proposalReport(accepted.proposal),
        probabilityLowerBound:
          accepted.proposal.probabilityLowerBound.toFixed(),
        probabilityUpperBound:
          accepted.proposal.probabilityUpperBound.toFixed(),
        riskAdjustedProbability: accepted.authorizationProbability.toFixed(),
        quantity: accepted.order.quantity.toFixed(),
        canonicalLimitPrice: accepted.order.canonicalLimitPrice.toFixed(),
        expectedSpend: accepted.expectedSpend.toFixed(),
        estimatedFees: accepted.estimatedFees.toFixed(),
        conservativeFeeReserve: accepted.conservativeFeeReserve.toFixed(),
        minimumExecutionSpend: accepted.minimumExecutionSpend.toFixed(),
        maximumExecutionSpend: accepted.maximumExecutionSpend.toFixed(),
        ...(accepted.netEdge === undefined
          ? {}
          : { netEdge: accepted.netEdge.toFixed() }),
      })),
      rejected: input.validation.rejected.map((rejected) => ({
        marketSlug: rejected.proposal.marketSlug,
        code: rejected.code,
        reason: rejected.reason,
      })),
    },
    currentCycleExecutions: executions,
    executions,
    warnings: [
      ...input.valuationBefore.warnings,
      ...input.valuationAfter.warnings,
      ...(input.warnings ?? []),
    ],
    errors,
  };
}
