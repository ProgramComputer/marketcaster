import type { ExchangeId, RuntimeMode } from "../domain/primitives.js";
import type { CandidateFunnel } from "../agent/candidate-funnel.js";
import type { ShadowLedgerCycleReport } from "./shadow-ledger.js";

export interface PositionReport {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly quantity: string;
  readonly availableQuantity: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly liquidationValue?: string;
  readonly unrealizedPnl?: string;
  readonly accountValueFraction?: string;
}

export interface PortfolioAllocationReport {
  readonly cashValue: string;
  readonly positionLiquidationValue: string;
  readonly totalPositionCostBasis: string;
  readonly cashFraction?: string;
  readonly positionFraction?: string;
}

export interface AccountPerformanceReport {
  readonly positionRealizedPnl: string;
  readonly positionUnrealizedPnl: string;
  readonly recentRealizedPnl: string;
  readonly realizedOutcomeCount: number;
  readonly profitableOutcomeCount: number;
  readonly losingOutcomeCount: number;
  readonly flatOutcomeCount: number;
  readonly profitableOutcomeFraction?: string;
}

export interface AccountReport {
  readonly currentBalance: string;
  readonly buyingPower: string;
  readonly exchangeReportedValue: string;
  readonly arenaAccountValue: string;
  readonly riskEquity: string;
  readonly positionCount: number;
  readonly openOrderCount: number;
  readonly activityBreakdown: {
    readonly tradingPnl: string;
    readonly deposits: string;
    readonly withdrawals: string;
    readonly rebates: string;
    readonly programCredits: string;
    readonly otherBalanceChanges: string;
  };
  readonly allocation: PortfolioAllocationReport;
  readonly performance: AccountPerformanceReport;
  readonly positions: readonly PositionReport[];
}

