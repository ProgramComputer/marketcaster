import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { AgentDecisionSchema } from "../agent/decision-schema.js";
import type { ExchangeId } from "../domain/primitives.js";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../exchanges/memory-scope.js";
import { redactPotentialSecrets } from "../utilities/redaction.js";
import { writeJsonArtifact } from "./artifact.js";

const ADVISORY_SCHEMA_VERSION = 1 as const;
const MAXIMUM_SNAPSHOT_BYTES = 256 * 1024;
const MAXIMUM_REPLAY_JSON_CHARACTERS = 64_000;
const MAXIMUM_REPORT_START_SKEW_MILLISECONDS = 60_000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const REPLAY_LIMITS = {
  cycleSummaryCharacters: 3_500,
  proposals: 5,
  thesisCharacters: 1_200,
  settlementVerificationCharacters: 600,
  invalidationConditionCharacters: 600,
  evidencePerProposal: 3,
  evidenceTitleCharacters: 200,
  evidenceUrlCharacters: 1_000,
  evidenceRelevanceCharacters: 400,
  rejectedProposals: 12,
  rejectionReasonCharacters: 400,
  targetReconciliations: 12,
  reconciliationReasonCharacters: 400,
  executions: 12,
  executionReasonCharacters: 400,
} as const;

const ExchangeIdSchema = z.enum([
  "polymarket-us",
  "polymarket-international",
  "kalshi",
]);
const RuntimeModeSchema = z.enum(["observe", "live"]);
const CompletedStageSchema = z.enum([
  "SUCCESS",
  "PASS",
  "AMBIGUOUS",
  "SAFETY_STOP",
]);
const TimestampSchema = z.iso.datetime({ offset: true });
const AccountScopeSchema = z.string().refine((value) => {
  try {
    assertSafeMemoryScope(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a safe opaque account scope");
const DecimalStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      return new Decimal(value).isFinite();
    } catch {
      return false;
    }
  }, "Expected a finite decimal string");

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(ADVISORY_SCHEMA_VERSION),
    runId: z.string().regex(SAFE_NAME),
    cycleId: z.string().regex(SAFE_NAME),
    mode: RuntimeModeSchema,
    exchangeId: ExchangeIdSchema,
    accountScope: AccountScopeSchema,
    stage: CompletedStageSchema,
    startedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema,
  })
  .loose();

const ReportProposalSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    estimatedProbability: DecimalStringSchema,
    maximumRiskUsd: DecimalStringSchema,
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  })
  .loose();

const ReportPortfolioTargetSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    targetCostBasisFraction: DecimalStringSchema,
    estimatedProbability: DecimalStringSchema,
    probabilityLowerBound: DecimalStringSchema,
    probabilityUpperBound: DecimalStringSchema,
    maximumEntryPrice: DecimalStringSchema.optional(),
    minimumExitPrice: DecimalStringSchema.optional(),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  })
  .loose();

const ReportTargetReconciliationSchema = z
  .object({
    targetIndex: z.number().int().nonnegative(),
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    kind: z.enum(["PROPOSED", "HOLD", "BLOCKED"]),
    reason: z.string().trim().min(1).max(500),
    message: z.string().trim().min(1).max(2_048).optional(),
  })
  .loose();

const RejectedProposalReportSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    code: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(2_048),
  })
  .loose();

const ExecutionReportSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    quantity: DecimalStringSchema,
    canonicalLimitPrice: DecimalStringSchema,
    status: z.string().trim().min(1).max(100),
    filledQuantity: DecimalStringSchema,
    averageFillPrice: DecimalStringSchema.optional(),
    fees: DecimalStringSchema,
    finalState: z.string().trim().min(1).max(100),
    skippedReason: z.string().trim().min(1).max(2_048).optional(),
    ambiguousReason: z.string().trim().min(1).max(2_048).optional(),
  })
  .loose();

