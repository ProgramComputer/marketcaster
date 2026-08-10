import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Decimal } from "decimal.js";
import type { Logger } from "pino";
import type { AgentConfig } from "../config/schema.js";
import type { PromptBundle } from "../config/prompts.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { Market, OrderBook } from "../domain/market.js";
import type { RuntimeMode } from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import { assertSafeMemoryScope } from "../exchanges/memory-scope.js";
import {
  ExecutionJournalError,
  SafetyGuardError,
  executeValidatedOrders,
  type ExecutionJournalHooks,
  type ExecutionRun,
} from "../execution/executor.js";
import type {
  DecisionProvider,
  TerminalDecisionRepairFeedback,
  DecisionTranscriptRound,
} from "../llm/decision-provider.js";
import { decisionLimitsFromConfig } from "../llm/decision-provider.js";
import {
  DecisionResearchTools,
  liveEvidenceLinePreview,
  systemLiveEvidenceSources,
  type MarketFamilyDetailsResult,
  type MarketFamilyDetailsToolInput,
} from "../llm/research-tools.js";
import { reconstructAccount } from "../portfolio/reconstruct.js";
import {
  reconcilePortfolioTargets,
  type PortfolioTargetReconciliationResult,
} from "../portfolio/target-reconciliation.js";
import {
  valuePortfolio,
  type PortfolioValuation,
} from "../portfolio/valuation.js";
import { buildCycleReport } from "../reporting/build-report.js";
import { persistCrossCycleHistory } from "../reporting/cross-cycle-history.js";
import {
  assertNoUnresolvedLiveJournals,
  UnresolvedLiveJournalError,
} from "../reporting/journal-recovery.js";
import { appendJobSummary } from "../reporting/job-summary.js";
import {
  acquireLiveCycleLock,
  type LiveCycleLock,
} from "../reporting/live-cycle-lock.js";
import { stageLogger } from "../reporting/logger.js";
import {
  createRunJournal,
  decisionTranscriptRoundArtifactKind,
  type CompletedRunJournalStage,
  type RunJournal,
} from "../reporting/run-journal.js";
import type { CycleReport } from "../reporting/types.js";
import {
  buildShadowLedgerCandidates,
  captureShadowLedgerObservations,
  degradedShadowLedgerReport,
  persistAndReconcileShadowLedger,
  type ShadowLedgerCaptureResult,
  type ShadowLedgerCycleReport,
} from "../reporting/shadow-ledger.js";
import {
  loadPreviousCycleAdvisory,
  persistCompletedCycleAdvisoryWithResult,
} from "../reporting/previous-cycle-advisory.js";
import { validateProposals, type RiskProposal } from "../risk/validate.js";
import { safeErrorMessage } from "../utilities/redaction.js";
import { withStageTimeout } from "../utilities/time.js";
import {
  buildAgentContext,
  buildMarketDetailContext,
  type BuildAgentContextInput,
  type DetailedMarketContext,
} from "./context-builder.js";
import { buildTerminalDecisionRepairFeedback } from "./decision-repair.js";
import {
  discoverMarketCatalog,
  MarketDetailResolver,
  MarketDiscoveryResolver,
  searchMarketFacets,
} from "./discovery.js";
import type { AgentDecision } from "./decision-schema.js";
import {
  validateDecisionCoverage,
  type DecisionCoverageReport,
} from "./decision-coverage.js";
import {
  fetchEvidencePage,
  validateDecisionEvidence,
  type EvidenceValidationReport,
} from "./evidence-provenance.js";
import { buildDecisionPrompt } from "./prompt-builder.js";
import { MarketAnalysisResolver } from "./market-analysis.js";
import { MarketFamilyResolver } from "./market-family-resolver.js";
import { familyScoutResearchKey } from "./family-scout.js";
import {
  buildEnrichedOpportunityBoard,
  selectRequiredPassedPriorityMarketSlugs,
} from "./opportunity-board.js";
import {
  FileAgentMemory,
  type AgentMemory,
  type AgentMemoryContext,
  StatelessAgentMemory,
} from "./memory.js";
import { AdvisoryTradePreviewResolver } from "./trade-preview.js";
import {
  FileAgentState,
  type AgentState,
  type AgentStateContext,
  StatelessAgentState,
} from "./agent-state.js";
import { buildCandidateFunnel } from "./candidate-funnel.js";
import {
  auditNoPositiveEdgePasses,
  type PassEdgeAuditReport,
} from "./pass-edge-audit.js";
import {
  PersistenceTransaction,
  StagedMutationLedger,
  type MutationProvenanceReport,
} from "./persistence-transaction.js";
import {
  freezeMarketSelectionSnapshot,
  observeMarketSelectionTreatment,
  replayMarketSelectionExperiment,
} from "../experiments/market-selection.js";

export interface CycleDependencies {
  readonly config: AgentConfig;
  readonly prompts: PromptBundle;
  readonly exchange: PredictionExchange;
  readonly decisionProvider: DecisionProvider;
  readonly mode: RuntimeMode;
  readonly logger: Logger;
  readonly runId?: string;
  readonly cycleId?: string;
  readonly now?: () => Date;
  readonly writeReports?: boolean;
  readonly journal?: RunJournal;
  readonly memory?: AgentMemory;
  readonly agentState?: AgentState;
}

function valuationContext(
  snapshot: AccountSnapshot,
  valuation: PortfolioValuation,
): NonNullable<BuildAgentContextInput["valuation"]> {
  return {
    conservativeAccountValue: valuation.arenaAccountValue,
    riskEquity: valuation.riskEquity,
    spendableCapital: valuation.spendableCapital,
    positions: snapshot.positions.map((position) => {
      const valued = valuation.positions.find(
        (item) =>
          item.marketSlug === position.marketSlug &&
          item.side === position.side,
      );
      return {
        marketSlug: position.marketSlug,
        ...(valued === undefined || valued.liquidation.fillableQuantity.isZero()
          ? {}
          : { liquidationBid: valued.liquidation.vwap }),
        ...(valued === undefined
          ? {}
          : {
              conservativeValue: valued.liquidationValue,
              unrealizedPnl: valued.liquidationValue.minus(position.costBasis),
            }),
      };
    }),
  };
}

function openingAdjustedYesProbability(snapshot: string): Decimal | undefined {
  const match =
    /opening-price-updated reference[^\n]*\):[^\n]*? (\d+(?:\.\d+)?)%,/iu.exec(
      snapshot,
    );
  if (match?.[1] === undefined) return undefined;
  const probability = new Decimal(match[1]).div(100);
  return probability.isFinite() && probability.gte(0) && probability.lte(1)
    ? probability
    : undefined;
}

interface FreshOfficialLiveProbabilities {
  readonly requiredMarketSlugs: ReadonlySet<string>;
  readonly selectedSideProbabilityByMarketSlug: ReadonlyMap<string, Decimal>;
}

interface OfficialLiveProbabilityRequest {
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
}

function normalizedParticipant(value: string): string {
  return (
    value
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.toSorted()
      .join(" ") ?? ""
  );
}

function officialYesProbability(snapshot: string): Decimal | undefined {
  const live = openingAdjustedYesProbability(snapshot);
  if (live !== undefined) return live;
  const completed =
    /\|\s*([^|]+?)\s+\d+\s+vs\s+([^|]+?)\s+\d+\s*\|\s*statusId\s+3\s*\|\s*winner\s+([^|\n]+)/iu.exec(
      snapshot,
    );
  if (
    completed?.[1] === undefined ||
    completed[2] === undefined ||
    completed[3] === undefined
  ) {
    return undefined;
  }
  const yesParticipant = normalizedParticipant(completed[1]);
  const noParticipant = normalizedParticipant(completed[2]);
  const winner = normalizedParticipant(completed[3]);
  if (winner === yesParticipant && winner !== noParticipant) {
    return new Decimal(1);
  }
  if (winner === noParticipant && winner !== yesParticipant) {
    return new Decimal(0);
  }
  return undefined;
}