export interface ObservedTradeReport {
  readonly tradeId: string;
  readonly marketSlug: string;
  readonly side?: "YES" | "NO";
  readonly action?: "BUY" | "SELL";
  readonly yesPrice?: string;
  readonly price: string;
  readonly quantity: string;
  readonly costBasis: string;
  readonly fees?: string;
  readonly realizedPnl?: string;
  readonly state: string;
  readonly aggressor: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ObservedSettlementReport {
  readonly marketSlug: string;
  readonly realizedPnl: string;
  readonly resolvedAt: string;
}

export interface ObservedBalanceChangeReport {
  readonly activityType: string;
  readonly amount: string;
  readonly createdAt: string;
}

export interface ObservedAccountActivityView {
  readonly observedAt: string;
  readonly activityCount: number;
  readonly tradeCount: number;
  readonly effectiveTradeCount: number;
  readonly closedTradeCount: number;
  readonly settlementCount: number;
  readonly balanceChangeCount: number;
  readonly trades: readonly ObservedTradeReport[];
  readonly closedTrades: readonly ObservedTradeReport[];
  readonly settlements: readonly ObservedSettlementReport[];
  readonly balanceChanges: readonly ObservedBalanceChangeReport[];
  readonly realizedTradingPnl: string;
}

export interface ExchangeObservedActivityReport {
  /** The exchange snapshot is authoritative for occurrence, not attribution. */
  readonly source: "EXCHANGE_ACCOUNT_SNAPSHOT";
  readonly attribution: "UNATTRIBUTED";
  readonly before: ObservedAccountActivityView;
  readonly after: ObservedAccountActivityView;
  /** New or updated activity records absent from the cycle-start snapshot. */
  readonly newlyObserved: ObservedAccountActivityView;
}

export interface PerformanceComparisonReport {
  readonly arenaAccountValueChange: string;
  readonly buyingPowerChange: string;
  readonly recentRealizedPnlChange: string;
  readonly positionRealizedPnlChange: string;
  readonly positionUnrealizedPnlChange: string;
}

export interface AgentBeliefReport {
  readonly id: string;
  readonly type: string;
  readonly confidence: number;
  readonly content: string;
  readonly marketSlugs: readonly string[];
  readonly evidenceUpdatedAt: string;
  readonly invalidationConditions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentPlanReport {
  readonly content: string;
  readonly marketSlugs: readonly string[];
  readonly updatedAt: string;
}

export interface AgentStateSnapshotReport {
  readonly mode: "STATELESS" | "PERSISTENT";
  readonly beliefs: readonly AgentBeliefReport[];
  readonly reportedBeliefCount: number;
  readonly totalBeliefCount: number;
  readonly truncated: boolean;
  readonly nextCyclePlan: AgentPlanReport | null;
  readonly longTermPlan: AgentPlanReport | null;
}

export interface AgentStateReport {
  readonly before: AgentStateSnapshotReport;
  readonly after: AgentStateSnapshotReport;
  readonly changes: {
    readonly comparisonComplete: boolean;
    readonly reportedAddedBeliefIds: readonly string[];
    readonly reportedUpdatedBeliefIds: readonly string[];
    readonly reportedRemovedBeliefIds: readonly string[];
  };
}

export interface DecisionEvidenceReport {
  readonly title: string;
  readonly url: string;
  readonly evidenceClass?: "CURRENT_REPORT" | "LIVE_DATA" | "BACKGROUND";
  readonly claimExcerpt?: string;
  readonly claimEventYear?: number | null;
  readonly publishedAt?: string;
  readonly asOf?: string;
  readonly relevance: string;
}

export interface ProposalReport {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly estimatedProbability: string;
  readonly maximumRiskUsd: string;
  readonly confidence: string;
  readonly thesis: string;
  readonly settlementVerification: string;
  readonly invalidationConditions: string;
  readonly evidence: readonly DecisionEvidenceReport[];
}

export interface PortfolioTargetReport {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly targetCostBasisFraction: string;
  readonly estimatedProbability: string;
  readonly probabilityLowerBound: string;
  readonly probabilityUpperBound: string;
  readonly maximumEntryPrice?: string;
  readonly minimumExitPrice?: string;
  readonly confidence: string;
  readonly thesis: string;
  readonly settlementVerification: string;
  readonly invalidationConditions: string;
  readonly evidence: readonly DecisionEvidenceReport[];
}

export interface PortfolioTargetReconciliationReport {
  readonly targetIndex: number;
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly kind: "PROPOSED" | "HOLD" | "BLOCKED";
  readonly targetCostBasisUsd: string;
  readonly currentCostBasisUsd: string;
  readonly reason: string;
  readonly action?: "BUY" | "SELL";
  readonly proposalIndex?: number;
  readonly message?: string;
}

export interface CandidateDispositionReport {
  readonly marketSlug: string;
  readonly side?: "YES" | "NO";
  readonly outcome: "HOLD_UNCHANGED" | "PASS";
  readonly reasonCode: string;
  readonly rationale: string;
  readonly estimatedProbability?: string;
  readonly probabilityLowerBound?: string;
  readonly probabilityUpperBound?: string;
  readonly evidence: readonly DecisionEvidenceReport[];
}

export interface ValidatedProposalReport extends ProposalReport {
  readonly probabilityLowerBound: string;
  readonly probabilityUpperBound: string;
  readonly riskAdjustedProbability: string;
  readonly quantity: string;
  readonly canonicalLimitPrice: string;
  readonly expectedSpend: string;
  readonly estimatedFees: string;
  readonly conservativeFeeReserve: string;
  readonly minimumExecutionSpend: string;
  readonly maximumExecutionSpend: string;
  readonly netEdge?: string;
}

export interface RejectedProposalReport {
  readonly marketSlug: string;
  readonly code: string;
  readonly reason: string;
}

export interface ExecutionReport {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly quantity: string;
  readonly canonicalLimitPrice: string;
  readonly status: string;
  readonly orderId?: string;
  readonly filledQuantity: string;
  readonly averageFillPrice?: string;
  readonly fees: string;
  readonly finalState: string;
  readonly skippedReason?: string;
  readonly ambiguousReason?: string;
}

export interface ErrorReport {
  readonly stage: string;
  readonly name: string;
  readonly message: string;
}

export interface CycleReport {
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly exchangeId: ExchangeId;
  readonly status: "SUCCESS" | "PASS" | "FAILED" | "AMBIGUOUS" | "SAFETY_STOP";
  readonly outcome:
    | "NO_PROPOSAL"
    | "ALL_REJECTED"
    | "OBSERVE_ONLY"
    | "EXECUTION_SKIPPED"
    | "NO_FILL"
    | "FILLED"
    | "FAILED"
    | "AMBIGUOUS"
    | "SAFETY_STOP";
  readonly completionReason: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly accountBefore: AccountReport;
  readonly accountAfter: AccountReport;
  readonly performance: PerformanceComparisonReport;
  readonly exchangeObservedActivity: ExchangeObservedActivityReport;
  readonly agentState: AgentStateReport;
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
  readonly candidateFunnel: CandidateFunnel;
  readonly shadowLedger?: ShadowLedgerCycleReport;
  readonly agent: {
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
    readonly summary: string;
    readonly portfolioTargets?: readonly PortfolioTargetReport[];
    readonly targetReconciliations?: readonly PortfolioTargetReconciliationReport[];
    readonly candidateDispositions?: readonly CandidateDispositionReport[];
    readonly proposals: readonly ProposalReport[];
    readonly tokenUsage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens?: number;
      readonly cachedInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      readonly cacheCreation5mInputTokens?: number;
      readonly cacheCreation1hInputTokens?: number;
      readonly reasoningOutputTokens?: number;
    };
    readonly cacheDiagnostics?: {
      readonly rounds: number;
      readonly comparisonRequests: number;
      readonly roundsWithCacheReads: number;
      readonly promptInputTokens: number;
      readonly cacheReadFraction: string;
      readonly rawStateCounts: Readonly<Record<string, number>>;
      readonly missReasonCounts: Readonly<Record<string, number>>;
      readonly missedInputTokens: number;
    };
    readonly decisionAudit?: {
      readonly evidence: {
        readonly valid: boolean;
        readonly verifiedSourceCount: number;
        readonly verifiedCurrentUrlCount: number;
        readonly independentCurrentDomainCount: number;
        readonly blockingIssueCount: number;
        readonly advisoryIssueCount: number;
      };
      readonly coverage: {
        readonly valid: boolean;
        readonly requiredMarketCount: number;
        readonly explicitlyTargeted: number;
        readonly explicitlyDispositioned: number;
        readonly issueCount: number;
      };
      readonly persistence: {
        readonly valid: boolean;
        readonly mutationCount: number;
        readonly issueCount: number;
      };
    };
    readonly estimatedCostUsd?: string;
  };
  readonly risk: {
    readonly accepted: readonly ValidatedProposalReport[];
    readonly rejected: readonly RejectedProposalReport[];
  };
  /** Execution attempts made by this cycle only. */
  readonly currentCycleExecutions: readonly ExecutionReport[];
  /** @deprecated Use currentCycleExecutions. Retained for report consumers. */
  readonly executions: readonly ExecutionReport[];
  readonly warnings: readonly string[];
  readonly errors: readonly ErrorReport[];
}