const CycleReportSchema = z
  .object({
    runId: z.string().regex(SAFE_NAME),
    cycleId: z.string().regex(SAFE_NAME),
    mode: RuntimeModeSchema,
    exchangeId: ExchangeIdSchema,
    status: CompletedStageSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    accountBefore: z
      .object({
        activityBreakdown: z
          .object({ tradingPnl: DecimalStringSchema })
          .loose(),
      })
      .loose(),
    accountAfter: z
      .object({
        activityBreakdown: z
          .object({ tradingPnl: DecimalStringSchema })
          .loose(),
      })
      .loose(),
    agent: z
      .object({
        summary: z.string().trim().min(1).max(5_000),
        proposals: z.array(ReportProposalSchema).max(100),
        portfolioTargets: z
          .array(ReportPortfolioTargetSchema)
          .max(100)
          .optional(),
        targetReconciliations: z
          .array(ReportTargetReconciliationSchema)
          .max(100)
          .optional(),
      })
      .loose(),
    risk: z
      .object({
        accepted: z.array(ReportProposalSchema).max(100),
        rejected: z.array(RejectedProposalReportSchema).max(100),
      })
      .loose(),
    executions: z.array(ExecutionReportSchema).max(100),
  })
  .loose();

const DecisionEvidenceAdvisorySchema = z
  .object({
    title: z.string().min(1).max(REPLAY_LIMITS.evidenceTitleCharacters),
    url: z.string().min(1).max(REPLAY_LIMITS.evidenceUrlCharacters),
    publishedAt: TimestampSchema.optional(),
    relevance: z.string().min(1).max(REPLAY_LIMITS.evidenceRelevanceCharacters),
  })
  .strict();

const ProposalAdvisorySchema = z
  .object({
    marketSlug: z.string().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    estimatedProbability: DecimalStringSchema,
    maximumEntryPrice: DecimalStringSchema.optional(),
    minimumExitPrice: DecimalStringSchema.optional(),
    maximumRiskUsd: DecimalStringSchema,
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string().min(1).max(REPLAY_LIMITS.thesisCharacters),
    settlementVerification: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.settlementVerificationCharacters),
    invalidationConditions: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.invalidationConditionCharacters),
    evidence: z
      .array(DecisionEvidenceAdvisorySchema)
      .max(REPLAY_LIMITS.evidencePerProposal),
    replayTruncated: z.boolean(),
  })
  .strict();

const PortfolioTargetAdvisorySchema = z
  .object({
    marketSlug: z.string().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    targetCostBasisFraction: DecimalStringSchema,
    estimatedProbability: DecimalStringSchema,
    probabilityLowerBound: DecimalStringSchema,
    probabilityUpperBound: DecimalStringSchema,
    maximumEntryPrice: DecimalStringSchema.optional(),
    minimumExitPrice: DecimalStringSchema.optional(),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    thesis: z.string().min(1).max(REPLAY_LIMITS.thesisCharacters),
    settlementVerification: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.settlementVerificationCharacters),
    invalidationConditions: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.invalidationConditionCharacters),
    evidence: z
      .array(DecisionEvidenceAdvisorySchema)
      .max(REPLAY_LIMITS.evidencePerProposal),
    replayTruncated: z.boolean(),
  })
  .strict();

const RejectedProposalAdvisorySchema = z
  .object({
    marketSlug: z.string().min(1).max(500),
    code: z.string().min(1).max(500),
    reason: z.string().min(1).max(REPLAY_LIMITS.rejectionReasonCharacters),
  })
  .strict();

const TargetReconciliationAdvisorySchema = z
  .object({
    targetIndex: z.number().int().nonnegative(),
    marketSlug: z.string().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    kind: z.enum(["PROPOSED", "HOLD", "BLOCKED"]),
    reason: z.string().min(1).max(500),
    message: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.reconciliationReasonCharacters)
      .optional(),
  })
  .strict();

const ExecutionAdvisorySchema = z
  .object({
    marketSlug: z.string().min(1).max(500),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    quantity: DecimalStringSchema,
    canonicalLimitPrice: DecimalStringSchema,
    status: z.string().min(1).max(100),
    filledQuantity: DecimalStringSchema,
    averageFillPrice: DecimalStringSchema.optional(),
    fees: DecimalStringSchema,
    finalState: z.string().min(1).max(100),
    skippedReason: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.executionReasonCharacters)
      .optional(),
    ambiguousReason: z
      .string()
      .min(1)
      .max(REPLAY_LIMITS.executionReasonCharacters)
      .optional(),
  })
  .strict();