async function refreshOfficialLiveProbabilities(
  requests: readonly OfficialLiveProbabilityRequest[],
  detailsBySlug: ReadonlyMap<string, DetailedMarketContext>,
  observedAt: Date,
  signal: AbortSignal,
): Promise<FreshOfficialLiveProbabilities> {
  const requiredMarketSlugs = new Set<string>();
  const selectedSideProbabilityByMarketSlug = new Map<string, Decimal>();
  const pagesByUrl = new Map<string, ReturnType<typeof fetchEvidencePage>>();
  await Promise.all(
    requests.map(async (request) => {
      const details = detailsBySlug.get(request.marketSlug);
      if (details === undefined) return;
      const source = systemLiveEvidenceSources(details, observedAt).find(
        (item) =>
          item.url === "https://tabletennis.setkacup.com/api/Matches/widget/en",
      );
      if (source === undefined) return;
      requiredMarketSlugs.add(request.marketSlug);
      try {
        let pending = pagesByUrl.get(source.url);
        if (pending === undefined) {
          pending = fetchEvidencePage(source.url, { signal });
          pagesByUrl.set(source.url, pending);
        }
        const page = await pending;
        const preview = liveEvidenceLinePreview(
          page.text,
          source.findHint,
          details.sessionOpenYesPrice,
        );
        const yesProbability =
          preview === undefined
            ? undefined
            : officialYesProbability(preview.preview);
        if (yesProbability === undefined) return;
        selectedSideProbabilityByMarketSlug.set(
          request.marketSlug,
          request.side === "YES"
            ? yesProbability
            : new Decimal(1).minus(yesProbability),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // The required slug remains without an override so validation rejects
        // it as changed rather than using the model's older score snapshot.
      }
    }),
  );
  return { requiredMarketSlugs, selectedSideProbabilityByMarketSlug };
}

function knownMarketMap(
  markets: readonly Market[],
): ReadonlyMap<string, Market> {
  return new Map(markets.map((market) => [market.slug, market]));
}

function aggregateTokenUsage(
  rounds: readonly DecisionTranscriptRound[],
): NonNullable<CycleReport["agent"]["tokenUsage"]> | undefined {
  const usages = rounds.flatMap((round) =>
    round.tokenUsage === undefined ? [] : [round.tokenUsage],
  );
  if (usages.length === 0) return undefined;
  const sum = (
    select: (usage: (typeof usages)[number]) => number | undefined,
  ): number | undefined => {
    const values = usages.flatMap((usage) => {
      const value = select(usage);
      return value === undefined ? [] : [value];
    });
    return values.length === 0
      ? undefined
      : values.reduce((total, value) => total + value, 0);
  };
  const totalTokens = sum((usage) => usage.totalTokens);
  const cachedInputTokens = sum((usage) => usage.cachedInputTokens);
  const cacheCreationInputTokens = sum(
    (usage) => usage.cacheCreationInputTokens,
  );
  const cacheCreation5mInputTokens = sum(
    (usage) => usage.cacheCreation5mInputTokens,
  );
  const cacheCreation1hInputTokens = sum(
    (usage) => usage.cacheCreation1hInputTokens,
  );
  const reasoningOutputTokens = sum((usage) => usage.reasoningOutputTokens);
  return {
    inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
    outputTokens: usages.reduce(
      (total, usage) => total + usage.outputTokens,
      0,
    ),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens }),
    ...(cacheCreation5mInputTokens === undefined
      ? {}
      : { cacheCreation5mInputTokens }),
    ...(cacheCreation1hInputTokens === undefined
      ? {}
      : { cacheCreation1hInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

function aggregateCacheDiagnostics(
  rounds: readonly DecisionTranscriptRound[],
): NonNullable<CycleReport["agent"]["cacheDiagnostics"]> | undefined {
  const diagnosticRounds = rounds.filter(
    (round) => round.cacheDiagnostic !== undefined,
  );
  if (diagnosticRounds.length === 0) return undefined;

  const rawStateCounts: Record<string, number> = {};
  const missReasonCounts: Record<string, number> = {};
  let missedInputTokens = 0;
  for (const round of diagnosticRounds) {
    const diagnostic = round.cacheDiagnostic;
    if (diagnostic === undefined) continue;
    rawStateCounts[diagnostic.state] =
      (rawStateCounts[diagnostic.state] ?? 0) + 1;
    if (diagnostic.reasonType !== undefined) {
      missReasonCounts[diagnostic.reasonType] =
        (missReasonCounts[diagnostic.reasonType] ?? 0) + 1;
    }
    missedInputTokens += diagnostic.missedInputTokens ?? 0;
  }

  const promptInputTokens = rounds.reduce((total, round) => {
    const usage = round.tokenUsage;
    if (usage === undefined) return total;
    return (
      total +
      usage.inputTokens +
      (usage.cachedInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0)
    );
  }, 0);
  const cacheReadTokens = rounds.reduce(
    (total, round) => total + (round.tokenUsage?.cachedInputTokens ?? 0),
    0,
  );
  return {
    rounds: diagnosticRounds.length,
    comparisonRequests: diagnosticRounds.filter(
      (round) => round.diagnosticsPreviousMessageId != null,
    ).length,
    roundsWithCacheReads: diagnosticRounds.filter(
      (round) => (round.tokenUsage?.cachedInputTokens ?? 0) > 0,
    ).length,
    promptInputTokens,
    cacheReadFraction:
      promptInputTokens === 0
        ? "0"
        : new Decimal(cacheReadTokens).div(promptInputTokens).toFixed(6),
    rawStateCounts,
    missReasonCounts,
    missedInputTokens,
  };
}

function compactCatalogArtifact(
  markets: readonly Market[],
  heldSlugs: ReadonlySet<string>,
): readonly Record<string, unknown>[] {
  return markets.map((market, index) => ({
    exchangeRank: index + 1,
    id: market.id.value,
    slug: market.slug,
    title: market.title,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    ...(market.tags === undefined
      ? {}
      : { tags: market.tags.map((tag) => tag.slug) }),
    category: market.category ?? "Uncategorized",
    ...(market.subcategory === undefined
      ? {}
      : { subcategory: market.subcategory }),
    ...(market.closesAt === undefined
      ? {}
      : { closesAt: market.closesAt.toISOString() }),
    ...(market.liquidity === undefined
      ? {}
      : { liquidityUsd: market.liquidity.toFixed() }),
    ...(market.volume === undefined
      ? {}
      : { volumeUsd: market.volume.toFixed() }),
    ...(market.volume24h === undefined
      ? {}
      : { volume24hUsd: market.volume24h.toFixed() }),
    ...(market.volume7d === undefined
      ? {}
      : { volume7dUsd: market.volume7d.toFixed() }),
    ...(market.volume30d === undefined
      ? {}
      : { volume30dUsd: market.volume30d.toFixed() }),
    ...(market.lastPrice === undefined
      ? {}
      : { lastPrice: market.lastPrice.toFixed() }),
    ...(market.openInterest === undefined
      ? {}
      : { openInterest: market.openInterest.toFixed() }),
    ...(market.priceMovement === undefined ||
    market.priceMovementWindow === undefined ||
    market.priceMovementBasis === undefined
      ? {}
      : {
          priceMovement: market.priceMovement.toFixed(),
          priceMovementWindow: market.priceMovementWindow,
          priceMovementBasis: market.priceMovementBasis,
        }),
    ...(market.volatility === undefined ||
    market.volatilityWindow === undefined ||
    market.volatilityBasis === undefined
      ? {}
      : {
          volatility: market.volatility.toFixed(),
          volatilityWindow: market.volatilityWindow,
          volatilityBasis: market.volatilityBasis,
        }),
    held: heldSlugs.has(market.slug),
  }));
}

function emptyExecutionRun(): ExecutionRun {
  return { attempts: [], stoppedForAmbiguity: false };
}

function executionJournalHooks(journal: RunJournal): ExecutionJournalHooks {
  const attemptIds = new Map<number, string>();
  const requiredAttemptId = (attemptSequence: number): string => {
    const attemptId = attemptIds.get(attemptSequence);
    if (attemptId === undefined) {
      throw new Error(
        `Execution journal attempt ${attemptSequence} has no durable intent`,
      );
    }
    return attemptId;
  };
  return {
    recordIntent: async (intent) => {
      const attemptId = journal.allocateOrderAttemptId(intent.attemptSequence);
      attemptIds.set(intent.attemptSequence, attemptId);
      await journal.recordOrderIntent(attemptId, intent);
    },
    recordSubmissionOutcome: (outcome) =>
      journal
        .recordOrderSubmission(
          requiredAttemptId(outcome.attemptSequence),
          outcome,
        )
        .then(() => undefined),
    recordReconciliationOutcome: (outcome) =>
      journal
        .recordOrderReconciliation(
          requiredAttemptId(outcome.attemptSequence),
          outcome,
        )
        .then(() => undefined),
    recordAttempt: (outcome) => {
      const attemptId = requiredAttemptId(outcome.attemptSequence);
      return journal
        .recordArtifact(`order.${attemptId}.attempt`, outcome, {
          filename: `orders/${attemptId}-attempt.json`,
        })
        .then(() => undefined);
    },
  };
}

function cycleFailureArtifact(error: unknown, failedAt: Date): unknown {
  return {
    failedAt,
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      message: safeErrorMessage(error),
      ...(error instanceof ExecutionJournalError
        ? {
            journalPhase: error.phase,
            mutationMayHaveOccurred: error.mutationMayHaveOccurred,
          }
        : {}),
      ...(error instanceof UnresolvedLiveJournalError
        ? {
            journalIssues: error.issues.map((issue) => ({
              reason: issue.reason,
              runId: issue.runId,
              cycleId: issue.cycleId,
              ...(issue.attemptId === undefined
                ? {}
                : { attemptId: issue.attemptId }),
              message: issue.message,
            })),
          }
        : {}),
    },
  };
}

function safeTimestamp(now: () => Date): Date {
  try {
    return now();
  } catch {
    return new Date();
  }
}

function completedJournalStatus(
  status: CycleReport["status"],
): CompletedRunJournalStage {
  if (status === "FAILED") {
    throw new Error("A completed cycle cannot have FAILED status");
  }
  return status;
}

function toRiskProposals(
  proposals: AgentDecision["proposals"],
): readonly RiskProposal[] {
  return proposals.map((proposal) => ({
    ...proposal,
    probabilityLowerBound: proposal.estimatedProbability,
    probabilityUpperBound: proposal.estimatedProbability,
    evidence: proposal.evidence.map((item) => {
      const { publishedAt, ...required } = item;
      return {
        ...required,
        ...(publishedAt === undefined ? {} : { publishedAt }),
      };
    }),
  }));
}

function toDecisionProposal(
  proposal: RiskProposal,
): AgentDecision["proposals"][number] {
  return {
    marketSlug: proposal.marketSlug,
    side: proposal.side,
    action: proposal.action,
    estimatedProbability: proposal.estimatedProbability,
    ...(proposal.maximumEntryPrice === undefined
      ? {}
      : { maximumEntryPrice: proposal.maximumEntryPrice }),
    ...(proposal.minimumExitPrice === undefined
      ? {}
      : { minimumExitPrice: proposal.minimumExitPrice }),
    maximumRiskUsd: proposal.maximumRiskUsd,
    confidence: proposal.confidence,
    thesis: proposal.thesis,
    settlementVerification: proposal.settlementVerification,
    invalidationConditions: proposal.invalidationConditions,
    evidence: proposal.evidence.map((item) => ({ ...item })),
  };
}

interface MaterializedTargetDecision {
  readonly decision: AgentDecision;
  readonly riskProposals: readonly RiskProposal[];
  readonly reconciliation?: PortfolioTargetReconciliationResult;
}

const TRANSIENT_MARKET_STRUCTURE_REJECTIONS = new Set([
  "NO_DEPTH",
  "PRICE_LIMIT_EXCEEDED",
  "SPREAD_TOO_WIDE",
]);

function materializeTargetDecision(
  decision: AgentDecision,
  snapshot: AccountSnapshot,
  valuation: PortfolioValuation,
): MaterializedTargetDecision {
  if (decision.portfolioTargets.length > 0 && decision.proposals.length > 0) {
    throw new TypeError(
      "A decision cannot mix portfolioTargets with legacy proposals",
    );
  }
  const legacyRiskProposals = toRiskProposals(decision.proposals);
  if (decision.portfolioTargets.length === 0) {
    return { decision, riskProposals: legacyRiskProposals };
  }
  const reconciliation = reconcilePortfolioTargets({
    targets: decision.portfolioTargets,
    snapshot,
    riskEquity: valuation.riskEquity,
  });
  const riskProposals = [...reconciliation.proposals, ...legacyRiskProposals];
  return {
    decision: {
      ...decision,
      proposals: riskProposals.map(toDecisionProposal),
    },
    riskProposals,
    reconciliation,
  };
}

function targetRepairFeedback(
  plan: MaterializedTargetDecision,
  validation: Awaited<ReturnType<typeof validateProposals>>,
  minimumIndependentSources: number,
): TerminalDecisionRepairFeedback | undefined {
  const base = buildTerminalDecisionRepairFeedback(
    plan.decision,
    plan.riskProposals,
    validation,
    minimumIndependentSources,
  );
  const reconciliation = plan.reconciliation;
  if (reconciliation === undefined) return base;

  const sourceTargetIndex = (proposalIndex: number): number =>
    reconciliation.proposalTargetIndexes[proposalIndex] ?? proposalIndex;
  const blocked = reconciliation.dispositions.filter(
    (disposition) => disposition.kind === "BLOCKED",
  );
  if (base === undefined && blocked.length === 0) return undefined;

  const proposalIndexes = new Map(
    plan.riskProposals.map((proposal, index) => [proposal, index] as const),
  );
  const acceptedTargetIndexes = new Set<number>(
    reconciliation.dispositions
      .filter((disposition) => disposition.kind === "HOLD")
      .map((disposition) => disposition.targetIndex),
  );
  for (const { proposal } of validation.accepted) {
    const proposalIndex = proposalIndexes.get(proposal);
    if (proposalIndex !== undefined) {
      acceptedTargetIndexes.add(sourceTargetIndex(proposalIndex));
    }
  }

  return {
    acceptedProposalIndexes: [...acceptedTargetIndexes].toSorted(
      (left, right) => left - right,
    ),
    rejectedProposals: [
      ...(base?.rejectedProposals ?? []).map((rejection) => ({
        ...rejection,
        proposalIndex: sourceTargetIndex(rejection.proposalIndex),
      })),
      ...blocked.map((disposition) => ({
        proposalIndex: disposition.targetIndex,
        marketSlug: disposition.marketSlug,
        side: disposition.side,
        action: "TARGET",
        code: disposition.reason,
        reason: disposition.message,
        repairable: true,
      })),
    ],
    instructions: [
      "Indexes refer to portfolioTargets. Resubmit the complete intended target portfolio, including any accepted targets that remain intended.",
      ...(base?.instructions ?? [
        "Correct, replace, or omit a blocked target. Do not invent evidence or change a probability merely to force validation to pass.",
      ]),
    ],
  };
}

function mergeTerminalDecisionRepairFeedback(
  ...feedbacks: (TerminalDecisionRepairFeedback | undefined)[]
): TerminalDecisionRepairFeedback | undefined {
  const present = feedbacks.filter(
    (feedback): feedback is TerminalDecisionRepairFeedback =>
      feedback !== undefined,
  );
  if (present.length === 0) return undefined;

  const rejectedProposals: TerminalDecisionRepairFeedback["rejectedProposals"][number][] =
    [];
  const seenRejections = new Set<string>();
  for (const rejection of present.flatMap(
    (feedback) => feedback.rejectedProposals,
  )) {
    const key = JSON.stringify(rejection);
    if (seenRejections.has(key)) continue;
    seenRejections.add(key);
    rejectedProposals.push(rejection);
  }
  const rejectedIndexes = new Set(
    rejectedProposals.map((rejection) => rejection.proposalIndex),
  );

  return {
    acceptedProposalIndexes: [
      ...new Set(
        present.flatMap((feedback) => feedback.acceptedProposalIndexes),
      ),
    ]
      .filter((index) => !rejectedIndexes.has(index))
      .toSorted((left, right) => left - right),
    rejectedProposals,
    instructions: [
      ...new Set(present.flatMap((feedback) => feedback.instructions)),
    ],
  };
}

export async function runCycle(
  dependencies: CycleDependencies,
): Promise<CycleReport> {
  if (dependencies.mode === "live" && dependencies.writeReports === false) {
    throw new SafetyGuardError(
      "Live execution requires durable per-run journaling",
    );
  }
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const suppliedManifest = dependencies.journal?.currentManifest;
  const runId =
    dependencies.runId ??
    suppliedManifest?.runId ??
    process.env.GITHUB_RUN_ID ??
    randomUUID();
  const cycleId =
    dependencies.cycleId ?? suppliedManifest?.cycleId ?? randomUUID();
  const accountScope = assertSafeMemoryScope(dependencies.exchange.memoryScope);
  const warnings: string[] = [];
  let journal =
    dependencies.writeReports === false ? undefined : dependencies.journal;
  const transcriptRounds: DecisionTranscriptRound[] = [];
  let transcriptJournalQueue: Promise<void> = Promise.resolve();
  const recordTranscriptRound = (
    round: DecisionTranscriptRound,
  ): Promise<void> => {
    const expectedRound = transcriptRounds.length + 1;
    if (round.round !== expectedRound) {
      return Promise.reject(
        new Error(
          `Decision transcript round ${round.round} arrived out of order; expected ${expectedRound}`,
        ),
      );
    }
    transcriptRounds.push(round);
    const activeJournal = journal;
    if (activeJournal === undefined) return Promise.resolve();
    const kind = decisionTranscriptRoundArtifactKind(round.round);
    const pending = transcriptJournalQueue.then(async () => {
      await activeJournal.recordArtifact(kind, {
        provider: dependencies.decisionProvider.providerId,
        model: dependencies.decisionProvider.modelId,
        ...(dependencies.decisionProvider.catalogModelId === undefined
          ? {}
          : {
              catalogModel: dependencies.decisionProvider.catalogModelId,
            }),
        ...round,
      });
    });
    transcriptJournalQueue = pending;
    return pending;
  };
  if (
    journal !== undefined &&
    (journal.currentManifest.runId !== runId ||
      journal.currentManifest.cycleId !== cycleId ||
      journal.currentManifest.mode !== dependencies.mode ||
      journal.currentManifest.exchangeId !== dependencies.exchange.id ||
      journal.currentManifest.accountScope !== accountScope ||
      journal.rootDirectory !==
        resolve(process.cwd(), dependencies.config.reporting.directory))
  ) {
    throw new Error(
      "Supplied run journal identity does not match the cycle configuration",
    );
  }
  const overallController = new AbortController();
  let liveCycleLock: LiveCycleLock | undefined;
  let persistenceTransaction: PersistenceTransaction | undefined;
  const mutationLedger = new StagedMutationLedger();
  let mutationProvenance: MutationProvenanceReport | undefined;
  const overallTimeout = setTimeout(
    () => overallController.abort(new Error("Cycle deadline exceeded")),
    dependencies.config.cycle.timeoutSeconds * 1000,
  );

  try {
    if (dependencies.mode === "live") {
      liveCycleLock = await acquireLiveCycleLock({
        rootDirectory: dependencies.config.reporting.directory,
        exchangeId: dependencies.exchange.id,
        runId,
        cycleId,
        now,
      });
    }
    if (dependencies.writeReports !== false) {
      journal ??= await createRunJournal({
        rootDirectory: dependencies.config.reporting.directory,
        runId,
        cycleId,
        mode: dependencies.mode,
        exchangeId: dependencies.exchange.id,
        accountScope,
        now,
      });
    }
    if (dependencies.mode === "live") {
      await assertNoUnresolvedLiveJournals({
        rootDirectory: dependencies.config.reporting.directory,
        exchangeId: dependencies.exchange.id,
        exclude: { runId, cycleId },
      });
    }
    const persistentDirectory = resolve(
      dependencies.config.reporting.directory,
      "memory",
      dependencies.exchange.id,
    );
    const memoryFilePath = resolve(
      persistentDirectory,
      `${accountScope}.jsonl`,
    );
    const stateFilePath = resolve(
      persistentDirectory,
      `${accountScope}.state.json`,
    );
    const usesFileMemory =
      dependencies.memory === undefined &&
      dependencies.config.agent.memory.enabled &&
      dependencies.writeReports !== false;
    const usesFileState =
      dependencies.agentState === undefined &&
      dependencies.config.agent.state.enabled &&
      dependencies.writeReports !== false;
    if (dependencies.writeReports !== false) {
      persistenceTransaction = await PersistenceTransaction.begin({
        memoryFilePath,
        stateFilePath,
        stagingDirectory: resolve(persistentDirectory, ".staging"),
        migrationMarkerPath: resolve(
          persistentDirectory,
          `${accountScope}.persistence-v2.json`,
        ),
        manifestPath: resolve(
          persistentDirectory,
          `${accountScope}.persistence-transaction.json`,
        ),
        additionalLegacyFilePaths: [
          resolve(
            dependencies.config.reporting.directory,
            "advisory",
            dependencies.exchange.id,
            `${accountScope}.json`,
          ),
        ],
        cycleId,
        now,
      });
      if (persistenceTransaction.legacyQuarantined) {
        warnings.push(
          "Legacy notes, structured state, and previous-cycle advisory were quarantined for evidence-provenance migration",
        );
      }
    }
    const loadedPreviousCycle =
      dependencies.writeReports === false
        ? undefined
        : await loadPreviousCycleAdvisory({
            rootDirectory: dependencies.config.reporting.directory,
            exchangeId: dependencies.exchange.id,
            accountScope,
          });
    const previousCycle = persistenceTransaction?.legacyQuarantined
      ? undefined
      : loadedPreviousCycle;
    if (previousCycle !== undefined) {
      await journal?.recordArtifact("previous-cycle-advisory", previousCycle);
    }
    let memory: AgentMemory =
      dependencies.memory ??
      (dependencies.config.agent.memory.enabled &&
      dependencies.writeReports !== false
        ? new FileAgentMemory({
            filePath:
              persistenceTransaction?.stagedMemoryFilePath ?? memoryFilePath,
            maximumNotes: dependencies.config.agent.memory.maximumNotes,
            maximumContextNotes:
              dependencies.config.agent.memory.maximumContextNotes,
            maximumNoteCharacters:
              dependencies.config.agent.memory.maximumNoteCharacters,
            now,
          })
        : new StatelessAgentMemory());
    let memoryContext: AgentMemoryContext;
    try {
      memoryContext = await memory.load();
    } catch (error) {
      warnings.push(
        `Persistent agent notes could not be loaded and were disabled for this cycle: ${safeErrorMessage(error)}`,
      );
      memory = new StatelessAgentMemory();
      memoryContext = await memory.load();
    }
    let agentState: AgentState =
      dependencies.agentState ??
      (dependencies.config.agent.state.enabled &&
      dependencies.writeReports !== false
        ? new FileAgentState({
            filePath:
              persistenceTransaction?.stagedStateFilePath ?? stateFilePath,
            maximumBeliefs: dependencies.config.agent.state.maximumBeliefs,
            maximumContextBeliefs:
              dependencies.config.agent.state.maximumContextBeliefs,
            maximumBeliefCharacters:
              dependencies.config.agent.state.maximumBeliefCharacters,
            maximumPlanCharacters:
              dependencies.config.agent.state.maximumPlanCharacters,
            now,
          })
        : new StatelessAgentState());
    let agentStateContext: AgentStateContext;
    try {
      agentStateContext = await agentState.load();
    } catch (error) {
      warnings.push(
        `Structured agent state could not be loaded and was disabled for this cycle: ${safeErrorMessage(error)}`,
      );
      agentState = new StatelessAgentState();
      agentStateContext = await agentState.load();
    }
    const canDiscardAllPersistentMutations =
      (!memory.persistent || usesFileMemory) &&
      (!agentState.persistent || usesFileState);
    let stagedPersistenceDiscarded = false;
    stageLogger(dependencies.logger, "account-reconstruction").info(
      "Reconstructing authoritative account state",
    );
    const initialSnapshot = await reconstructAccount(dependencies.exchange);
    const initialValuation = await valuePortfolio(
      dependencies.exchange,
      initialSnapshot,
      dependencies.config.exchange.maximumConcurrentRequests,
    );
    await journal?.recordArtifact("account-before", {
      snapshot: initialSnapshot,
      valuation: initialValuation,
    });

    const discoveryLogger = stageLogger(
      dependencies.logger,
      "market-discovery",
    );
    const discovery = await withStageTimeout(
      "market-discovery",
      dependencies.config.cycle.stageBudgetsSeconds.marketDiscovery * 1000,
      async (signal) => {
        const catalog = await discoverMarketCatalog(
          dependencies.exchange,
          initialSnapshot,
          {
            signal,
            // Polymarket US returns up to 500 rows and paginates correctly at
            // that boundary. Its numeric offsets also let four independent
            // pages share the configured request gate without skipping rows.
            ...(dependencies.exchange.id === "polymarket-us"
              ? { pageSize: 500, maximumConcurrentPages: 4 }
              : {}),
          },
        );
        const marketDiscoveryResolver = new MarketDiscoveryResolver(
          dependencies.exchange,
          catalog,
          {
            maximumConcurrentMetricRequests:
              dependencies.config.exchange.maximumConcurrentRequests,
            now,
          },
        );
        const detailResolver = new MarketDetailResolver(
          dependencies.exchange,
          catalog,
          (market) => marketDiscoveryResolver.applyResolvedMetrics(market),
        );
        const preloadedHeld = await detailResolver.preloadHeld(signal);
        const opportunityBoard = await buildEnrichedOpportunityBoard(
          catalog,
          dependencies.config.marketSelection,
          async (marketSlug, enrichmentSignal) => {
            const details = await detailResolver.resolve(
              marketSlug,
              enrichmentSignal,
            );
            let nearTouchTwoSidedDepth: number | undefined;
            if (
              details.bbo?.yes.bid !== undefined &&
              details.bbo.yes.ask !== undefined
            ) {
              try {
                enrichmentSignal?.throwIfAborted();
                const book = await dependencies.exchange.getOrderBook(
                  details.market.id,
                );
                enrichmentSignal?.throwIfAborted();
                const bidFloor = details.bbo.yes.bid.minus("0.05");
                const askCeiling = details.bbo.yes.ask.plus("0.05");
                const bidDepth = book.yesBids
                  .filter((level) => level.price.gte(bidFloor))
                  .reduce(
                    (total, level) => total.plus(level.quantity),
                    details.bbo.yes.bid.mul(0),
                  );
                const askDepth = book.yesAsks
                  .filter((level) => level.price.lte(askCeiling))
                  .reduce(
                    (total, level) => total.plus(level.quantity),
                    details.bbo.yes.ask.mul(0),
                  );
                nearTouchTwoSidedDepth = Decimal.min(
                  bidDepth,
                  askDepth,
                ).toNumber();
              } catch (error) {
                if (enrichmentSignal?.aborted === true) throw error;
              }
            }
            return {
              market: details.market,
              ...(details.bbo === undefined ? {} : { bbo: details.bbo }),
              ...(nearTouchTwoSidedDepth === undefined
                ? {}
                : { nearTouchTwoSidedDepth }),
            };
          },
          startedAt,
          signal,
          dependencies.config.marketSelection.opportunityBoardVariant,
        );
        const marketSelectionSnapshot = freezeMarketSelectionSnapshot(
          catalog,
          dependencies.config.marketSelection,
          startedAt,
        );
        return {
          catalog,
          detailResolver,
          marketDiscoveryResolver,
          preloadedHeld,
          opportunityBoard,
          marketSelectionSnapshot,
          marketSelectionExperiment: replayMarketSelectionExperiment(
            marketSelectionSnapshot,
          ),
        };
      },
      overallController.signal,
    );
    warnings.push(...discovery.catalog.warnings);
    const opportunityBoard = discovery.opportunityBoard;
    await journal?.recordArtifact(
      "market-selection-snapshot",
      discovery.marketSelectionSnapshot,
    );
    // Cycle experiment: require only the two highest-ranked passed-event
    // candidates to receive a mechanical inspection. A missing quote ends the
    // check; an executable candidate still needs independent current evidence.
    const requiredPassedPriorityMarketSlugs = new Set(
      selectRequiredPassedPriorityMarketSlugs(opportunityBoard),
    );
    const selectedScoutFamilyKeys = new Set([
      ...opportunityBoard.flatMap((market) =>
        market.familyScout === undefined ? [] : [market.familyScout.familyKey],
      ),
      ...[...requiredPassedPriorityMarketSlugs].flatMap((slug) => {
        const market = discovery.catalog.bySlug.get(slug);
        if (market === undefined) return [];
        const familyKey = familyScoutResearchKey(market);
        return familyKey === undefined ? [] : [familyKey];
      }),
    ]);
    const researchFamilyAliases = new Map<string, string>();
    for (const market of discovery.catalog.markets) {
      const familyKey = familyScoutResearchKey(market);
      if (familyKey !== undefined && selectedScoutFamilyKeys.has(familyKey)) {
        researchFamilyAliases.set(market.slug, familyKey);
      }
    }
    discoveryLogger.info(
      {
        catalogued: discovery.catalog.markets.length,
        categories: Object.keys(discovery.catalog.categoryCounts).length,
        preloadedHeld: discovery.preloadedHeld.length,
        preloadedOpportunities: opportunityBoard.length,
      },
      "Full market catalog loaded",
    );

    const initialValuationContext = valuationContext(
      initialSnapshot,
      initialValuation,
    );
    const familyResolvedMarkets = new Map<string, Market>();
    const resolvedMarketDetailsBySlug = new Map<
      string,
      DetailedMarketContext
    >();
    const familyResolutionWarnings: string[] = [];
    const resolveMarketFamilyDetails = async (
      request: MarketFamilyDetailsToolInput,
      signal: AbortSignal,
    ): Promise<MarketFamilyDetailsResult> => {
      const family = await new MarketFamilyResolver(
        dependencies.exchange,
        discovery.catalog,
        {
          maximumMembers: request.limit ?? 30,
          maximumConcurrentRequests: Math.min(
            30,
            dependencies.config.exchange.maximumConcurrentRequests,
          ),
        },
      ).resolve(request.marketSlug, signal);
      for (const warning of family.warnings) {
        if (!familyResolutionWarnings.includes(warning)) {
          familyResolutionWarnings.push(warning);
        }
      }
      const bookSnapshots: readonly {
        readonly book?: OrderBook;
        readonly warning?: string;
      }[] = await Promise.all(
        family.members.map(async (member) => {
          const context = [
            member.market.category,
            member.market.title,
            member.market.description,
          ]
            .join(" ")
            .toLocaleLowerCase("en-US");
          if (!context.includes("sport") && !context.includes("tennis")) {
            return {};
          }
          try {
            return {
              book: await dependencies.exchange.getOrderBook(member.market.id),
            };
          } catch (error) {
            if (signal.aborted) throw error;
            return {
              warning: `Session price path is unavailable for ${member.market.slug}`,
            };
          }
        }),
      );
      const members = family.members.map((member, index) => {
        const bookSnapshot = bookSnapshots[index] ?? {};
        const memberWarnings = [
          ...member.warnings,
          ...(bookSnapshot.warning === undefined ? [] : [bookSnapshot.warning]),
        ];
        for (const warning of memberWarnings) {
          if (!familyResolutionWarnings.includes(warning)) {
            familyResolutionWarnings.push(warning);
          }
        }
        const market = discovery.marketDiscoveryResolver.applyResolvedMetrics(
          member.market,
        );
        familyResolvedMarkets.set(market.slug, market);
        return buildMarketDetailContext({
          ...member,
          ...(bookSnapshot.book === undefined
            ? {}
            : { book: bookSnapshot.book }),
          warnings: memberWarnings,
          market,
          account: initialSnapshot,
          valuation: initialValuationContext,
        });
      });
      for (const details of members) {
        resolvedMarketDetailsBySlug.set(details.slug, details);
      }
      return { ...family, members };
    };

    // Live sports receive no privileged preinspection lane. If the model
    // deliberately inspects one, the same official resolver is refreshed at
    // terminal review and again immediately before execution.
    const preinspectedMarketContexts: DetailedMarketContext[] = [];
    const visibleHeldSlugs = new Set(
      initialSnapshot.positions.map((position) => position.marketSlug),
    );
    const modelSnapshot: AccountSnapshot = {
      ...initialSnapshot,
      positions: initialSnapshot.positions.filter((position) =>
        visibleHeldSlugs.has(position.marketSlug),
      ),
    };
    const modelValuationContext = valuationContext(
      modelSnapshot,
      initialValuation,
    );
    const contextInput: BuildAgentContextInput = {
      observedAt: startedAt,
      exchangeId: dependencies.exchange.id,
      exchangeName:
        dependencies.exchange.id === "polymarket-us"
          ? "Polymarket US"
          : dependencies.exchange.id === "kalshi"
            ? "Kalshi"
            : dependencies.exchange.id,
      account: modelSnapshot,
      marketCatalog: {
        count: discovery.catalog.markets.length,
        categoryCounts: discovery.catalog.categoryCounts,
      },
      opportunityBoard,
      // The terminal plan must explicitly address the complete held portfolio.
      preloadedMarkets: discovery.preloadedHeld.filter(({ market }) =>
        visibleHeldSlugs.has(market.slug),
      ),
      prebuiltMarketContexts: preinspectedMarketContexts,
      valuation: modelValuationContext,
      riskConstraints: {
        maximumPositionCostBasisFraction:
          dependencies.config.risk.maximumPositionCostBasisFraction,
        maximumCycleSpendFraction:
          dependencies.config.risk.maximumCycleSpendFraction,
        maximumExecutionSpread: dependencies.config.risk.maximumExecutionSpread,
        kellyFraction: dependencies.config.risk.kellyFraction,
        uncertaintyBoundWeight: dependencies.config.risk.uncertaintyBoundWeight,
        duplicateWindowMinutes: dependencies.config.risk.duplicateWindowMinutes,
        minimumIndependentSources:
          dependencies.config.risk.minimumIndependentSources,
        allowNakedShorts: dependencies.config.risk.allowNakedShorts,
        emergencyExitEnabled: dependencies.config.risk.emergencyExitEnabled,
      },
      memory: memoryContext,
      agentState: agentStateContext,
      ...(previousCycle === undefined ? {} : { previousCycle }),
    };
    const agentContext = buildAgentContext(contextInput);
    const configuredDecisionLimits = decisionLimitsFromConfig(
      dependencies.config.agent,
    );
    const modelHasNonSportsWork =
      modelSnapshot.positions.length > 0 ||
      opportunityBoard.some(
        (item) => !/(?:sports|esports)/iu.test(item.category),
      );
    const liveDecisionLimits = modelHasNonSportsWork
      ? configuredDecisionLimits
      : { ...configuredDecisionLimits, maximumWebSearches: 0 };
    const marketAnalysisResolver = new MarketAnalysisResolver(
      dependencies.exchange,
      discovery.catalog.bySlug,
      now,
    );
    const tradePreviewResolver = new AdvisoryTradePreviewResolver(
      dependencies.exchange,
      discovery.catalog.bySlug,
    );
    const researchTools = new DecisionResearchTools({
      marketDetails: [
        ...discovery.preloadedHeld.map((details) =>
          buildMarketDetailContext({
            ...details,
            account: initialSnapshot,
            valuation: initialValuationContext,
          }),
        ),
        ...preinspectedMarketContexts,
      ],
      listMarketFacets: (request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve(searchMarketFacets(discovery.catalog, request));
      },
      discoverMarkets: (request, signal) =>
        discovery.marketDiscoveryResolver.search(request, now(), signal),
      marketDetailsHandler: async (marketSlug, signal) => {
        const details = await discovery.detailResolver.resolve(
          marketSlug,
          signal,
        );
        return buildMarketDetailContext({
          ...details,
          account: initialSnapshot,
          valuation: initialValuationContext,
        });
      },
      marketFamilyDetailsHandler: resolveMarketFamilyDetails,
      marketAnalysisHandler: (request, signal) =>
        marketAnalysisResolver.analyze(request, signal),
      tradePreviewHandler: (request, signal) =>
        tradePreviewResolver.preview(request, signal),
      ...(memory.persistent
        ? {
            agentNotesHandler: async (
              operation: Parameters<AgentMemory["manage"]>[0],
            ) => {
              if (operation.action === "ADD" || operation.action === "UPDATE") {
                const {
                  evidenceUrls = [],
                  basisMarketSlugs = [],
                  ...persisted
                } = operation;
                const result = await memory.manage(persisted);
                const mutatedNoteId =
                  result.mutatedNoteId ??
                  (operation.action === "UPDATE"
                    ? operation.noteId
                    : undefined);
                if (mutatedNoteId === undefined) {
                  throw new Error(
                    "Persistent note mutation did not identify its effective note",
                  );
                }
                mutationLedger.record({
                  kind: "NOTE",
                  action: operation.action,
                  identity: `NOTE:${mutatedNoteId}`,
                  evidenceUrls,
                  basisMarketSlugs,
                });
                if (usesFileMemory) persistenceTransaction?.markMutated();
                return result;
              }
              if (operation.action === "DELETE") {
                const result = await memory.manage(operation);
                mutationLedger.record({
                  kind: "DESTRUCTIVE",
                  action: operation.action,
                  identity: `NOTE:${operation.noteId}`,
                  evidenceUrls: [],
                  basisMarketSlugs: [],
                });
                if (usesFileMemory) persistenceTransaction?.markMutated();
                return result;
              }
              return memory.manage(operation);
            },
          }
        : {}),
      ...(agentState.persistent
        ? {
            agentStateHandler: async (
              operation: Parameters<AgentState["manage"]>[0],
              signal: AbortSignal,
            ) => {
              if (
                operation.action === "ADD_BELIEF" ||
                operation.action === "UPDATE_BELIEF"
              ) {
                const {
                  evidenceUrls = [],
                  basisMarketSlugs = [],
                  ...persisted
                } = operation;
                const result = await agentState.manage(persisted, signal);
                const mutatedBeliefId =
                  result.mutatedBeliefId ??
                  (operation.action === "UPDATE_BELIEF"
                    ? operation.beliefId
                    : undefined);
                if (mutatedBeliefId === undefined) {
                  throw new Error(
                    "Persistent belief mutation did not identify its effective belief",
                  );
                }
                mutationLedger.record({
                  kind: "BELIEF",
                  action: operation.action,
                  identity: `BELIEF:${mutatedBeliefId}`,
                  evidenceUrls,
                  basisMarketSlugs,
                });
                if (usesFileState) persistenceTransaction?.markMutated();
                return result;
              }
              if (
                operation.action === "SET_NEXT_CYCLE_PLAN" ||
                operation.action === "SET_LONG_TERM_PLAN"
              ) {
                const {
                  evidenceUrls = [],
                  basisMarketSlugs = [],
                  ...persisted
                } = operation;
                const result = await agentState.manage(persisted, signal);
                mutationLedger.record({
                  kind: "PLAN",
                  action: operation.action,
                  identity:
                    operation.action === "SET_NEXT_CYCLE_PLAN"
                      ? "PLAN:NEXT_CYCLE"
                      : "PLAN:LONG_TERM",
                  evidenceUrls,
                  basisMarketSlugs,
                });
                if (usesFileState) persistenceTransaction?.markMutated();
                return result;
              }
              if (
                operation.action === "DELETE_BELIEF" ||
                operation.action === "CLEAR_NEXT_CYCLE_PLAN"
              ) {
                const result = await agentState.manage(operation, signal);
                mutationLedger.record({
                  kind: "DESTRUCTIVE",
                  action: operation.action,
                  identity:
                    operation.action === "DELETE_BELIEF"
                      ? `BELIEF:${operation.beliefId}`
                      : "PLAN:NEXT_CYCLE",
                  evidenceUrls: [],
                  basisMarketSlugs: [],
                });
                if (usesFileState) persistenceTransaction?.markMutated();
                return result;
              }
              return agentState.manage(operation, signal);
            },
          }
        : {}),
      candidateFamilies: [
        ...opportunityBoard.map((market) => ({
          marketSlug: market.slug,
          ...(market.familyScout === undefined
            ? {}
            : { researchFamilyKey: market.familyScout.familyKey }),
          ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
          ...(market.eventSlug === undefined
            ? {}
            : { eventSlug: market.eventSlug }),
          ...(market.seriesId === undefined
            ? {}
            : { seriesId: market.seriesId }),
          ...(market.seriesSlug === undefined
            ? {}
            : { seriesSlug: market.seriesSlug }),
        })),
        ...discovery.preloadedHeld.map(({ market }) => ({
          marketSlug: market.slug,
          ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
          ...(market.eventSlug === undefined
            ? {}
            : { eventSlug: market.eventSlug }),
          ...(market.seriesId === undefined
            ? {}
            : { seriesId: market.seriesId }),
          ...(market.seriesSlug === undefined
            ? {}
            : { seriesSlug: market.seriesSlug }),
        })),
      ],
      researchFamilyAliases,
      requiredPriorityEvidenceMarketSlugs: [
        ...requiredPassedPriorityMarketSlugs,
      ],
      passResearchRequirements: {
        ...dependencies.config.agent.passResearch,
        maximumQualifiedSpread: dependencies.config.risk.maximumExecutionSpread,
      },
      prompts: dependencies.prompts.research,
    });
    const validateDecisionProposals = async (
      proposals: readonly RiskProposal[],
      signal: AbortSignal,
    ) => {
      const freshLive = await refreshOfficialLiveProbabilities(
        proposals,
        resolvedMarketDetailsBySlug,
        now(),
        signal,
      );
      return validateProposals({
        proposals,
        snapshot: initialSnapshot,
        valuation: initialValuation,
        exchange: dependencies.exchange,
        policy: dependencies.config.risk,
        knownMarkets: knownMarketMap([
          ...discovery.detailResolver.resolvedMarkets,
          ...familyResolvedMarkets.values(),
        ]),
        permittedMarketSlugs: new Set([
          ...discovery.catalog.heldSlugs,
          ...researchTools.inspectedMarketSlugs,
        ]),
        freshProbabilityByMarketSlug:
          freshLive.selectedSideProbabilityByMarketSlug,
        requireFreshProbabilityMarketSlugs: freshLive.requiredMarketSlugs,
        now,
        signal,
      });
    };
    let evidenceValidation: EvidenceValidationReport | undefined;
    let decisionCoverage: DecisionCoverageReport | undefined;
    let passEdgeAudit: PassEdgeAuditReport | undefined;
    const passEdgeAuditHistory: PassEdgeAuditReport[] = [];
    const passEdgeQuoteCache = new Map<
      string,
      ReturnType<PredictionExchange["getBbo"]>
    >();
    const validateDecisionGuards = async (
      candidateDecision: AgentDecision,
      signal: AbortSignal,
    ): Promise<{
      readonly evidence: EvidenceValidationReport;
      readonly coverage: DecisionCoverageReport;
      readonly mutationProvenance: MutationProvenanceReport;
      readonly passEdgeAudit: PassEdgeAuditReport;
    }> => {
      const marketsBySlug = new Map(
        [
          ...discovery.catalog.markets,
          ...discovery.detailResolver.resolvedMarkets,
          ...familyResolvedMarkets.values(),
        ].map((market) => [market.slug, market] as const),
      );
      const exposureIncreasingMarketSlugs = new Set(
        materializeTargetDecision(
          candidateDecision,
          initialSnapshot,
          initialValuation,
        )
          .riskProposals.filter((proposal) => proposal.action === "BUY")
          .map((proposal) => proposal.marketSlug),
      );
      const [evidence, baseCoverage, freshTargetLive, passAudit] =
        await Promise.all([
          validateDecisionEvidence({
            decision: candidateDecision,
            observedSources: researchTools.observedEvidenceSources,
            marketsBySlug,
            minimumIndependentSources:
              dependencies.config.risk.minimumIndependentSources,
            // Independently verified current sources authorize increases in
            // exposure. Covered reductions remain fully audited, but a failed
            // page fetch cannot trap an existing position; deterministic exit
            // edge, spread, depth, quantity, and freshness guards still apply.
            blockingTargetMarketSlugs: exposureIncreasingMarketSlugs,
            now: now(),
            signal,
          }),
          Promise.resolve(
            validateDecisionCoverage({
              decision: candidateDecision,
              snapshot: initialSnapshot,
              qualifiedMarketSlugs: researchTools.qualifiedMarketSlugs,
              seriouslyEvaluatedMarketSlugs:
                researchTools.seriouslyEvaluatedMarketSlugs,
              inspectedMarketSlugs: new Set([
                ...visibleHeldSlugs,
                ...researchTools.inspectedMarketSlugs,
              ]),
              requiredPrioritySignalMarketSlugs:
                requiredPassedPriorityMarketSlugs,
            }),
          ),
          refreshOfficialLiveProbabilities(
            candidateDecision.portfolioTargets,
            resolvedMarketDetailsBySlug,
            now(),
            signal,
          ),
          auditNoPositiveEdgePasses({
            decision: candidateDecision,
            marketsBySlug,
            previewedMarketSlugs: researchTools.previewedMarketSlugs,
            exchange: dependencies.exchange,
            maximumExecutionSpread:
              dependencies.config.risk.maximumExecutionSpread,
            uncertaintyBoundWeight:
              dependencies.config.risk.uncertaintyBoundWeight,
            quoteCache: passEdgeQuoteCache,
            signal,
          }),
        ]);
      const liveCoverageIssues: DecisionCoverageReport["issues"][number][] = [];
      const heldMarketSlugs = new Set(
        initialSnapshot.positions.map((position) => position.marketSlug),
      );
      for (const target of candidateDecision.portfolioTargets) {
        if (!freshTargetLive.requiredMarketSlugs.has(target.marketSlug)) {
          continue;
        }
        const freshProbability =
          freshTargetLive.selectedSideProbabilityByMarketSlug.get(
            target.marketSlug,
          );
        if (freshProbability === undefined) {
          liveCoverageIssues.push({
            code: "FRESH_LIVE_STATE_UNAVAILABLE",
            marketSlug: target.marketSlug,
            message: `${target.marketSlug} requires a fresh official live state, but the resolver did not return a usable current probability`,
          });
          continue;
        }
        if (
          target.estimatedProbability.minus(freshProbability).abs().gt("0.05")
        ) {
          liveCoverageIssues.push({
            code: "STALE_LIVE_PROBABILITY",
            marketSlug: target.marketSlug,
            message: `${target.marketSlug} fresh official state implies P(${target.side})=${freshProbability.toFixed()}, not ${target.estimatedProbability.toFixed()}; reassess its total target from the fresh probability`,
          });
        }
        if (
          heldMarketSlugs.has(target.marketSlug) &&
          freshProbability.isZero() &&
          target.targetCostBasisFraction.gt(0)
        ) {
          liveCoverageIssues.push({
            code: "RESOLVED_LOSING_POSITION_NOT_EXITED",
            marketSlug: target.marketSlug,
            message: `${target.marketSlug} official final state makes the held ${target.side} side a loss; set targetCostBasisFraction to 0`,
          });
        }
      }
      const coverage: DecisionCoverageReport = {
        ...baseCoverage,
        valid:
          baseCoverage.valid &&
          liveCoverageIssues.length === 0 &&
          passAudit.issues.length === 0,
        issues: [
          ...baseCoverage.issues,
          ...liveCoverageIssues,
          ...passAudit.issues,
        ],
      };
      passEdgeAuditHistory.push(passAudit);
      const provenance = mutationLedger.validate({
        // Advisory memory has a deliberately weaker trust boundary than trade
        // authorization. A source must have been observed this cycle (so the
        // model cannot persist invented URLs), but it need not satisfy the
        // stricter excerpt, freshness, and independence rules required to put
        // capital at risk. Persisted state remains untrusted and never
        // authorizes an order without fresh terminal evidence.
        observedCurrentUrls: new Set(
          researchTools.observedEvidenceSources.map((source) => source.url),
        ),
        currentCycleMarketBasisSlugs: new Set([
          ...discovery.preloadedHeld.map(({ market }) => market.slug),
          ...researchTools.inspectedMarketSlugs,
        ]),
      });
      return {
        evidence,
        coverage,
        mutationProvenance: provenance,
        passEdgeAudit: passAudit,
      };
    };
    const rawDecision = await withStageTimeout(
      "agent-research",
      dependencies.config.cycle.stageBudgetsSeconds.agentResearch * 1000,
      (signal) =>
        dependencies.decisionProvider.decide({
          prompt: buildDecisionPrompt(
            agentContext,
            dependencies.prompts.decision,
          ),
          researchTools,
          limits: liveDecisionLimits,
          signal,
          reviewTerminalDecision: async (candidateDecision, reviewSignal) => {
            const guards = await validateDecisionGuards(
              candidateDecision,
              reviewSignal,
            );
            evidenceValidation = guards.evidence;
            decisionCoverage = guards.coverage;
            mutationProvenance = guards.mutationProvenance;
            passEdgeAudit = guards.passEdgeAudit;
            const candidatePlan = materializeTargetDecision(
              candidateDecision,
              initialSnapshot,
              initialValuation,
            );
            const validation = await validateDecisionProposals(
              candidatePlan.riskProposals,
              reviewSignal,
            );
            const validationFeedback = targetRepairFeedback(
              candidatePlan,
              validation,
              dependencies.config.risk.minimumIndependentSources,
            );
            const passReadiness = researchTools.strictPassResearchReadiness;
            const passFeedback =
              candidatePlan.riskProposals.length === 0 && !passReadiness.allowed
                ? ({
                    acceptedProposalIndexes: [],
                    rejectedProposals: candidateDecision.portfolioTargets.map(
                      (target, targetIndex) => ({
                        proposalIndex: targetIndex,
                        marketSlug: target.marketSlug,
                        side: target.side,
                        action: "TARGET",
                        code: "PASS_RESEARCH_REQUIRED",
                        reason: `The target produced no order delta and no-order research qualification remains incomplete: ${passReadiness.unmet.join("; ")}`,
                        repairable: true,
                      }),
                    ),
                    instructions: [
                      `No-order research qualification is incomplete: ${passReadiness.unmet.join("; ")}.`,
                      "Complete every listed successful research action, then resubmit the complete target plan. A forced final round does not waive this requirement.",
                    ],
                  } satisfies TerminalDecisionRepairFeedback)
                : undefined;
            const guardInstructions = [
              ...guards.coverage.issues.map(
                (issue) => `Coverage ${issue.code}: ${issue.message}`,
              ),
              ...guards.evidence.issues.map(
                (issue) =>
                  `Evidence ${issue.code} for ${issue.marketSlug}${issue.url === undefined ? "" : ` at ${issue.url}`}: ${issue.message}`,
              ),
            ];
            const guardFeedback =
              guardInstructions.length > 0
                ? ({
                    acceptedProposalIndexes: [],
                    rejectedProposals: [],
                    instructions: [
                      "Resubmit the complete intended trade plan. Every held position requires a target; use its supplied current cost-basis fraction for an unchanged hold or zero to exit. Every seriously evaluated non-held candidate requires either a target or a compact pass disposition.",
                      "Use only sources observed in this cycle. Current evidence needs an exact excerpt, correct event year, and a provider-verifiable publication/as-of date; do not copy a search result from another year.",
                      "Rejected-candidate evidence cannot authorize exposure. Do not spend repair rounds rescuing a source for a candidate you will not trade; omit that candidate.",
                      "For a held market, retain the target after decision-relevant inspection even when holding unchanged. Do not synthesize or paraphrase an exact excerpt.",
                      ...guardInstructions,
                    ],
                  } satisfies TerminalDecisionRepairFeedback)
                : undefined;
            const feedback = mergeTerminalDecisionRepairFeedback(
              guardFeedback,
              validationFeedback,
              passFeedback,
            );
            const quoteMovedOnly =
              guardFeedback === undefined &&
              passFeedback === undefined &&
              guards.mutationProvenance.valid &&
              validation.rejected.length > 0 &&
              validation.rejected.every((rejection) =>
                TRANSIENT_MARKET_STRUCTURE_REJECTIONS.has(rejection.code),
              ) &&
              !candidatePlan.reconciliation?.dispositions.some(
                (disposition) => disposition.kind === "BLOCKED",
              );
            // A replacement model plan cannot make a vanished quote executable.
            // End this immutable snapshot immediately and let the next cycle
            // obtain fresh live evidence. Authoritative final validation still
            // runs, so a quote that returns before execution remains eligible.
            if (quoteMovedOnly) return { repair: false };
            return feedback === undefined
              ? { repair: false }
              : { repair: true, feedback };
          },
          recordTranscriptRound,
        }),
      overallController.signal,
    );
    const finalGuards = await validateDecisionGuards(
      rawDecision,
      overallController.signal,
    );
    evidenceValidation = finalGuards.evidence;
    decisionCoverage = finalGuards.coverage;
    mutationProvenance = finalGuards.mutationProvenance;
    passEdgeAudit = finalGuards.passEdgeAudit;
    if (finalGuards.evidence.advisoryIssues.length > 0) {
      warnings.push(
        `Recorded ${finalGuards.evidence.advisoryIssues.length} non-blocking evidence issue${finalGuards.evidence.advisoryIssues.length === 1 ? "" : "s"} on non-ordering targets, rejected candidates, or unused bundles`,
      );
    }
    if (!finalGuards.coverage.valid || !finalGuards.evidence.valid) {
      const reasons = [
        ...finalGuards.coverage.issues.map(
          (issue) => `${issue.code}: ${issue.message}`,
        ),
        ...finalGuards.evidence.issues.map(
          (issue) => `${issue.code}: ${issue.message}`,
        ),
      ];
      throw new SafetyGuardError(
        `Terminal decision failed deterministic guards: ${reasons.join("; ")}`,
      );
    }
    if (!finalGuards.mutationProvenance.valid) {
      if (
        !canDiscardAllPersistentMutations ||
        persistenceTransaction === undefined
      ) {
        const reasons = finalGuards.mutationProvenance.issues.map(
          (issue) => `PERSISTENCE_PROVENANCE: ${issue.message}`,
        );
        throw new SafetyGuardError(
          `Terminal decision contained persistent mutations that could not be safely rolled back: ${reasons.join("; ")}`,
        );
      }
      await persistenceTransaction.discard();
      persistenceTransaction = undefined;
      stagedPersistenceDiscarded = true;
      warnings.push(
        `Discarded all staged advisory-memory changes because ${finalGuards.mutationProvenance.issues.length} provenance check${finalGuards.mutationProvenance.issues.length === 1 ? "" : "s"} failed; the trade decision remained eligible for independent validation`,
      );
    }
    const targetPlan = materializeTargetDecision(
      rawDecision,
      initialSnapshot,
      initialValuation,
    );
    const decision = targetPlan.decision;
    const decisionRecordedAt = safeTimestamp(now);
    const blockedTargets = (
      targetPlan.reconciliation?.dispositions ?? []
    ).filter((disposition) => disposition.kind === "BLOCKED");
    if (blockedTargets.length > 0) {
      throw new SafetyGuardError(
        `Terminal decision retained blocked portfolio targets after repair: ${blockedTargets
          .map(
            (disposition) =>
              `${disposition.marketSlug} (${disposition.reason}: ${disposition.message})`,
          )
          .join("; ")}`,
      );
    }
    researchTools.recordProviderDecisionReturned();
    const finalPassReadiness = researchTools.strictPassResearchReadiness;
    if (decision.proposals.length === 0 && !finalPassReadiness.allowed) {
      throw new SafetyGuardError(
        `No-order decision did not satisfy the research gate: ${finalPassReadiness.unmet.join("; ")}`,
      );
    }
    await transcriptJournalQueue;
    stageLogger(dependencies.logger, "agent-research").info(
      {
        targetCount: decision.portfolioTargets.length,
        proposalCount: decision.proposals.length,
        marketsSurfaced: researchTools.surfacedMarketSlugs.size,
        marketsInspected: researchTools.inspectedMarketSlugs.size,
        marketsResearched: researchTools.researchedMarketSlugs.size,
        marketsPreviewed: researchTools.previewedMarketSlugs.size,
        passResearchGate: finalPassReadiness.status,
      },
      "Agent decision validated",
    );
    for (const warning of discovery.detailResolver.resolvedDetails.flatMap(
      (details) => details.warnings,
    )) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    for (const warning of familyResolutionWarnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }

    const detailedMarketsBySlug = new Map(
      [
        ...discovery.detailResolver.resolvedMarkets,
        ...familyResolvedMarkets.values(),
      ].map((market) => [market.slug, market]),
    );
    const reportedCatalog = discovery.catalog.markets.map((market) =>
      discovery.marketDiscoveryResolver.applyResolvedMetrics(
        detailedMarketsBySlug.get(market.slug) ?? market,
      ),
    );
    let agentStateAfter = agentStateContext;
    if (agentState.persistent && !stagedPersistenceDiscarded) {
      try {
        agentStateAfter = await agentState.load();
      } catch (error) {
        warnings.push(
          `Structured agent state could not be reloaded after research: ${safeErrorMessage(error)}`,
        );
      }
    }
    await journal?.recordArtifact("agent-state", {
      before: agentStateContext,
      after: agentStateAfter,
    });
    const observedPassResearchGate = researchTools.strictPassResearchReadiness;
    const passResearchGate =
      decision.proposals.length === 0
        ? observedPassResearchGate
        : {
            ...observedPassResearchGate,
            allowed: true,
            status: "NOT_APPLICABLE" as const,
            unmet: [],
          };
    const candidateFunnel = buildCandidateFunnel({
      catalogued: discovery.catalog.markets.length,
      boardSlugs: opportunityBoard.map((market) => market.slug),
      preloadedSlugs: discovery.preloadedHeld.map(({ market }) => market.slug),
      surfacedSlugs: researchTools.surfacedMarketSlugs,
      inspectedSlugs: researchTools.inspectedMarketSlugs,
      mechanicallyEvaluatedSlugs: researchTools.inspectedMarketSlugs,
      mechanicallyQualifiedSlugs: researchTools.qualifiedMarketSlugs,
      researchedSlugs: researchTools.researchedMarketSlugs,
      previewedSlugs: researchTools.previewedMarketSlugs,
      proposedSlugs:
        decision.portfolioTargets.length > 0
          ? decision.portfolioTargets.map((target) => target.marketSlug)
          : decision.proposals.map((proposal) => proposal.marketSlug),
      dispositionedSlugs: decision.candidateDispositions.map(
        (disposition) => disposition.marketSlug,
      ),
      passResearchGate,
    });
    const proposedMarketSlugs = new Set(
      decision.portfolioTargets.length > 0
        ? decision.portfolioTargets.map((target) => target.marketSlug)
        : decision.proposals.map((proposal) => proposal.marketSlug),
    );
    const marketSelectionObservation = observeMarketSelectionTreatment({
      actualTreatment: opportunityBoard,
      surfaced: researchTools.surfacedMarketSlugs,
      inspected: researchTools.inspectedMarketSlugs,
      researched: researchTools.researchedMarketSlugs,
      previewed: researchTools.previewedMarketSlugs,
      dispositioned: new Set(
        decision.candidateDispositions.map(
          (disposition) => disposition.marketSlug,
        ),
      ),
      proposed: proposedMarketSlugs,
    });
    await journal?.recordArtifact("market-universe", {
      catalog: compactCatalogArtifact(
        reportedCatalog,
        discovery.catalog.heldSlugs,
      ),
      discoveryAudit: researchTools.marketDiscoveryAudit,
      surfacedMarketSlugs: [...researchTools.surfacedMarketSlugs],
      inspectedMarketSlugs: [...researchTools.inspectedMarketSlugs],
      researchedMarketSlugs: [...researchTools.researchedMarketSlugs],
      previewedMarketSlugs: [...researchTools.previewedMarketSlugs],
      mechanicallyQualifiedMarketSlugs: [...researchTools.qualifiedMarketSlugs],
      opportunityBoardSlugs: opportunityBoard.map((market) => market.slug),
      opportunityBoardSelections: opportunityBoard.map((market) => ({
        slug: market.slug,
        exchangeRank: market.exchangeRank,
        selectionLane: market.selectionLane,
        ...(market.prioritySignal === undefined
          ? {}
          : { prioritySignal: market.prioritySignal }),
        ...(market.familyScout === undefined
          ? {}
          : { familyScout: market.familyScout }),
      })),
    });
    await journal?.recordArtifact("candidate-funnel", candidateFunnel);
    await journal?.recordArtifact("market-selection-experiment", {
      ...discovery.marketSelectionExperiment,
      forwardObservation: marketSelectionObservation,
    });
    await journal?.recordArtifact("decision-coverage", decisionCoverage);
    await journal?.recordArtifact("pass-edge-audit", {
      experimentId: "both-sides-pass-audit-v1",
      hypothesis:
        "Auditing both sides of a NO_POSITIVE_EDGE disposition at a frozen fresh BBO will prevent the model from hiding a positive conservative opposite-side edge behind a verbal second uncertainty haircut.",
      treatment: {
        minimumMaterialNetEdge:
          "strictly greater than max(market price tick, 0.005) per contract",
        producesOrderDirectly: false,
        requiresModelRepairAndOrdinaryTradeValidation: true,
      },
      baseline: {
        runId: "3a6a8880-17c8-4e25-b55b-00268c0b4780",
        cycleId: "94e2bfe4-d31b-4168-89d9-3d54c7bc2b60",
        candidate: "tc-temp-laxhigh-2026-08-05-gte77lt78f",
        result:
          "Passed YES as no edge while the same interval implied P(NO) authorization 0.3875 against a 0.27 NO ask before fees; rationale then applied an extra confidence haircut outside the interval.",
      },
      final: passEdgeAudit,
      auditAttemptCount: passEdgeAuditHistory.length,
      triggeredIssueCount: passEdgeAuditHistory.reduce(
        (total, audit) => total + audit.issues.length,
        0,
      ),
      attempts: passEdgeAuditHistory,
    });
    await journal?.recordArtifact("evidence-validation", evidenceValidation);
    const evidenceExperimentCounts = researchTools.totalCounts;
    await journal?.recordArtifact("evidence-source-experiment", {
      schemaVersion: 1,
      experimentId: "evidence-authorization-v2",
      hypothesis:
        "Separating inspected contract numbers from external source claims and ignoring malformed redundant citations after the configured valid-domain gate is satisfied will reduce false evidence vetoes without allowing an unverified source to authorize exposure.",
      mode: "FORWARD_OBSERVE_ONLY",
      treatment: {
        maximumEvidenceSourceReadRequests:
          liveDecisionLimits.maximumEvidenceSourceReadRequests,
        minimumIndependentSources:
          dependencies.config.risk.minimumIndependentSources,
        contractNumbersMayComeFromInspectedMarket: true,
        invalidRedundantSourcesCountTowardAuthorization: false,
        invalidRedundantSourcesRemainAudited: true,
      },
      observation: {
        evidenceSourceReadAttempts:
          evidenceExperimentCounts.evidenceSourceReads,
        successfulEvidenceSourceReads:
          evidenceExperimentCounts.successfulEvidenceSourceReads,
        verifiedSourceCount: evidenceValidation.verifiedSources.length,
        verifiedCurrentUrlCount: evidenceValidation.verifiedCurrentUrls.length,
        independentCurrentDomainCount:
          evidenceValidation.independentCurrentDomains.length,
        blockingIssueCount: evidenceValidation.issues.length,
        advisoryIssueCount: evidenceValidation.advisoryIssues.length,
      },
      limitations: [
        "A single forward cycle cannot establish calibration or realized return.",
        "A target still requires the configured number of independently verified current domains; contract context cannot substitute for a source claim.",
        "Sources cited only for held positions or passed candidates are audited but do not authorize new exposure.",
      ],
      baseline: {
        runId: "f4793abc-7cf9-46eb-bc47-c9bf1a295e1a",
        cycleId: "25367c5c-2f74-42ef-9721-a53b49d6694c",
        candidate: "tc-temp-laxhigh-2026-08-05-gte77lt78f:NO",
        result:
          "A proposed 1% target with model authorization probability 0.79 versus a 0.27 ask was removed after contract bucket numbers in relevance were treated as unsupported source claims and a redundant CLI citation failed exact matching.",
      },
    });
    await journal?.recordArtifact("persistence-provenance", mutationProvenance);
    await journal?.recordArtifact("operator-memory-experiment", {
      schemaVersion: 1,
      experimentId: "advisory-operator-memory-v1",
      hypothesis:
        "Allowing inspected-market or observed-source provenance for advisory state will preserve reusable resolver, execution, and market-structure lessons without weakening trade authorization.",
      treatment: {
        requiredBeliefProvenance:
          "OBSERVED_CURRENT_CYCLE_URL_OR_INSPECTED_MARKET",
        tradeEvidencePolicyChanged: false,
        stateCanAuthorizeTrades: false,
      },
      observation: {
        mutationCount: mutationProvenance.mutationCount,
        committed: mutationProvenance.valid,
        issueCount: mutationProvenance.issues.length,
        issues: mutationProvenance.issues,
      },
      baseline: {
        runId: "642b2a56-bee4-4ff0-94a2-6d26586d58e7",
        cycleId: "c21d231d-11dd-4cef-8b40-f3d853fbd3f2",
        mutationCount: 2,
        committed: false,
        issueCount: 3,
      },
      limitation:
        "A successful commit tests retention mechanics only; later cycles must show that retrieved lessons improve decisions.",
    });
    await journal?.recordArtifact("decision-transcript", {
      provider: dependencies.decisionProvider.providerId,
      model: dependencies.decisionProvider.modelId,
      ...(dependencies.decisionProvider.catalogModelId === undefined
        ? {}
        : { catalogModel: dependencies.decisionProvider.catalogModelId }),
      rounds: transcriptRounds,
    });
    // Preserve model-authored intent while retaining the canonical materialized
    // decision used by report/advisory recovery.
    await journal?.recordArtifact("decision-intent", rawDecision);
    await journal?.recordArtifact("decision", decision);
    if (targetPlan.reconciliation !== undefined) {
      await journal?.recordArtifact(
        "target-reconciliation",
        targetPlan.reconciliation,
      );
    }
    await journal?.transition("DECIDED");

    const validationExecution = await withStageTimeout(
      "validation-execution",
      dependencies.config.cycle.stageBudgetsSeconds.validationExecution * 1000,
      async (signal) => {
        // This fresh validation remains authoritative. Any earlier terminal
        // review was read-only feedback to the model and cannot approve an
        // order or reserve exchange state.
        const validation = await validateDecisionProposals(
          targetPlan.riskProposals,
          signal,
        );
        await journal?.recordArtifact("validation", validation);
        const cycleSpendCapacity = initialValuation.riskEquity.mul(
          dependencies.config.risk.maximumCycleSpendFraction,
        );
        await journal?.recordArtifact("concentration-experiment", {
          schemaVersion: 1,
          experimentId: "conditional-concentration-v1",
          hypothesis:
            "Higher fractional Kelly and wider position/cycle ceilings will let a small number of independently evidenced, high-edge targets use available capital; evidence, settlement, spread, depth, and uncertainty guards remain unchanged.",
          baseline: {
            maximumPositionCostBasisFraction: "0.45",
            maximumCycleSpendFraction: "0.20",
            kellyFraction: "0.65",
            runId: "03b34e88-0df5-47da-a84b-d194f2f1fe89",
            cycleId: "c1e05356-7f4e-4c21-a89d-e2565cf4f665",
            observedCycleSpendCapacity: "17.4380957",
            firstAcceptedMaximumSpend: "15.69428258",
            secondTargetRequestedRisk: "8.71938",
            secondAcceptedMaximumSpend: "1.74381312",
            result:
              "The 20% cycle ceiling bound and resized the second target.",
          },
          treatment: {
            maximumPositionCostBasisFraction:
              dependencies.config.risk.maximumPositionCostBasisFraction.toFixed(),
            maximumCycleSpendFraction:
              dependencies.config.risk.maximumCycleSpendFraction.toFixed(),
            kellyFraction: dependencies.config.risk.kellyFraction.toFixed(),
            uncertaintyBoundWeight:
              dependencies.config.risk.uncertaintyBoundWeight.toFixed(),
            maximumExecutionSpread:
              dependencies.config.risk.maximumExecutionSpread.toFixed(),
            minimumIndependentSources:
              dependencies.config.risk.minimumIndependentSources,
          },
          observation: {
            riskEquity: initialValuation.riskEquity.toFixed(),
            cycleSpendCapacity: cycleSpendCapacity.toFixed(),
            committedCycleSpend: validation.committedCycleSpend.toFixed(),
            capacityUtilization: cycleSpendCapacity.isZero()
              ? "0"
              : validation.committedCycleSpend
                  .div(cycleSpendCapacity)
                  .toFixed(),
            accepted: validation.accepted.map((item) => ({
              marketSlug: item.proposal.marketSlug,
              side: item.proposal.side,
              action: item.proposal.action,
              requestedRisk: item.proposal.maximumRiskUsd.toFixed(),
              maximumExecutionSpend: item.maximumExecutionSpend.toFixed(),
              ...(item.netEdge === undefined
                ? {}
                : {
                    conservativeNetEdgePerContract: item.netEdge.toFixed(),
                  }),
            })),
            rejected: validation.rejected.map((item) => ({
              marketSlug: item.proposal.marketSlug,
              side: item.proposal.side,
              action: item.proposal.action,
              code: item.code,
            })),
          },
          limitation:
            "A ceiling increase is useful only when a candidate survives forecasting, evidence, settlement, book, and positive-edge validation; it does not manufacture opportunities.",
        });
        await journal?.transition("VALIDATED");

        const shadowLedgerEnabled =
          dependencies.config.reporting.shadowLedger.enabled &&
          dependencies.writeReports !== false;
        const shadowLedgerCandidates = shadowLedgerEnabled
          ? buildShadowLedgerCandidates({
              decision,
              ...(targetPlan.reconciliation === undefined
                ? {}
                : { reconciliation: targetPlan.reconciliation }),
              validation,
            })
          : [];
        const captureShadowLedger = async (
          allowAdditionalReads: boolean,
        ): Promise<ShadowLedgerCaptureResult | undefined> => {
          if (!shadowLedgerEnabled) return undefined;
          const capture = await captureShadowLedgerObservations({
            exchange: dependencies.exchange,
            accountScope,
            runId,
            cycleId,
            mode: dependencies.mode,
            decisionRecordedAt,
            candidates: shadowLedgerCandidates,
            validation,
            knownMarkets: detailedMarketsBySlug,
            maximumObservations:
              dependencies.config.reporting.shadowLedger
                .maximumObservationsPerCycle,
            maximumConcurrentRequests:
              dependencies.config.exchange.maximumConcurrentRequests,
            uncertaintyBoundWeight:
              dependencies.config.risk.uncertaintyBoundWeight,
            allowAdditionalReads,
            now,
            signal,
          });
          await journal?.recordArtifact("shadow-ledger-capture", capture);
          return capture;
        };

        if (
          dependencies.mode === "live" &&
          initialSnapshot.openOrders.length > 0
        ) {
          warnings.push(
            "Unexpected open orders disabled live execution for this cycle; no orders were canceled",
          );
          const execution = emptyExecutionRun();
          await journal?.recordArtifact("execution-report", execution);
          await journal?.transition("RECONCILING");
          const shadowLedgerCapture = await captureShadowLedger(true);
          return {
            validation,
            execution,
            safetyStop: true,
            ...(shadowLedgerCapture === undefined
              ? {}
              : { shadowLedgerCapture }),
          };
        }
        if (dependencies.mode === "live" && validation.accepted.length > 0) {
          await journal?.transition("EXECUTING");
        }
        const execution = await executeValidatedOrders({
          exchange: dependencies.exchange,
          mode: dependencies.mode,
          snapshot: initialSnapshot,
          riskEquity: initialValuation.riskEquity,
          validated: validation.accepted,
          policy: dependencies.config.risk,
          signal,
          now,
          ...(journal === undefined
            ? {}
            : { journal: executionJournalHooks(journal) }),
        });
        await journal?.recordArtifact("execution-report", execution);
        await journal?.transition("RECONCILING");
        // In live mode, quote non-authorized candidates only after execution
        // has completed so measurement cannot consume a short-lived trading
        // edge. An ambiguous order state stays on the no-extra-read path.
        const shadowLedgerCapture = await captureShadowLedger(
          dependencies.mode === "observe" || !execution.stoppedForAmbiguity,
        );
        return {
          validation,
          execution,
          safetyStop: false,
          ...(shadowLedgerCapture === undefined ? {} : { shadowLedgerCapture }),
        };
      },
      overallController.signal,
    );
    const { validation, execution, safetyStop, shadowLedgerCapture } =
      validationExecution;

    // Make the prospective decision record durable before account reporting.
    // A post-order account API compatibility failure must not erase the exact
    // executable quote and forecast that existed before the mutation.
    let shadowLedger: ShadowLedgerCycleReport | undefined;
    if (shadowLedgerCapture !== undefined) {
      try {
        shadowLedger = await withStageTimeout(
          "shadow-ledger-reconciliation",
          dependencies.config.cycle.stageBudgetsSeconds
            .reconciliationReporting * 1000,
          (signal) =>
            persistAndReconcileShadowLedger({
              rootDirectory: dependencies.config.reporting.directory,
              exchange: dependencies.exchange,
              accountScope,
              runId,
              cycleId,
              capture: shadowLedgerCapture,
              maximumSettlementChecks:
                dependencies.config.reporting.shadowLedger
                  .maximumSettlementChecksPerCycle,
              maximumMarkChecks:
                dependencies.config.reporting.shadowLedger
                  .maximumMarkChecksPerCycle,
              maximumConcurrentRequests:
                dependencies.config.exchange.maximumConcurrentRequests,
              now,
              signal,
            }),
          overallController.signal,
        );
      } catch (error) {
        if (overallController.signal.aborted) throw error;
        shadowLedger = degradedShadowLedgerReport({
          rootDirectory: dependencies.config.reporting.directory,
          exchangeId: dependencies.exchange.id,
          accountScope,
          capture: shadowLedgerCapture,
        });
        warnings.push(
          `The prospective shadow ledger capture was retained in this run, but cross-cycle persistence failed: ${safeErrorMessage(error)}`,
        );
      }
      await journal?.recordArtifact("shadow-ledger", shadowLedger);
    }

    const finalSnapshot = await withStageTimeout(
      "reconciliation-reporting",
      dependencies.config.cycle.stageBudgetsSeconds.reconciliationReporting *
        1000,
      () => reconstructAccount(dependencies.exchange),
      overallController.signal,
    );
    const finalValuation = await valuePortfolio(
      dependencies.exchange,
      finalSnapshot,
      dependencies.config.exchange.maximumConcurrentRequests,
    );
    await journal?.recordArtifact("account-after", {
      snapshot: finalSnapshot,
      valuation: finalValuation,
    });
    await persistenceTransaction?.commit();
    persistenceTransaction = undefined;
    const completedAt = now();
    const counts = researchTools.totalCounts;
    const tokenUsage = aggregateTokenUsage(transcriptRounds);
    const cacheDiagnostics = aggregateCacheDiagnostics(transcriptRounds);
    const decisionAudit = {
      evidence: {
        valid: evidenceValidation.valid,
        verifiedSourceCount: evidenceValidation.verifiedSources.length,
        verifiedCurrentUrlCount: evidenceValidation.verifiedCurrentUrls.length,
        independentCurrentDomainCount:
          evidenceValidation.independentCurrentDomains.length,
        blockingIssueCount: evidenceValidation.issues.length,
        advisoryIssueCount: evidenceValidation.advisoryIssues.length,
      },
      coverage: {
        valid: decisionCoverage.valid,
        requiredMarketCount: new Set([
          ...decisionCoverage.requiredSeriouslyEvaluatedMarketSlugs,
          ...decisionCoverage.requiredPrioritySignalMarketSlugs,
        ]).size,
        explicitlyTargeted: decisionCoverage.explicitlyTargeted,
        explicitlyDispositioned: decisionCoverage.explicitlyDispositioned,
        issueCount: decisionCoverage.issues.length,
      },
      persistence: {
        valid: mutationProvenance.valid,
        mutationCount: mutationProvenance.mutationCount,
        issueCount: mutationProvenance.issues.length,
      },
    };
    const report = buildCycleReport({
      runId,
      cycleId,
      mode: dependencies.mode,
      exchangeId: dependencies.exchange.id,
      startedAt,
      completedAt,
      accountBefore: initialSnapshot,
      accountAfter: finalSnapshot,
      valuationBefore: initialValuation,
      valuationAfter: finalValuation,
      agentStateBefore: agentStateContext,
      agentStateAfter,
      marketDiscovery: {
        catalogued: discovery.catalog.markets.length,
        surfaced: researchTools.surfacedMarketSlugs.size,
        inspected: researchTools.inspectedMarketSlugs.size,
        preloadedHeld: discovery.preloadedHeld.length,
        preloadedOpportunities: opportunityBoard.length,
        exchangeRankedOpportunities: opportunityBoard.filter(
          (market) => market.selectionLane === "EXCHANGE_RANK",
        ).length,
        familyScoutedOpportunities: opportunityBoard.filter(
          (market) => market.selectionLane === "FAMILY_SCOUT",
        ).length,
        categories: discovery.catalog.categoryCounts,
      },
      provider: dependencies.decisionProvider.providerId,
      model: dependencies.decisionProvider.modelId,
      marketDiscoveryCount: counts.marketDiscoveryRequests,
      webSearchCount: counts.webSearches,
      evidenceSourceReadCount: counts.evidenceSourceReads,
      successfulEvidenceSourceReadCount: counts.successfulEvidenceSourceReads,
      marketDetailCount: counts.marketDetailRequests,
      marketAnalysisCount: counts.marketAnalysisRequests,
      tradePreviewCount: counts.tradePreviews,
      noteOperationCount: counts.noteOperations,
      stateOperationCount: counts.stateOperations,
      candidateFunnel,
      ...(shadowLedger === undefined ? {} : { shadowLedger }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      ...(cacheDiagnostics === undefined ? {} : { cacheDiagnostics }),
      decisionAudit,
      decision,
      ...(targetPlan.reconciliation === undefined
        ? {}
        : { targetReconciliation: targetPlan.reconciliation }),
      validation,
      execution,
      warnings,
      ...(safetyStop ? { statusOverride: "SAFETY_STOP" } : {}),
    });

    if (journal !== undefined) {
      await journal.recordArtifact("cycle-report", report);
      await appendJobSummary(report);
      await journal.complete(completedJournalStatus(report.status));
      try {
        const historyPersistence = await persistCrossCycleHistory({
          rootDirectory: dependencies.config.reporting.directory,
          accountScope,
          report,
        });
        if (!historyPersistence.persisted) {
          stageLogger(dependencies.logger, "reporting").warn(
            { reason: historyPersistence.reason },
            "Completed-cycle history index was not updated; immutable cycle reports remain available",
          );
        }
      } catch {
        // History is a derived view. The durable journal is already terminal,
        // so an unexpected indexing fault must never change cycle completion.
        stageLogger(dependencies.logger, "reporting").warn(
          { reason: "UNEXPECTED_FAILURE" },
          "Completed-cycle history index was not updated; immutable cycle reports remain available",
        );
      }
      const advisoryPersistence = await persistCompletedCycleAdvisoryWithResult(
        {
          rootDirectory: dependencies.config.reporting.directory,
          accountScope,
          manifest: journal.currentManifest,
          decision,
          report,
        },
      );
      if (!advisoryPersistence.persisted) {
        stageLogger(dependencies.logger, "reporting").warn(
          { reason: advisoryPersistence.reason },
          "Completed-cycle advisory snapshot was not updated; a future cycle may retain the previous stable replay",
        );
      }
    }
    stageLogger(dependencies.logger, "complete").info(
      { status: report.status },
      "Prediction cycle completed",
    );
    return report;
  } catch (error) {
    await persistenceTransaction?.discard().catch((discardError: unknown) => {
      stageLogger(dependencies.logger, "reporting").error(
        { error: safeErrorMessage(discardError) },
        "Could not discard staged agent persistence",
      );
    });
    persistenceTransaction = undefined;
    try {
      await transcriptJournalQueue;
    } catch (transcriptError) {
      stageLogger(dependencies.logger, "reporting").error(
        {
          error:
            transcriptError instanceof Error
              ? transcriptError.message
              : "Unknown transcript journal failure",
        },
        "Could not flush decision-round telemetry",
      );
    }
    if (journal !== undefined) {
      try {
        const failure = cycleFailureArtifact(error, safeTimestamp(now));
        const details = { stage: journal.currentManifest.stage };
        if (
          error instanceof ExecutionJournalError &&
          error.mutationMayHaveOccurred
        ) {
          await journal.markAmbiguous(failure, details);
        } else {
          await journal.fail(failure, details);
        }
      } catch (journalError) {
        stageLogger(dependencies.logger, "reporting").error(
          {
            error:
              journalError instanceof Error
                ? journalError.message
                : "Unknown journal failure",
          },
          "Could not finalize failed run journal",
        );
      }
    }
    throw error;
  } finally {
    clearTimeout(overallTimeout);
    if (liveCycleLock !== undefined) {
      try {
        await liveCycleLock.release();
      } catch (error) {
        stageLogger(dependencies.logger, "reporting").error(
          { error: safeErrorMessage(error) },
          "Could not release the live-cycle lock",
        );
      }
    }
  }
}