const PreviousCycleAdvisorySchema = z
  .object({
    advisoryOnly: z.literal(true),
    freshExchangeStateRequired: z.literal(true),
    source: z
      .object({
        runId: z.string().regex(SAFE_NAME),
        cycleId: z.string().regex(SAFE_NAME),
        mode: RuntimeModeSchema,
        status: CompletedStageSchema,
        completedAt: TimestampSchema,
      })
      .strict(),
    decision: z
      .object({
        cycleSummary: z
          .string()
          .min(1)
          .max(REPLAY_LIMITS.cycleSummaryCharacters),
        cycleSummaryTruncated: z.boolean(),
        proposals: z.array(ProposalAdvisorySchema).max(REPLAY_LIMITS.proposals),
        proposalsTruncated: z.boolean(),
        portfolioTargets: z
          .array(PortfolioTargetAdvisorySchema)
          .max(REPLAY_LIMITS.proposals)
          .optional(),
        portfolioTargetsTruncated: z.boolean().optional(),
      })
      .strict(),
    performance: z
      .object({
        reportedTradingPnlBeforeUsd: DecimalStringSchema,
        reportedTradingPnlAfterUsd: DecimalStringSchema,
        reportedTradingPnlChangeUsd: DecimalStringSchema,
        acceptedProposalCount: z.number().int().min(0).max(100),
        rejectedProposals: z
          .array(RejectedProposalAdvisorySchema)
          .max(REPLAY_LIMITS.rejectedProposals),
        rejectedProposalsTruncated: z.boolean(),
        targetReconciliations: z
          .array(TargetReconciliationAdvisorySchema)
          .max(REPLAY_LIMITS.targetReconciliations)
          .optional(),
        targetReconciliationsTruncated: z.boolean().optional(),
        executions: z
          .array(ExecutionAdvisorySchema)
          .max(REPLAY_LIMITS.executions),
        executionsTruncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

const AdvisorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(ADVISORY_SCHEMA_VERSION),
    exchangeId: ExchangeIdSchema,
    accountScope: AccountScopeSchema,
    advisory: PreviousCycleAdvisorySchema,
  })
  .strict();

type Manifest = z.infer<typeof ManifestSchema>;
type CycleReport = z.infer<typeof CycleReportSchema>;
type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export type PreviousCycleDecisionEvidenceAdvisory = z.infer<
  typeof DecisionEvidenceAdvisorySchema
>;
export type PreviousCycleProposalAdvisory = z.infer<
  typeof ProposalAdvisorySchema
>;
export type PreviousCyclePortfolioTargetAdvisory = z.infer<
  typeof PortfolioTargetAdvisorySchema
>;
export type PreviousCycleRejectedProposalAdvisory = z.infer<
  typeof RejectedProposalAdvisorySchema
>;
export type PreviousCycleTargetReconciliationAdvisory = z.infer<
  typeof TargetReconciliationAdvisorySchema
>;
export type PreviousCycleExecutionAdvisory = z.infer<
  typeof ExecutionAdvisorySchema
>;

/** Historical context only; current exchange state always remains authoritative. */
export type PreviousCycleAdvisory = z.infer<typeof PreviousCycleAdvisorySchema>;

export interface LoadPreviousCycleAdvisoryInput {
  readonly rootDirectory: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
}

export interface PersistCompletedCycleAdvisoryInput {
  readonly rootDirectory: string;
  readonly accountScope: string;
  readonly manifest: unknown;
  readonly decision: unknown;
  readonly report: unknown;
}

export type CompletedCycleAdvisoryPersistenceFailureReason =
  | "INVALID_ACCOUNT_SCOPE"
  | "UNSCOPED_ACCOUNT_SCOPE"
  | "MANIFEST_VALIDATION_FAILED"
  | "DECISION_VALIDATION_FAILED"
  | "REPORT_VALIDATION_FAILED"
  | "ACCOUNT_SCOPE_MISMATCH"
  | "MANIFEST_CHRONOLOGY_INVALID"
  | "REPORT_MANIFEST_MISMATCH"
  | "REPORT_DECISION_MISMATCH"
  | "ADVISORY_BUILD_FAILED"
  | "REPLAY_SIZE_EXCEEDED"
  | "SNAPSHOT_VALIDATION_FAILED"
  | "WRITE_FAILED";

export type PersistCompletedCycleAdvisoryResult =
  | { readonly persisted: true }
  | {
      readonly persisted: false;
      /** Stable diagnostic code only; never contains user data or secrets. */
      readonly reason: CompletedCycleAdvisoryPersistenceFailureReason;
    };

interface ReplayText {
  readonly value: string;
  readonly truncated: boolean;
}

function replayText(value: string, maximumCharacters: number): ReplayText {
  const sanitized = redactPotentialSecrets(value);
  const characters = Array.from(sanitized);
  return {
    value:
      characters.length <= maximumCharacters
        ? sanitized
        : characters.slice(0, maximumCharacters).join(""),
    truncated: characters.length > maximumCharacters,
  };
}

function sanitized(value: string): string {
  return redactPotentialSecrets(value);
}

function validManifestChronology(manifest: Manifest): boolean {
  const startedAt = Date.parse(manifest.startedAt);
  const updatedAt = Date.parse(manifest.updatedAt);
  const completedAt = Date.parse(manifest.completedAt);
  return (
    startedAt <= completedAt &&
    updatedAt === completedAt &&
    Number.isFinite(completedAt)
  );
}

function reportMatchesManifest(
  report: CycleReport,
  manifest: Manifest,
): boolean {
  const manifestStartedAt = Date.parse(manifest.startedAt);
  const reportStartedAt = Date.parse(report.startedAt);
  const reportCompletedAt = Date.parse(report.completedAt);
  return (
    report.runId === manifest.runId &&
    report.cycleId === manifest.cycleId &&
    report.mode === manifest.mode &&
    report.exchangeId === manifest.exchangeId &&
    report.status === manifest.stage &&
    Math.abs(reportStartedAt - manifestStartedAt) <=
      MAXIMUM_REPORT_START_SKEW_MILLISECONDS &&
    reportCompletedAt >= reportStartedAt &&
    reportCompletedAt <= Date.parse(manifest.completedAt)
  );
}

function reportMatchesDecision(
  report: CycleReport,
  decision: AgentDecision,
): boolean {
  const reportedTargets = report.agent.portfolioTargets ?? [];
  if (
    report.agent.summary !== decision.cycleSummary ||
    report.agent.proposals.length !== decision.proposals.length ||
    reportedTargets.length !== decision.portfolioTargets.length
  ) {
    return false;
  }
  const proposalsMatch = report.agent.proposals.every((reported, index) => {
    const proposed = decision.proposals[index];
    return (
      reported.marketSlug === proposed?.marketSlug &&
      reported.side === proposed.side &&
      reported.action === proposed.action &&
      new Decimal(reported.estimatedProbability).eq(
        proposed.estimatedProbability,
      ) &&
      new Decimal(reported.maximumRiskUsd).eq(proposed.maximumRiskUsd) &&
      reported.confidence === proposed.confidence
    );
  });
  if (!proposalsMatch) return false;
  return reportedTargets.every((reported, index) => {
    const target = decision.portfolioTargets[index];
    if (target === undefined) return false;
    const optionalDecimalMatches = (
      reportedValue: string | undefined,
      decisionValue: Decimal | undefined,
    ): boolean =>
      reportedValue === undefined
        ? decisionValue === undefined
        : decisionValue !== undefined &&
          new Decimal(reportedValue).eq(decisionValue);
    return (
      reported.marketSlug === target.marketSlug &&
      reported.side === target.side &&
      new Decimal(reported.targetCostBasisFraction).eq(
        target.targetCostBasisFraction,
      ) &&
      new Decimal(reported.estimatedProbability).eq(
        target.estimatedProbability,
      ) &&
      new Decimal(reported.probabilityLowerBound).eq(
        target.probabilityLowerBound,
      ) &&
      new Decimal(reported.probabilityUpperBound).eq(
        target.probabilityUpperBound,
      ) &&
      optionalDecimalMatches(
        reported.maximumEntryPrice,
        target.maximumEntryPrice,
      ) &&
      optionalDecimalMatches(
        reported.minimumExitPrice,
        target.minimumExitPrice,
      ) &&
      reported.confidence === target.confidence
    );
  });
}

function proposalAdvisory(
  proposal: AgentDecision["proposals"][number],
): PreviousCycleProposalAdvisory {
  const thesis = replayText(proposal.thesis, REPLAY_LIMITS.thesisCharacters);
  const settlementVerification = replayText(
    proposal.settlementVerification,
    REPLAY_LIMITS.settlementVerificationCharacters,
  );
  const invalidationConditions = replayText(
    proposal.invalidationConditions,
    REPLAY_LIMITS.invalidationConditionCharacters,
  );
  const selectedEvidence = proposal.evidence.slice(
    0,
    REPLAY_LIMITS.evidencePerProposal,
  );
  const evidenceReplay = selectedEvidence.map((item) => {
    const title = replayText(item.title, REPLAY_LIMITS.evidenceTitleCharacters);
    const url = replayText(item.url, REPLAY_LIMITS.evidenceUrlCharacters);
    const relevance = replayText(
      item.relevance,
      REPLAY_LIMITS.evidenceRelevanceCharacters,
    );
    return {
      advisory: {
        title: title.value,
        url: url.value,
        ...(item.publishedAt === undefined
          ? {}
          : { publishedAt: item.publishedAt }),
        relevance: relevance.value,
      },
      truncated: title.truncated || url.truncated || relevance.truncated,
    };
  });
  const evidence = evidenceReplay.map((item) => item.advisory);
  return {
    marketSlug: sanitized(proposal.marketSlug),
    side: proposal.side,
    action: proposal.action,
    estimatedProbability: proposal.estimatedProbability.toFixed(),
    ...(proposal.maximumEntryPrice === undefined
      ? {}
      : { maximumEntryPrice: proposal.maximumEntryPrice.toFixed() }),
    ...(proposal.minimumExitPrice === undefined
      ? {}
      : { minimumExitPrice: proposal.minimumExitPrice.toFixed() }),
    maximumRiskUsd: proposal.maximumRiskUsd.toFixed(),
    confidence: proposal.confidence,
    thesis: thesis.value,
    settlementVerification: settlementVerification.value,
    invalidationConditions: invalidationConditions.value,
    evidence,
    replayTruncated:
      thesis.truncated ||
      settlementVerification.truncated ||
      invalidationConditions.truncated ||
      evidenceReplay.some((item) => item.truncated) ||
      proposal.evidence.length > selectedEvidence.length,
  };
}

function portfolioTargetAdvisory(
  target: AgentDecision["portfolioTargets"][number],
): PreviousCyclePortfolioTargetAdvisory {
  const thesis = replayText(target.thesis, REPLAY_LIMITS.thesisCharacters);
  const settlementVerification = replayText(
    target.settlementVerification,
    REPLAY_LIMITS.settlementVerificationCharacters,
  );
  const invalidationConditions = replayText(
    target.invalidationConditions,
    REPLAY_LIMITS.invalidationConditionCharacters,
  );
  const selectedEvidence = target.evidence.slice(
    0,
    REPLAY_LIMITS.evidencePerProposal,
  );
  const evidenceReplay = selectedEvidence.map((item) => {
    const title = replayText(item.title, REPLAY_LIMITS.evidenceTitleCharacters);
    const url = replayText(item.url, REPLAY_LIMITS.evidenceUrlCharacters);
    const relevance = replayText(
      item.relevance,
      REPLAY_LIMITS.evidenceRelevanceCharacters,
    );
    return {
      advisory: {
        title: title.value,
        url: url.value,
        ...(item.publishedAt === undefined
          ? {}
          : { publishedAt: item.publishedAt }),
        relevance: relevance.value,
      },
      truncated: title.truncated || url.truncated || relevance.truncated,
    };
  });
  return {
    marketSlug: sanitized(target.marketSlug),
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
    thesis: thesis.value,
    settlementVerification: settlementVerification.value,
    invalidationConditions: invalidationConditions.value,
    evidence: evidenceReplay.map((item) => item.advisory),
    replayTruncated:
      thesis.truncated ||
      settlementVerification.truncated ||
      invalidationConditions.truncated ||
      evidenceReplay.some((item) => item.truncated) ||
      target.evidence.length > selectedEvidence.length,
  };
}

function buildAdvisory(
  manifest: Manifest,
  decision: AgentDecision,
  report: CycleReport,
): PreviousCycleAdvisory {
  const cycleSummary = replayText(
    decision.cycleSummary,
    REPLAY_LIMITS.cycleSummaryCharacters,
  );
  // Target-mode decisions already carry the complete thesis/evidence. Derived
  // proposals duplicate that prose and can exceed the bounded replay budget.
  const selectedProposals =
    decision.portfolioTargets.length > 0
      ? []
      : decision.proposals.slice(0, REPLAY_LIMITS.proposals);
  const selectedPortfolioTargets = decision.portfolioTargets.slice(
    0,
    REPLAY_LIMITS.proposals,
  );
  const selectedRejections = report.risk.rejected.slice(
    0,
    REPLAY_LIMITS.rejectedProposals,
  );
  const selectedTargetReconciliations = (
    report.agent.targetReconciliations ?? []
  ).slice(0, REPLAY_LIMITS.targetReconciliations);
  const selectedExecutions = report.executions.slice(
    0,
    REPLAY_LIMITS.executions,
  );
  const beforePnl = new Decimal(
    report.accountBefore.activityBreakdown.tradingPnl,
  );
  const afterPnl = new Decimal(
    report.accountAfter.activityBreakdown.tradingPnl,
  );
  return PreviousCycleAdvisorySchema.parse({
    advisoryOnly: true,
    freshExchangeStateRequired: true,
    source: {
      runId: manifest.runId,
      cycleId: manifest.cycleId,
      mode: manifest.mode,
      status: manifest.stage,
      completedAt: manifest.completedAt,
    },
    decision: {
      cycleSummary: cycleSummary.value,
      cycleSummaryTruncated: cycleSummary.truncated,
      proposals: selectedProposals.map(proposalAdvisory),
      proposalsTruncated: decision.proposals.length > selectedProposals.length,
      ...(decision.portfolioTargets.length === 0
        ? {}
        : {
            portfolioTargets: selectedPortfolioTargets.map(
              portfolioTargetAdvisory,
            ),
            portfolioTargetsTruncated:
              decision.portfolioTargets.length >
              selectedPortfolioTargets.length,
          }),
    },
    performance: {
      reportedTradingPnlBeforeUsd: beforePnl.toFixed(),
      reportedTradingPnlAfterUsd: afterPnl.toFixed(),
      reportedTradingPnlChangeUsd: afterPnl.minus(beforePnl).toFixed(),
      acceptedProposalCount: report.risk.accepted.length,
      rejectedProposals: selectedRejections.map((rejection) => {
        const reason = replayText(
          rejection.reason,
          REPLAY_LIMITS.rejectionReasonCharacters,
        );
        return {
          marketSlug: sanitized(rejection.marketSlug),
          code: sanitized(rejection.code),
          reason: reason.value,
        };
      }),
      rejectedProposalsTruncated:
        report.risk.rejected.length > selectedRejections.length,
      ...(report.agent.targetReconciliations === undefined
        ? {}
        : {
            targetReconciliations: selectedTargetReconciliations.map(
              (reconciliation) => ({
                targetIndex: reconciliation.targetIndex,
                marketSlug: sanitized(reconciliation.marketSlug),
                side: reconciliation.side,
                kind: reconciliation.kind,
                reason: sanitized(reconciliation.reason),
                ...(reconciliation.message === undefined
                  ? {}
                  : {
                      message: replayText(
                        reconciliation.message,
                        REPLAY_LIMITS.reconciliationReasonCharacters,
                      ).value,
                    }),
              }),
            ),
            targetReconciliationsTruncated:
              report.agent.targetReconciliations.length >
              selectedTargetReconciliations.length,
          }),
      executions: selectedExecutions.map((execution) => {
        const skippedReason =
          execution.skippedReason === undefined
            ? undefined
            : replayText(
                execution.skippedReason,
                REPLAY_LIMITS.executionReasonCharacters,
              ).value;
        const ambiguousReason =
          execution.ambiguousReason === undefined
            ? undefined
            : replayText(
                execution.ambiguousReason,
                REPLAY_LIMITS.executionReasonCharacters,
              ).value;
        return {
          marketSlug: sanitized(execution.marketSlug),
          side: execution.side,
          action: execution.action,
          quantity: new Decimal(execution.quantity).toFixed(),
          canonicalLimitPrice: new Decimal(
            execution.canonicalLimitPrice,
          ).toFixed(),
          status: sanitized(execution.status),
          filledQuantity: new Decimal(execution.filledQuantity).toFixed(),
          ...(execution.averageFillPrice === undefined
            ? {}
            : {
                averageFillPrice: new Decimal(
                  execution.averageFillPrice,
                ).toFixed(),
              }),
          fees: new Decimal(execution.fees).toFixed(),
          finalState: sanitized(execution.finalState),
          ...(skippedReason === undefined ? {} : { skippedReason }),
          ...(ambiguousReason === undefined ? {} : { ambiguousReason }),
        };
      }),
      executionsTruncated: report.executions.length > selectedExecutions.length,
    },
  });
}

function replayJsonCharacters(value: unknown): number {
  return Array.from(JSON.stringify(value)).length;
}

function snapshotPath(
  rootDirectory: string,
  exchangeId: ExchangeId,
  accountScope: string,
): string {
  return resolve(
    process.cwd(),
    rootDirectory,
    "advisory",
    exchangeId,
    `${accountScope}.json`,
  );
}

async function readBoundedJson(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > MAXIMUM_SNAPSHOT_BYTES) return undefined;
    handle = await open(path, "r");
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function reapplyReplayRedaction(
  advisory: PreviousCycleAdvisory,
): PreviousCycleAdvisory | undefined {
  const redacted = {
    ...advisory,
    decision: {
      ...advisory.decision,
      cycleSummary: sanitized(advisory.decision.cycleSummary),
      proposals: advisory.decision.proposals.map((proposal) => ({
        ...proposal,
        marketSlug: sanitized(proposal.marketSlug),
        thesis: sanitized(proposal.thesis),
        settlementVerification: sanitized(proposal.settlementVerification),
        invalidationConditions: sanitized(proposal.invalidationConditions),
        evidence: proposal.evidence.map((evidence) => ({
          ...evidence,
          title: sanitized(evidence.title),
          url: sanitized(evidence.url),
          relevance: sanitized(evidence.relevance),
        })),
      })),
      ...(advisory.decision.portfolioTargets === undefined
        ? {}
        : {
            portfolioTargets: advisory.decision.portfolioTargets.map(
              (target) => ({
                ...target,
                marketSlug: sanitized(target.marketSlug),
                thesis: sanitized(target.thesis),
                settlementVerification: sanitized(
                  target.settlementVerification,
                ),
                invalidationConditions: sanitized(
                  target.invalidationConditions,
                ),
                evidence: target.evidence.map((evidence) => ({
                  ...evidence,
                  title: sanitized(evidence.title),
                  url: sanitized(evidence.url),
                  relevance: sanitized(evidence.relevance),
                })),
              }),
            ),
          }),
    },
    performance: {
      ...advisory.performance,
      rejectedProposals: advisory.performance.rejectedProposals.map(
        (rejection) => ({
          marketSlug: sanitized(rejection.marketSlug),
          code: sanitized(rejection.code),
          reason: sanitized(rejection.reason),
        }),
      ),
      ...(advisory.performance.targetReconciliations === undefined
        ? {}
        : {
            targetReconciliations:
              advisory.performance.targetReconciliations.map(
                (reconciliation) => ({
                  ...reconciliation,
                  marketSlug: sanitized(reconciliation.marketSlug),
                  reason: sanitized(reconciliation.reason),
                  ...(reconciliation.message === undefined
                    ? {}
                    : { message: sanitized(reconciliation.message) }),
                }),
              ),
          }),
      executions: advisory.performance.executions.map((execution) => ({
        ...execution,
        marketSlug: sanitized(execution.marketSlug),
        status: sanitized(execution.status),
        finalState: sanitized(execution.finalState),
        ...(execution.skippedReason === undefined
          ? {}
          : { skippedReason: sanitized(execution.skippedReason) }),
        ...(execution.ambiguousReason === undefined
          ? {}
          : { ambiguousReason: sanitized(execution.ambiguousReason) }),
      })),
    },
  };
  const parsed = PreviousCycleAdvisorySchema.safeParse(redacted);
  return parsed.success &&
    replayJsonCharacters(parsed.data) <= MAXIMUM_REPLAY_JSON_CHARACTERS
    ? parsed.data
    : undefined;
}

function persistenceFailure(
  reason: CompletedCycleAdvisoryPersistenceFailureReason,
): PersistCompletedCycleAdvisoryResult {
  return { persisted: false, reason };
}

/**
 * Atomically replaces one account's stable, sanitized advisory snapshot after
 * its cycle has reached a completed journal stage. Failures remain non-fatal,
 * but expose only a stable reason code so callers can observe the fault without
 * logging model content, account identifiers, paths, or exception messages.
 */
export async function persistCompletedCycleAdvisoryWithResult(
  input: PersistCompletedCycleAdvisoryInput,
): Promise<PersistCompletedCycleAdvisoryResult> {
  let accountScope: string;
  try {
    accountScope = assertSafeMemoryScope(input.accountScope);
  } catch {
    return persistenceFailure("INVALID_ACCOUNT_SCOPE");
  }
  if (accountScope === UNSCOPED_MEMORY_SCOPE) {
    return persistenceFailure("UNSCOPED_ACCOUNT_SCOPE");
  }

  const manifest = ManifestSchema.safeParse(input.manifest);
  if (!manifest.success) {
    return persistenceFailure("MANIFEST_VALIDATION_FAILED");
  }
  const decision = AgentDecisionSchema.safeParse(input.decision);
  if (!decision.success) {
    return persistenceFailure("DECISION_VALIDATION_FAILED");
  }
  const report = CycleReportSchema.safeParse(input.report);
  if (!report.success) {
    return persistenceFailure("REPORT_VALIDATION_FAILED");
  }
  if (manifest.data.accountScope !== accountScope) {
    return persistenceFailure("ACCOUNT_SCOPE_MISMATCH");
  }
  if (!validManifestChronology(manifest.data)) {
    return persistenceFailure("MANIFEST_CHRONOLOGY_INVALID");
  }
  if (!reportMatchesManifest(report.data, manifest.data)) {
    return persistenceFailure("REPORT_MANIFEST_MISMATCH");
  }
  if (!reportMatchesDecision(report.data, decision.data)) {
    return persistenceFailure("REPORT_DECISION_MISMATCH");
  }

  let advisory: PreviousCycleAdvisory;
  try {
    advisory = buildAdvisory(manifest.data, decision.data, report.data);
  } catch {
    return persistenceFailure("ADVISORY_BUILD_FAILED");
  }
  if (replayJsonCharacters(advisory) > MAXIMUM_REPLAY_JSON_CHARACTERS) {
    return persistenceFailure("REPLAY_SIZE_EXCEEDED");
  }
  const snapshot = AdvisorySnapshotSchema.safeParse({
    schemaVersion: ADVISORY_SCHEMA_VERSION,
    exchangeId: manifest.data.exchangeId,
    accountScope,
    advisory,
  });
  if (!snapshot.success) {
    return persistenceFailure("SNAPSHOT_VALIDATION_FAILED");
  }

  try {
    const path = snapshotPath(
      input.rootDirectory,
      manifest.data.exchangeId,
      accountScope,
    );
    await writeJsonArtifact(
      dirname(path),
      `${accountScope}.json`,
      snapshot.data,
    );
  } catch {
    return persistenceFailure("WRITE_FAILED");
  }
  return { persisted: true };
}

/**
 * Backward-compatible boolean facade. New call sites should use
 * persistCompletedCycleAdvisoryWithResult so failures remain observable.
 */
export async function persistCompletedCycleAdvisory(
  input: PersistCompletedCycleAdvisoryInput,
): Promise<boolean> {
  return (await persistCompletedCycleAdvisoryWithResult(input)).persisted;
}

/** Loads only the exact exchange/account snapshot and never scans other scopes. */
export async function loadPreviousCycleAdvisory(
  input: LoadPreviousCycleAdvisoryInput,
): Promise<PreviousCycleAdvisory | undefined> {
  try {
    if (!ExchangeIdSchema.safeParse(input.exchangeId).success) return undefined;
    const accountScope = assertSafeMemoryScope(input.accountScope);
    if (accountScope === UNSCOPED_MEMORY_SCOPE) return undefined;
    const parsed = AdvisorySnapshotSchema.safeParse(
      await readBoundedJson(
        snapshotPath(input.rootDirectory, input.exchangeId, accountScope),
      ),
    );
    if (
      !parsed.success ||
      parsed.data.exchangeId !== input.exchangeId ||
      parsed.data.accountScope !== accountScope
    ) {
      return undefined;
    }
    return reapplyReplayRedaction(parsed.data.advisory);
  } catch {
    return undefined;
  }
}
