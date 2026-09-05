import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Decimal } from "decimal.js";
import pLimit from "p-limit";
import { z } from "zod";
import type {
  AgentDecision,
  DecisionEvidence,
} from "../agent/decision-schema.js";
import type { Market, OrderBook, SettlementState } from "../domain/market.js";
import type {
  ExchangeId,
  MarketId,
  OutcomeSide,
  RuntimeMode,
  TradeAction,
} from "../domain/primitives.js";
import {
  ExchangeError,
  type PredictionExchange,
} from "../exchanges/exchange.js";
import { assertSafeMemoryScope } from "../exchanges/memory-scope.js";
import { canonicalBookLevels, walkCanonicalBook } from "../execution/depth.js";
import type { PortfolioTargetReconciliationResult } from "../portfolio/target-reconciliation.js";
import { estimateExchangeTakerFee } from "../risk/edge.js";
import type {
  ProposalValidationResult,
  ValidatedProposal,
} from "../risk/validate.js";
import { writeJsonArtifact } from "./artifact.js";

const SCHEMA_VERSION = 1 as const;
const MAXIMUM_EVENT_BYTES = 128 * 1024;
const MAXIMUM_EVENT_FILES = 20_000;
const MAXIMUM_SETTLEMENT_RULE_CHARACTERS = 12_000;
const ONE_CENT = new Decimal("0.01");
const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const IsoTimestampSchema = z.iso.datetime({ offset: true });
const DecimalStringSchema = z.string().refine((value) => {
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}, "Expected a finite decimal string");
const ProbabilityStringSchema = DecimalStringSchema.refine((value) => {
  const decimal = new Decimal(value);
  return decimal.gte(0) && decimal.lte(1);
}, "Expected a probability string");
const ExchangeIdSchema = z.enum([
  "polymarket-us",
  "polymarket-international",
  "kalshi",
]);
const OutcomeSideSchema = z.enum(["YES", "NO"]);

export type ShadowDecisionAction = "BUY" | "SELL" | "HOLD" | "PASS";
export type ShadowRiskStatus = "ACCEPTED" | "REJECTED" | "NOT_APPLICABLE";

export interface ShadowLedgerCandidate {
  readonly sequence: number;
  readonly origin:
    "PORTFOLIO_TARGET" | "LEGACY_PROPOSAL" | "CANDIDATE_DISPOSITION";
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly decisionAction: ShadowDecisionAction;
  readonly riskStatus: ShadowRiskStatus;
  readonly riskReason?: string;
  readonly estimatedProbability: Decimal;
  readonly probabilityLowerBound: Decimal;
  readonly probabilityUpperBound: Decimal;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly reasonCode?: string;
  readonly decisionText: string;
  readonly settlementVerification?: string;
  readonly maximumEntryPrice?: Decimal;
  readonly minimumExitPrice?: Decimal;
  readonly evidence: readonly DecisionEvidence[];
}

export interface ShadowFillSimulation {
  readonly requestedQuantity: string;
  readonly fillableQuantity: string;
  readonly fullyFillable: boolean;
  readonly principal: string;
  readonly vwap?: string;
  readonly worstPrice?: string;
  readonly estimatedTakerFee?: string;
  readonly feeBasis: "LOCAL_CONSERVATIVE_MODEL";
}

export interface ShadowBookSnapshot {
  readonly observedAt: string;
  readonly observationBasis: "EXCHANGE_TIMESTAMP" | "CLIENT_RECEIPT_TIME";
  readonly status: "TWO_SIDED" | "ONE_SIDED" | "EMPTY" | "CROSSED";
  readonly selectedSideBid?: string;
  readonly selectedSideAsk?: string;
  readonly selectedSideBidQuantity?: string;
  readonly selectedSideAskQuantity?: string;
  readonly selectedSideSpread?: string;
  readonly bidDepthWithinOneCent: string;
  readonly askDepthWithinOneCent: string;
  readonly totalBidDepth: string;
  readonly totalAskDepth: string;
  readonly quoteAgeMilliseconds: number;
  readonly minimumLotBuy: ShadowFillSimulation;
  readonly minimumLotSell: ShadowFillSimulation;
  /** Legacy full-lower-bound edge retained when reading older observations. */
  readonly conservativeBuyEdgePerContract?: string;
  readonly lowerBoundBuyEdgePerContract?: string;
  readonly authorizationBuyProbability?: string;
  readonly authorizationBuyEdgePerContract?: string;
}

export interface ShadowObservation {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: "OBSERVATION";
  readonly observationId: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  readonly decisionRecordedAt: string;
  readonly capturedAt: string;
  readonly captureLatencyMilliseconds: number;
  readonly origin: ShadowLedgerCandidate["origin"];
  readonly decisionAction: ShadowDecisionAction;
  readonly riskStatus: ShadowRiskStatus;
  readonly riskReason?: string;
  readonly reasonCode?: string;
  readonly market: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly eventId?: string;
    readonly eventSlug?: string;
    readonly seriesId?: string;
    readonly seriesSlug?: string;
    readonly category?: string;
    readonly closesAt?: string;
    readonly minimumTradeQuantity: string;
    readonly priceTick: string;
    readonly resolutionSource?: string;
    readonly settlementRules: string;
    readonly settlementRulesTruncated: boolean;
    readonly settlementRulesSha256: string;
  };
  readonly forecast: {
    readonly side: OutcomeSide;
    readonly estimatedProbability: string;
    readonly probabilityLowerBound: string;
    readonly probabilityUpperBound: string;
    readonly uncertaintyBoundWeight?: string;
    readonly buyAuthorizationProbability?: string;
    readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  };
  readonly decision: {
    readonly text: string;
    readonly settlementVerification?: string;
    readonly maximumEntryPrice?: string;
    readonly minimumExitPrice?: string;
  };
  readonly evidence: readonly {
    readonly url: string;
    readonly evidenceClass?: "CURRENT_REPORT" | "LIVE_DATA" | "BACKGROUND";
    readonly publishedAt?: string;
    readonly asOf?: string;
  }[];
  readonly latestEvidenceAsOf?: string;
  readonly book?: ShadowBookSnapshot;
  readonly bookCaptureFailure?:
    "ADDITIONAL_READS_DISABLED" | "BOOK_FETCH_FAILED";
}

export interface ShadowSettlementEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: "SETTLEMENT";
  readonly settlementId: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  readonly marketId: string;
  readonly marketSlug: string;
  readonly state: Extract<
    SettlementState,
    "SETTLED_YES" | "SETTLED_NO" | "SETTLED_OTHER" | "VOID"
  >;
  readonly settlementPrice?: string;
  readonly settledAt?: string;
  readonly observedAt: string;
}

export interface ShadowMarkEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: "MARK";
  readonly markId: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  readonly marketId: string;
  readonly marketSlug: string;
  readonly observedAt: string;
  readonly observationBasis: "EXCHANGE_TIMESTAMP" | "CLIENT_RECEIPT_TIME";
  readonly yesBid?: string;
  readonly yesAsk?: string;
}

export interface ShadowLedgerCaptureFailure {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly reason: "MARKET_UNAVAILABLE";
}

export interface ShadowLedgerCaptureResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly prospective: true;
  readonly capturePolicy:
    "ALL_CALIBRATED_DECISIONS" | "AUTHORIZED_ONLY_NO_ADDITIONAL_READS";
  readonly eligibleCandidateCount: number;
  readonly selectedCandidateCount: number;
  readonly excludedByLimitCount: number;
  readonly observations: readonly ShadowObservation[];
  readonly failures: readonly ShadowLedgerCaptureFailure[];
}

export interface ShadowLedgerSummary {
  readonly observationCount: number;
  readonly executableObservationCount: number;
  readonly settledObservationCount: number;
  readonly voidObservationCount: number;
  readonly unresolvedObservationCount: number;
  readonly calibration: {
    readonly sampleCount: number;
    readonly brierScore?: string;
    readonly logLoss?: string;
    readonly intervalCoverageFraction?: string;
  };
  readonly authorizedBuys: {
    readonly observationCount: number;
    readonly resolvedCount: number;
    readonly totalCapital?: string;
    readonly netPnl?: string;
    readonly returnOnCapital?: string;
    readonly totalCapitalDays?: string;
    readonly returnPerCapitalDay?: string;
    readonly openMarkedCount: number;
    readonly openMarkedNetPnl?: string;
  };
  readonly acceptedSells: {
    readonly observationCount: number;
    readonly resolvedCount: number;
    readonly valueAddedVersusHold?: string;
  };
  readonly passedCandidates: {
    readonly observationCount: number;
    readonly resolvedExecutableCount: number;
    readonly profitableCounterfactualCount: number;
    readonly losingCounterfactualCount: number;
    readonly flatCounterfactualCount: number;
    readonly counterfactualBuyPnl?: string;
  };
}

export interface ShadowLedgerCycleReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly prospective: true;
  readonly status: "HEALTHY" | "DEGRADED";
  readonly persistentLedgerPath: string;
  readonly capture: ShadowLedgerCaptureResult;
  readonly reconciliation: {
    readonly loadedObservationCount: number;
    readonly settlementCheckCount: number;
    readonly newlySettledMarketCount: number;
    readonly markCheckCount: number;
    readonly newlyRecordedMarkCount: number;
    readonly errors: readonly {
      readonly marketSlug?: string;
      readonly code:
        | "EVENT_READ_FAILED"
        | "SETTLEMENT_CHECK_FAILED"
        | "MARK_CHECK_FAILED"
        | "PERSISTENCE_FAILED";
    }[];
  };
  readonly cumulative?: ShadowLedgerSummary;
  readonly limitations: readonly string[];
}

const ObservationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal("OBSERVATION"),
    observationId: z.string().regex(SAFE_NAME),
    runId: z.string().regex(SAFE_NAME),
    cycleId: z.string().regex(SAFE_NAME),
    mode: z.enum(["observe", "live"]),
    exchangeId: ExchangeIdSchema,
    accountScope: z.string().min(1).max(128),
    decisionRecordedAt: IsoTimestampSchema,
    capturedAt: IsoTimestampSchema,
    captureLatencyMilliseconds: z.number().int(),
    origin: z.enum([
      "PORTFOLIO_TARGET",
      "LEGACY_PROPOSAL",
      "CANDIDATE_DISPOSITION",
    ]),
    decisionAction: z.enum(["BUY", "SELL", "HOLD", "PASS"]),
    riskStatus: z.enum(["ACCEPTED", "REJECTED", "NOT_APPLICABLE"]),
    riskReason: z.string().max(500).optional(),
    reasonCode: z.string().max(100).optional(),
    market: z
      .object({
        id: z.string().min(1).max(500),
        slug: z.string().min(1).max(500),
        title: z.string().max(2_000),
        eventId: z.string().max(500).optional(),
        eventSlug: z.string().max(500).optional(),
        seriesId: z.string().max(500).optional(),
        seriesSlug: z.string().max(500).optional(),
        category: z.string().max(500).optional(),
        closesAt: IsoTimestampSchema.optional(),
        minimumTradeQuantity: DecimalStringSchema,
        priceTick: DecimalStringSchema,
        resolutionSource: z.string().max(2_000).optional(),
        settlementRules: z.string().max(MAXIMUM_SETTLEMENT_RULE_CHARACTERS),
        settlementRulesTruncated: z.boolean(),
        settlementRulesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    forecast: z
      .object({
        side: OutcomeSideSchema,
        estimatedProbability: ProbabilityStringSchema,
        probabilityLowerBound: ProbabilityStringSchema,
        probabilityUpperBound: ProbabilityStringSchema,
        uncertaintyBoundWeight: ProbabilityStringSchema.optional(),
        buyAuthorizationProbability: ProbabilityStringSchema.optional(),
        confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
      })
      .strict(),
    decision: z
      .object({
        text: z.string().max(4_000),
        settlementVerification: z.string().max(2_000).optional(),
        maximumEntryPrice: ProbabilityStringSchema.optional(),
        minimumExitPrice: ProbabilityStringSchema.optional(),
      })
      .strict(),
    evidence: z.array(
      z
        .object({
          url: z.string().max(4_000),
          evidenceClass: z
            .enum(["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"])
            .optional(),
          publishedAt: z.string().max(200).optional(),
          asOf: z.string().max(200).optional(),
        })
        .strict(),
    ),
    latestEvidenceAsOf: IsoTimestampSchema.optional(),
    book: z
      .object({
        observedAt: IsoTimestampSchema,
        observationBasis: z.enum(["EXCHANGE_TIMESTAMP", "CLIENT_RECEIPT_TIME"]),
        status: z.enum(["TWO_SIDED", "ONE_SIDED", "EMPTY", "CROSSED"]),
        selectedSideBid: ProbabilityStringSchema.optional(),
        selectedSideAsk: ProbabilityStringSchema.optional(),
        selectedSideBidQuantity: DecimalStringSchema.optional(),
        selectedSideAskQuantity: DecimalStringSchema.optional(),
        selectedSideSpread: DecimalStringSchema.optional(),
        bidDepthWithinOneCent: DecimalStringSchema,
        askDepthWithinOneCent: DecimalStringSchema,
        totalBidDepth: DecimalStringSchema,
        totalAskDepth: DecimalStringSchema,
        quoteAgeMilliseconds: z.number().int(),
        minimumLotBuy: z.object({}).loose(),
        minimumLotSell: z.object({}).loose(),
        conservativeBuyEdgePerContract: DecimalStringSchema.optional(),
        lowerBoundBuyEdgePerContract: DecimalStringSchema.optional(),
        authorizationBuyProbability: ProbabilityStringSchema.optional(),
        authorizationBuyEdgePerContract: DecimalStringSchema.optional(),
      })
      .loose()
      .optional(),
    bookCaptureFailure: z
      .enum(["ADDITIONAL_READS_DISABLED", "BOOK_FETCH_FAILED"])
      .optional(),
  })
  .strict();

const SettlementSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal("SETTLEMENT"),
    settlementId: z.string().regex(SAFE_NAME),
    exchangeId: ExchangeIdSchema,
    accountScope: z.string().min(1).max(128),
    marketId: z.string().min(1).max(500),
    marketSlug: z.string().min(1).max(500),
    state: z.enum(["SETTLED_YES", "SETTLED_NO", "SETTLED_OTHER", "VOID"]),
    settlementPrice: ProbabilityStringSchema.optional(),
    settledAt: IsoTimestampSchema.optional(),
    observedAt: IsoTimestampSchema,
  })
  .strict();

const MarkSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal("MARK"),
    markId: z.string().regex(SAFE_NAME),
    runId: z.string().regex(SAFE_NAME),
    cycleId: z.string().regex(SAFE_NAME),
    exchangeId: ExchangeIdSchema,
    accountScope: z.string().min(1).max(128),
    marketId: z.string().min(1).max(500),
    marketSlug: z.string().min(1).max(500),
    observedAt: IsoTimestampSchema,
    observationBasis: z.enum(["EXCHANGE_TIMESTAMP", "CLIENT_RECEIPT_TIME"]),
    yesBid: ProbabilityStringSchema.optional(),
    yesAsk: ProbabilityStringSchema.optional(),
  })
  .strict();

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateKey(
  marketSlug: string,
  side: OutcomeSide,
  action?: TradeAction,
): string {
  return `${marketSlug}\u0000${side}${action === undefined ? "" : `\u0000${action}`}`;
}

function riskStatusFor(
  validation: ProposalValidationResult,
  marketSlug: string,
  side: OutcomeSide,
  action: TradeAction,
): { readonly status: ShadowRiskStatus; readonly reason?: string } {
  const accepted = validation.accepted.find(
    (item) =>
      item.proposal.marketSlug === marketSlug &&
      item.proposal.side === side &&
      item.proposal.action === action,
  );
  if (accepted !== undefined) return { status: "ACCEPTED" };
  const rejected = validation.rejected.find(
    (item) =>
      item.proposal.marketSlug === marketSlug &&
      item.proposal.side === side &&
      item.proposal.action === action,
  );
  return rejected === undefined
    ? { status: "NOT_APPLICABLE" }
    : { status: "REJECTED", reason: `${rejected.code}: ${rejected.reason}` };
}

/**
 * Converts the final, deterministically validated decision into one forecast
 * observation per market/side. Targets take precedence over dispositions so a
 * repeated audit row cannot become a second pseudo-trade.
 */
export function buildShadowLedgerCandidates(input: {
  readonly decision: AgentDecision;
  readonly reconciliation?: PortfolioTargetReconciliationResult;
  readonly validation: ProposalValidationResult;
}): readonly ShadowLedgerCandidate[] {
  const candidates: ShadowLedgerCandidate[] = [];
  const seen = new Set<string>();
  let sequence = 0;
  const add = (candidate: Omit<ShadowLedgerCandidate, "sequence">): void => {
    const key = candidateKey(candidate.marketSlug, candidate.side);
    if (seen.has(key)) return;
    seen.add(key);
    sequence += 1;
    candidates.push({ sequence, ...candidate });
  };

  for (const [
    targetIndex,
    target,
  ] of input.decision.portfolioTargets.entries()) {
    const disposition = input.reconciliation?.dispositions.find(
      (item) => item.targetIndex === targetIndex,
    );
    const action =
      disposition?.kind === "PROPOSED" ? disposition.action : undefined;
    const risk =
      action === undefined
        ? { status: "NOT_APPLICABLE" as const }
        : riskStatusFor(
            input.validation,
            target.marketSlug,
            target.side,
            action,
          );
    add({
      origin: "PORTFOLIO_TARGET",
      marketSlug: target.marketSlug,
      side: target.side,
      decisionAction: action ?? "HOLD",
      riskStatus: risk.status,
      ...(risk.reason === undefined ? {} : { riskReason: risk.reason }),
      estimatedProbability: target.estimatedProbability,
      probabilityLowerBound: target.probabilityLowerBound,
      probabilityUpperBound: target.probabilityUpperBound,
      confidence: target.confidence,
      ...(disposition === undefined ? {} : { reasonCode: disposition.reason }),
      decisionText: target.thesis,
      settlementVerification: target.settlementVerification,
      ...(target.maximumEntryPrice === undefined
        ? {}
        : { maximumEntryPrice: target.maximumEntryPrice }),
      ...(target.minimumExitPrice === undefined
        ? {}
        : { minimumExitPrice: target.minimumExitPrice }),
      evidence: target.evidence,
    });
  }

  if (input.decision.portfolioTargets.length === 0) {
    for (const proposal of input.decision.proposals) {
      const risk = riskStatusFor(
        input.validation,
        proposal.marketSlug,
        proposal.side,
        proposal.action,
      );
      add({
        origin: "LEGACY_PROPOSAL",
        marketSlug: proposal.marketSlug,
        side: proposal.side,
        decisionAction: proposal.action,
        riskStatus: risk.status,
        ...(risk.reason === undefined ? {} : { riskReason: risk.reason }),
        estimatedProbability: proposal.estimatedProbability,
        probabilityLowerBound: proposal.estimatedProbability,
        probabilityUpperBound: proposal.estimatedProbability,
        confidence: proposal.confidence,
        decisionText: proposal.thesis,
        settlementVerification: proposal.settlementVerification,
        ...(proposal.maximumEntryPrice === undefined
          ? {}
          : { maximumEntryPrice: proposal.maximumEntryPrice }),
        ...(proposal.minimumExitPrice === undefined
          ? {}
          : { minimumExitPrice: proposal.minimumExitPrice }),
        evidence: proposal.evidence,
      });
    }
  }

  for (const disposition of input.decision.candidateDispositions) {
    if (
      disposition.side === undefined ||
      disposition.side === null ||
      disposition.estimatedProbability === undefined ||
      disposition.estimatedProbability === null ||
      disposition.probabilityLowerBound === undefined ||
      disposition.probabilityLowerBound === null ||
      disposition.probabilityUpperBound === undefined ||
      disposition.probabilityUpperBound === null
    ) {
      continue;
    }
    add({
      origin: "CANDIDATE_DISPOSITION",
      marketSlug: disposition.marketSlug,
      side: disposition.side,
      decisionAction:
        disposition.outcome === "HOLD_UNCHANGED" ? "HOLD" : "PASS",
      riskStatus: "NOT_APPLICABLE",
      estimatedProbability: disposition.estimatedProbability,
      probabilityLowerBound: disposition.probabilityLowerBound,
      probabilityUpperBound: disposition.probabilityUpperBound,
      confidence: "LOW",
      reasonCode: disposition.reasonCode,
      decisionText: disposition.rationale,
      evidence: disposition.evidence,
    });
  }

  return candidates;
}

function validatedProposalMap(
  validation: ProposalValidationResult,
): ReadonlyMap<string, ValidatedProposal> {
  return new Map(
    validation.accepted.map((item) => [
      candidateKey(
        item.proposal.marketSlug,
        item.proposal.side,
        item.proposal.action,
      ),
      item,
    ]),
  );
}

function sortedLevels(
  book: OrderBook,
  side: OutcomeSide,
  action: TradeAction,
): ReturnType<typeof canonicalBookLevels> {
  return canonicalBookLevels(book, side, action).toSorted((left, right) =>
    action === "BUY"
      ? left.price.comparedTo(right.price)
      : right.price.comparedTo(left.price),
  );
}

function depthWithinOneCent(
  levels: ReturnType<typeof canonicalBookLevels>,
  action: TradeAction,
): Decimal {
  const best = levels[0]?.price;
  if (best === undefined) return ZERO;
  return levels.reduce((total, level) => {
    const eligible =
      action === "BUY"
        ? level.price.lte(best.plus(ONE_CENT))
        : level.price.gte(best.minus(ONE_CENT));
    return eligible ? total.plus(level.quantity) : total;
  }, ZERO);
}

function totalDepth(levels: ReturnType<typeof canonicalBookLevels>): Decimal {
  return levels.reduce((total, level) => total.plus(level.quantity), ZERO);
}

function fillSimulation(
  exchangeId: ExchangeId,
  book: OrderBook,
  side: OutcomeSide,
  action: TradeAction,
  quantity: Decimal,
): ShadowFillSimulation {
  const depth = walkCanonicalBook(
    book,
    side,
    action,
    quantity,
    action === "BUY" ? ONE : ZERO,
  );
  const hasFill = depth.fillableQuantity.gt(0);
  const estimatedFee = hasFill
    ? estimateExchangeTakerFee(exchangeId, depth.fillableQuantity, depth.vwap)
    : undefined;
  return {
    requestedQuantity: quantity.toFixed(),
    fillableQuantity: depth.fillableQuantity.toFixed(),
    fullyFillable: depth.fullyFillable,
    principal: depth.principal.toFixed(),
    ...(hasFill
      ? {
          vwap: depth.vwap.toFixed(),
          worstPrice: depth.worstPrice.toFixed(),
        }
      : {}),
    ...(estimatedFee === undefined
      ? {}
      : { estimatedTakerFee: estimatedFee.toFixed() }),
    feeBasis: "LOCAL_CONSERVATIVE_MODEL",
  };
}

function bookSnapshot(
  exchangeId: ExchangeId,
  market: Market,
  side: OutcomeSide,
  estimatedProbability: Decimal,
  probabilityLowerBound: Decimal,
  uncertaintyBoundWeight: Decimal,
  book: OrderBook,
  capturedAt: Date,
): ShadowBookSnapshot {
  const bids = sortedLevels(book, side, "SELL");
  const asks = sortedLevels(book, side, "BUY");
  const bid = bids[0];
  const ask = asks[0];
  const crossed =
    bid !== undefined && ask !== undefined && bid.price.gt(ask.price);
  const status = crossed
    ? ("CROSSED" as const)
    : bid !== undefined && ask !== undefined
      ? ("TWO_SIDED" as const)
      : bid !== undefined || ask !== undefined
        ? ("ONE_SIDED" as const)
        : ("EMPTY" as const);
  const buy = fillSimulation(
    exchangeId,
    book,
    side,
    "BUY",
    market.minimumTradeQuantity,
  );
  const sell = fillSimulation(
    exchangeId,
    book,
    side,
    "SELL",
    market.minimumTradeQuantity,
  );
  const feePerContract =
    buy.vwap === undefined || buy.estimatedTakerFee === undefined
      ? undefined
      : new Decimal(buy.estimatedTakerFee).div(
          new Decimal(buy.fillableQuantity),
        );
  const authorizationBuyProbability = estimatedProbability.plus(
    probabilityLowerBound
      .minus(estimatedProbability)
      .mul(uncertaintyBoundWeight),
  );
  return {
    observedAt: book.observedAt.toISOString(),
    observationBasis: book.observationBasis ?? "CLIENT_RECEIPT_TIME",
    status,
    ...(bid === undefined ? {} : { selectedSideBid: bid.price.toFixed() }),
    ...(ask === undefined ? {} : { selectedSideAsk: ask.price.toFixed() }),
    ...(bid === undefined
      ? {}
      : { selectedSideBidQuantity: bid.quantity.toFixed() }),
    ...(ask === undefined
      ? {}
      : { selectedSideAskQuantity: ask.quantity.toFixed() }),
    ...(bid === undefined || ask === undefined
      ? {}
      : { selectedSideSpread: ask.price.minus(bid.price).toFixed() }),
    bidDepthWithinOneCent: depthWithinOneCent(bids, "SELL").toFixed(),
    askDepthWithinOneCent: depthWithinOneCent(asks, "BUY").toFixed(),
    totalBidDepth: totalDepth(bids).toFixed(),
    totalAskDepth: totalDepth(asks).toFixed(),
    quoteAgeMilliseconds: capturedAt.getTime() - book.observedAt.getTime(),
    minimumLotBuy: buy,
    minimumLotSell: sell,
    ...(buy.vwap === undefined || feePerContract === undefined
      ? {}
      : {
          lowerBoundBuyEdgePerContract: probabilityLowerBound
            .minus(buy.vwap)
            .minus(feePerContract)
            .toFixed(),
          authorizationBuyProbability: authorizationBuyProbability.toFixed(),
          authorizationBuyEdgePerContract: authorizationBuyProbability
            .minus(buy.vwap)
            .minus(feePerContract)
            .toFixed(),
        }),
  };
}

function validEvidenceTimes(evidence: readonly DecisionEvidence[]): Date[] {
  return evidence
    .flatMap((item) => [item.asOf, item.publishedAt])
    .filter((value): value is string => value !== undefined)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));
}

function marketSnapshot(market: Market): ShadowObservation["market"] {
  const truncated =
    market.settlementRules.length > MAXIMUM_SETTLEMENT_RULE_CHARACTERS;
  return {
    id: market.id.value,
    slug: market.slug,
    title: market.title,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    ...(market.category === undefined ? {} : { category: market.category }),
    ...(market.closesAt === undefined
      ? {}
      : { closesAt: market.closesAt.toISOString() }),
    minimumTradeQuantity: market.minimumTradeQuantity.toFixed(),
    priceTick: market.priceTick.toFixed(),
    ...(market.resolutionSource === undefined
      ? {}
      : { resolutionSource: market.resolutionSource }),
    settlementRules: market.settlementRules.slice(
      0,
      MAXIMUM_SETTLEMENT_RULE_CHARACTERS,
    ),
    settlementRulesTruncated: truncated,
    settlementRulesSha256: stableId(market.settlementRules),
  };
}

function candidatePriority(candidate: ShadowLedgerCandidate): number {
  if (candidate.riskStatus === "ACCEPTED") return 0;
  if (candidate.decisionAction === "BUY" || candidate.decisionAction === "SELL")
    return 1;
  if (candidate.decisionAction === "HOLD") return 2;
  return 3;
}

export async function captureShadowLedgerObservations(input: {
  readonly exchange: PredictionExchange;
  readonly accountScope: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly decisionRecordedAt: Date;
  readonly candidates: readonly ShadowLedgerCandidate[];
  readonly validation: ProposalValidationResult;
  readonly knownMarkets: ReadonlyMap<string, Market>;
  readonly maximumObservations: number;
  readonly maximumConcurrentRequests: number;
  readonly uncertaintyBoundWeight: Decimal;
  readonly allowAdditionalReads: boolean;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<ShadowLedgerCaptureResult> {
  const accountScope = assertSafeMemoryScope(input.accountScope);
  const now = input.now ?? (() => new Date());
  const ordered = input.candidates.toSorted(
    (left, right) =>
      candidatePriority(left) - candidatePriority(right) ||
      left.sequence - right.sequence,
  );
  const selected = ordered.slice(0, input.maximumObservations);
  const accepted = validatedProposalMap(input.validation);
  const limit = pLimit(input.maximumConcurrentRequests);
  const captured = await Promise.all(
    selected.map((candidate) =>
      limit(
        async (): Promise<
          | { readonly observation: ShadowObservation }
          | { readonly failure: ShadowLedgerCaptureFailure }
        > => {
          input.signal?.throwIfAborted();
          const validated =
            candidate.decisionAction === "BUY" ||
            candidate.decisionAction === "SELL"
              ? accepted.get(
                  candidateKey(
                    candidate.marketSlug,
                    candidate.side,
                    candidate.decisionAction,
                  ),
                )
              : undefined;
          let market =
            validated?.market ?? input.knownMarkets.get(candidate.marketSlug);
          if (market === undefined && input.allowAdditionalReads) {
            try {
              market = await input.exchange.getMarketBySlug(
                candidate.marketSlug,
              );
            } catch (error) {
              if (input.signal?.aborted === true) throw error;
            }
          }
          if (market === undefined) {
            return {
              failure: {
                marketSlug: candidate.marketSlug,
                side: candidate.side,
                reason: "MARKET_UNAVAILABLE",
              },
            };
          }
          input.signal?.throwIfAborted();
          let book = validated?.book;
          let bookCaptureFailure: ShadowObservation["bookCaptureFailure"];
          if (book === undefined && input.allowAdditionalReads) {
            try {
              book = await input.exchange.getOrderBook(market.id);
            } catch (error) {
              if (input.signal?.aborted === true) throw error;
              bookCaptureFailure = "BOOK_FETCH_FAILED";
            }
          } else if (book === undefined) {
            bookCaptureFailure = "ADDITIONAL_READS_DISABLED";
          }
          const capturedAt = now();
          if (Number.isNaN(capturedAt.getTime())) {
            throw new TypeError("Shadow-ledger capture time is invalid");
          }
          const evidenceTimes = validEvidenceTimes(candidate.evidence);
          const latestEvidence = evidenceTimes.toSorted(
            (left, right) => right.getTime() - left.getTime(),
          )[0];
          const observationId = stableId(
            [
              input.exchange.id,
              accountScope,
              input.runId,
              input.cycleId,
              candidate.sequence,
              candidate.marketSlug,
              candidate.side,
              candidate.origin,
            ].join("|"),
          );
          return {
            observation: {
              schemaVersion: SCHEMA_VERSION,
              kind: "OBSERVATION",
              observationId,
              runId: input.runId,
              cycleId: input.cycleId,
              mode: input.mode,
              exchangeId: input.exchange.id,
              accountScope,
              decisionRecordedAt: input.decisionRecordedAt.toISOString(),
              capturedAt: capturedAt.toISOString(),
              captureLatencyMilliseconds:
                capturedAt.getTime() - input.decisionRecordedAt.getTime(),
              origin: candidate.origin,
              decisionAction: candidate.decisionAction,
              riskStatus: candidate.riskStatus,
              ...(candidate.riskReason === undefined
                ? {}
                : { riskReason: candidate.riskReason.slice(0, 500) }),
              ...(candidate.reasonCode === undefined
                ? {}
                : { reasonCode: candidate.reasonCode.slice(0, 100) }),
              market: marketSnapshot(market),
              forecast: {
                side: candidate.side,
                estimatedProbability: candidate.estimatedProbability.toFixed(),
                probabilityLowerBound:
                  candidate.probabilityLowerBound.toFixed(),
                probabilityUpperBound:
                  candidate.probabilityUpperBound.toFixed(),
                uncertaintyBoundWeight: input.uncertaintyBoundWeight.toFixed(),
                buyAuthorizationProbability: candidate.estimatedProbability
                  .plus(
                    candidate.probabilityLowerBound
                      .minus(candidate.estimatedProbability)
                      .mul(input.uncertaintyBoundWeight),
                  )
                  .toFixed(),
                confidence: candidate.confidence,
              },
              decision: {
                text: candidate.decisionText.slice(0, 4_000),
                ...(candidate.settlementVerification === undefined
                  ? {}
                  : {
                      settlementVerification:
                        candidate.settlementVerification.slice(0, 2_000),
                    }),
                ...(candidate.maximumEntryPrice === undefined
                  ? {}
                  : {
                      maximumEntryPrice: candidate.maximumEntryPrice.toFixed(),
                    }),
                ...(candidate.minimumExitPrice === undefined
                  ? {}
                  : {
                      minimumExitPrice: candidate.minimumExitPrice.toFixed(),
                    }),
              },
              evidence: candidate.evidence.map((item) => ({
                url: item.url.slice(0, 4_000),
                ...(item.evidenceClass === undefined
                  ? {}
                  : { evidenceClass: item.evidenceClass }),
                ...(item.publishedAt === undefined
                  ? {}
                  : { publishedAt: item.publishedAt.slice(0, 200) }),
                ...(item.asOf === undefined
                  ? {}
                  : { asOf: item.asOf.slice(0, 200) }),
              })),
              ...(latestEvidence === undefined
                ? {}
                : { latestEvidenceAsOf: latestEvidence.toISOString() }),
              ...(book === undefined
                ? {}
                : {
                    book: bookSnapshot(
                      input.exchange.id,
                      market,
                      candidate.side,
                      candidate.estimatedProbability,
                      candidate.probabilityLowerBound,
                      input.uncertaintyBoundWeight,
                      book,
                      capturedAt,
                    ),
                  }),
              ...(bookCaptureFailure === undefined
                ? {}
                : { bookCaptureFailure }),
            },
          };
        },
      ),
    ),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    prospective: true,
    capturePolicy: input.allowAdditionalReads
      ? "ALL_CALIBRATED_DECISIONS"
      : "AUTHORIZED_ONLY_NO_ADDITIONAL_READS",
    eligibleCandidateCount: ordered.length,
    selectedCandidateCount: selected.length,
    excludedByLimitCount: Math.max(0, ordered.length - selected.length),
    observations: captured.flatMap((item) =>
      "observation" in item ? [item.observation] : [],
    ),
    failures: captured.flatMap((item) =>
      "failure" in item ? [item.failure] : [],
    ),
  };
}

function terminalSettlementState(
  state: SettlementState,
): state is ShadowSettlementEvent["state"] {
  return ["SETTLED_YES", "SETTLED_NO", "SETTLED_OTHER", "VOID"].includes(state);
}

function marketKey(exchangeId: ExchangeId, marketId: string): string {
  return `${exchangeId}\u0000${marketId}`;
}

function eventFileExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

async function writeImmutableEvent(
  directory: string,
  filename: string,
  value: unknown,
): Promise<boolean> {
  try {
    await writeJsonArtifact(directory, filename, value, { overwrite: false });
    return true;
  } catch (error) {
    if (eventFileExists(error)) return false;
    throw error;
  }
}

async function readEvents(
  directory: string,
  schema: z.ZodType,
): Promise<{
  readonly values: readonly unknown[];
  readonly failureCount: number;
}> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { values: [], failureCount: 0 };
    }
    return { values: [], failureCount: 1 };
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  if (files.length > MAXIMUM_EVENT_FILES) {
    return { values: [], failureCount: 1 };
  }
  let failureCount = 0;
  const values: unknown[] = [];
  for (const filename of files) {
    const path = resolve(directory, filename);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.size > MAXIMUM_EVENT_BYTES) {
        failureCount += 1;
        continue;
      }
      const parsed = schema.safeParse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      if (!parsed.success) {
        failureCount += 1;
        continue;
      }
      values.push(parsed.data);
    } catch {
      failureCount += 1;
    }
  }
  return { values, failureCount };
}

function latestMarksByMarket(
  marks: readonly ShadowMarkEvent[],
): ReadonlyMap<string, ShadowMarkEvent> {
  const latest = new Map<string, ShadowMarkEvent>();
  for (const mark of marks) {
    const key = marketKey(mark.exchangeId, mark.marketId);
    const existing = latest.get(key);
    if (existing === undefined || existing.observedAt < mark.observedAt) {
      latest.set(key, mark);
    }
  }
  return latest;
}

function selectedPayoff(
  settlement: ShadowSettlementEvent,
  side: OutcomeSide,
): Decimal | undefined {
  if (settlement.state === "VOID") return undefined;
  const yesPayoff =
    settlement.settlementPrice !== undefined
      ? new Decimal(settlement.settlementPrice)
      : settlement.state === "SETTLED_YES"
        ? ONE
        : settlement.state === "SETTLED_NO"
          ? ZERO
          : undefined;
  if (yesPayoff === undefined) return undefined;
  return side === "YES" ? yesPayoff : ONE.minus(yesPayoff);
}

function selectedMarkBid(
  mark: ShadowMarkEvent,
  side: OutcomeSide,
): Decimal | undefined {
  if (side === "YES") {
    return mark.yesBid === undefined ? undefined : new Decimal(mark.yesBid);
  }
  return mark.yesAsk === undefined
    ? undefined
    : ONE.minus(new Decimal(mark.yesAsk));
}

function ratio(numerator: Decimal, denominator: Decimal): string | undefined {
  return denominator.isZero()
    ? undefined
    : numerator.div(denominator).toFixed();
}

export function summarizeShadowLedger(
  observations: readonly ShadowObservation[],
  settlements: readonly ShadowSettlementEvent[],
  marks: readonly ShadowMarkEvent[],
): ShadowLedgerSummary {
  const settlementsByMarket = new Map(
    settlements.map((item) => [
      marketKey(item.exchangeId, item.marketId),
      item,
    ]),
  );
  const latestMarks = latestMarksByMarket(marks);
  let executableObservationCount = 0;
  let settledObservationCount = 0;
  let voidObservationCount = 0;
  let brierTotal = ZERO;
  let logLossTotal = ZERO;
  let intervalCovered = 0;
  let calibrationCount = 0;
  let authorizedBuyCount = 0;
  let authorizedBuyResolved = 0;
  let authorizedBuyCapital = ZERO;
  let authorizedBuyPnl = ZERO;
  let authorizedBuyCapitalDays = ZERO;
  let openMarkedCount = 0;
  let openMarkedPnl = ZERO;
  let acceptedSellCount = 0;
  let acceptedSellResolved = 0;
  let acceptedSellValueAdded = ZERO;
  let passCount = 0;
  let passResolvedExecutable = 0;
  let passProfitable = 0;
  let passLosing = 0;
  let passFlat = 0;
  let passCounterfactualPnl = ZERO;

  for (const observation of observations) {
    const buy = observation.book?.minimumLotBuy;
    const executableBuy =
      buy?.fullyFillable === true &&
      buy.vwap !== undefined &&
      buy.estimatedTakerFee !== undefined;
    if (executableBuy) executableObservationCount += 1;
    if (
      observation.decisionAction === "BUY" &&
      observation.riskStatus === "ACCEPTED"
    ) {
      authorizedBuyCount += 1;
    }
    if (
      observation.decisionAction === "SELL" &&
      observation.riskStatus === "ACCEPTED"
    ) {
      acceptedSellCount += 1;
    }
    if (observation.decisionAction === "PASS") passCount += 1;

    const key = marketKey(observation.exchangeId, observation.market.id);
    const settlement = settlementsByMarket.get(key);
    if (settlement?.state === "VOID") {
      voidObservationCount += 1;
      continue;
    }
    const payoff =
      settlement === undefined
        ? undefined
        : selectedPayoff(settlement, observation.forecast.side);
    if (payoff === undefined) {
      if (
        observation.decisionAction === "BUY" &&
        observation.riskStatus === "ACCEPTED" &&
        executableBuy
      ) {
        const mark = latestMarks.get(key);
        const markBid =
          mark === undefined
            ? undefined
            : selectedMarkBid(mark, observation.forecast.side);
        if (markBid !== undefined) {
          const quantity = new Decimal(buy.fillableQuantity);
          const currentPrincipal = quantity.mul(markBid);
          const exitFee = estimateExchangeTakerFee(
            observation.exchangeId,
            quantity,
            markBid,
          );
          const entryCost = new Decimal(buy.principal).plus(
            buy.estimatedTakerFee ?? 0,
          );
          openMarkedCount += 1;
          openMarkedPnl = openMarkedPnl.plus(
            currentPrincipal.minus(exitFee).minus(entryCost),
          );
        }
      }
      continue;
    }

    settledObservationCount += 1;
    calibrationCount += 1;
    const probability = new Decimal(observation.forecast.estimatedProbability);
    brierTotal = brierTotal.plus(probability.minus(payoff).pow(2));
    const clipped = Decimal.max(
      "0.000000000001",
      Decimal.min("0.999999999999", probability),
    ).toNumber();
    const outcome = payoff.toNumber();
    logLossTotal = logLossTotal.plus(
      -(outcome * Math.log(clipped) + (1 - outcome) * Math.log(1 - clipped)),
    );
    const lower = new Decimal(observation.forecast.probabilityLowerBound);
    const upper = new Decimal(observation.forecast.probabilityUpperBound);
    if (payoff.gte(lower) && payoff.lte(upper)) intervalCovered += 1;

    if (executableBuy) {
      const quantity = new Decimal(buy.fillableQuantity);
      const capital = new Decimal(buy.principal).plus(
        buy.estimatedTakerFee ?? 0,
      );
      const pnl = quantity.mul(payoff).minus(capital);
      if (
        observation.decisionAction === "BUY" &&
        observation.riskStatus === "ACCEPTED"
      ) {
        authorizedBuyResolved += 1;
        authorizedBuyCapital = authorizedBuyCapital.plus(capital);
        authorizedBuyPnl = authorizedBuyPnl.plus(pnl);
        const endTime = Date.parse(
          settlement?.settledAt ??
            settlement?.observedAt ??
            observation.capturedAt,
        );
        const days = Math.max(
          1 / 86_400,
          (endTime - Date.parse(observation.capturedAt)) / 86_400_000,
        );
        authorizedBuyCapitalDays = authorizedBuyCapitalDays.plus(
          capital.mul(days),
        );
      }
      if (observation.decisionAction === "PASS") {
        passResolvedExecutable += 1;
        passCounterfactualPnl = passCounterfactualPnl.plus(pnl);
        if (pnl.gt(0)) passProfitable += 1;
        else if (pnl.lt(0)) passLosing += 1;
        else passFlat += 1;
      }
    }

    const sell = observation.book?.minimumLotSell;
    if (
      observation.decisionAction === "SELL" &&
      observation.riskStatus === "ACCEPTED" &&
      sell?.fullyFillable === true &&
      sell.vwap !== undefined &&
      sell.estimatedTakerFee !== undefined
    ) {
      const quantity = new Decimal(sell.fillableQuantity);
      const proceeds = new Decimal(sell.principal).minus(
        sell.estimatedTakerFee,
      );
      acceptedSellResolved += 1;
      acceptedSellValueAdded = acceptedSellValueAdded.plus(
        proceeds.minus(quantity.mul(payoff)),
      );
    }
  }

  const unresolvedObservationCount =
    observations.length - settledObservationCount - voidObservationCount;
  const authorizedBuyReturn = ratio(authorizedBuyPnl, authorizedBuyCapital);
  const authorizedBuyReturnPerCapitalDay = ratio(
    authorizedBuyPnl,
    authorizedBuyCapitalDays,
  );
  return {
    observationCount: observations.length,
    executableObservationCount,
    settledObservationCount,
    voidObservationCount,
    unresolvedObservationCount,
    calibration: {
      sampleCount: calibrationCount,
      ...(calibrationCount === 0
        ? {}
        : {
            brierScore: brierTotal.div(calibrationCount).toFixed(),
            logLoss: logLossTotal.div(calibrationCount).toFixed(),
            intervalCoverageFraction: new Decimal(intervalCovered)
              .div(calibrationCount)
              .toFixed(),
          }),
    },
    authorizedBuys: {
      observationCount: authorizedBuyCount,
      resolvedCount: authorizedBuyResolved,
      ...(authorizedBuyResolved === 0
        ? {}
        : {
            totalCapital: authorizedBuyCapital.toFixed(),
            netPnl: authorizedBuyPnl.toFixed(),
            ...(authorizedBuyReturn === undefined
              ? {}
              : { returnOnCapital: authorizedBuyReturn }),
            totalCapitalDays: authorizedBuyCapitalDays.toFixed(),
            ...(authorizedBuyReturnPerCapitalDay === undefined
              ? {}
              : {
                  returnPerCapitalDay: authorizedBuyReturnPerCapitalDay,
                }),
          }),
      openMarkedCount,
      ...(openMarkedCount === 0
        ? {}
        : { openMarkedNetPnl: openMarkedPnl.toFixed() }),
    },
    acceptedSells: {
      observationCount: acceptedSellCount,
      resolvedCount: acceptedSellResolved,
      ...(acceptedSellResolved === 0
        ? {}
        : { valueAddedVersusHold: acceptedSellValueAdded.toFixed() }),
    },
    passedCandidates: {
      observationCount: passCount,
      resolvedExecutableCount: passResolvedExecutable,
      profitableCounterfactualCount: passProfitable,
      losingCounterfactualCount: passLosing,
      flatCounterfactualCount: passFlat,
      ...(passResolvedExecutable === 0
        ? {}
        : { counterfactualBuyPnl: passCounterfactualPnl.toFixed() }),
    },
  };
}

interface MarketObservationGroup {
  readonly marketId: string;
  readonly marketSlug: string;
  readonly observations: readonly ShadowObservation[];
}

function groupedUnsettledMarkets(
  observations: readonly ShadowObservation[],
  settlements: readonly ShadowSettlementEvent[],
): readonly MarketObservationGroup[] {
  const settled = new Set(
    settlements.map((item) => marketKey(item.exchangeId, item.marketId)),
  );
  const groups = new Map<string, ShadowObservation[]>();
  for (const observation of observations) {
    const key = marketKey(observation.exchangeId, observation.market.id);
    if (settled.has(key)) continue;
    const values = groups.get(key) ?? [];
    values.push(observation);
    groups.set(key, values);
  }
  return [...groups.values()]
    .map((values) => ({
      marketId: values[0]?.market.id ?? "",
      marketSlug: values[0]?.market.slug ?? "",
      observations: values,
    }))
    .filter((group) => group.marketId.length > 0)
    .toSorted((left, right) => {
      const leftClose = left.observations[0]?.market.closesAt ?? "9999";
      const rightClose = right.observations[0]?.market.closesAt ?? "9999";
      return (
        leftClose.localeCompare(rightClose) ||
        (left.observations[0]?.capturedAt ?? "").localeCompare(
          right.observations[0]?.capturedAt ?? "",
        )
      );
    });
}

function yesTopOfBook(book: OrderBook): {
  readonly yesBid?: string;
  readonly yesAsk?: string;
} {
  const bid = book.yesBids.toSorted((left, right) =>
    right.price.comparedTo(left.price),
  )[0];
  const ask = book.yesAsks.toSorted((left, right) =>
    left.price.comparedTo(right.price),
  )[0];
  return {
    ...(bid === undefined ? {} : { yesBid: bid.price.toFixed() }),
    ...(ask === undefined ? {} : { yesAsk: ask.price.toFixed() }),
  };
}

export async function persistAndReconcileShadowLedger(input: {
  readonly rootDirectory: string;
  readonly exchange: PredictionExchange;
  readonly accountScope: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly capture: ShadowLedgerCaptureResult;
  readonly maximumSettlementChecks: number;
  readonly maximumMarkChecks: number;
  readonly maximumConcurrentRequests: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<ShadowLedgerCycleReport> {
  const accountScope = assertSafeMemoryScope(input.accountScope);
  const now = input.now ?? (() => new Date());
  const base = resolve(
    process.cwd(),
    input.rootDirectory,
    "shadow-ledger",
    input.exchange.id,
    accountScope,
  );
  const observationDirectory = resolve(base, "observations");
  const settlementDirectory = resolve(base, "settlements");
  const markDirectory = resolve(base, "marks");
  const errors: ShadowLedgerCycleReport["reconciliation"]["errors"][number][] =
    [];

  for (const observation of input.capture.observations) {
    input.signal?.throwIfAborted();
    try {
      await writeImmutableEvent(
        observationDirectory,
        `${observation.observationId}.json`,
        observation,
      );
    } catch {
      errors.push({
        marketSlug: observation.market.slug,
        code: "PERSISTENCE_FAILED",
      });
    }
  }

  const [rawObservationRead, rawSettlementRead, rawMarkRead] =
    await Promise.all([
      readEvents(observationDirectory, ObservationSchema),
      readEvents(settlementDirectory, SettlementSchema),
      readEvents(markDirectory, MarkSchema),
    ]);
  const observationRead = {
    ...rawObservationRead,
    values: rawObservationRead.values as readonly ShadowObservation[],
  };
  const settlementRead = {
    ...rawSettlementRead,
    values: rawSettlementRead.values as readonly ShadowSettlementEvent[],
  };
  const markRead = {
    ...rawMarkRead,
    values: rawMarkRead.values as readonly ShadowMarkEvent[],
  };
  const readFailureCount =
    observationRead.failureCount +
    settlementRead.failureCount +
    markRead.failureCount;
  for (let index = 0; index < readFailureCount; index += 1) {
    errors.push({ code: "EVENT_READ_FAILED" });
  }

  const groups = groupedUnsettledMarkets(
    observationRead.values,
    settlementRead.values,
  ).slice(0, input.maximumSettlementChecks);
  const limit = pLimit(input.maximumConcurrentRequests);
  const checks = await Promise.all(
    groups.map((group) =>
      limit(async () => {
        input.signal?.throwIfAborted();
        const id: MarketId = {
          exchange: input.exchange.id,
          value: group.marketId,
        };
        try {
          const settlement = await input.exchange.getSettlement(id);
          return { group, settlement } as const;
        } catch (error) {
          if (input.signal?.aborted === true) throw error;
          // Some exchange settlement endpoints represent an unresolved market
          // as a missing settlement record. This is not a failed audit and the
          // market remains eligible for an executable mark.
          if (error instanceof ExchangeError && error.code === "NOT_FOUND") {
            return {
              group,
              settlement: { marketId: id, state: "UNKNOWN" as const },
            } as const;
          }
          errors.push({
            marketSlug: group.marketSlug,
            code: "SETTLEMENT_CHECK_FAILED",
          });
          return { group } as const;
        }
      }),
    ),
  );

  const newSettlements: ShadowSettlementEvent[] = [];
  for (const check of checks) {
    if (
      check.settlement === undefined ||
      !terminalSettlementState(check.settlement.state)
    ) {
      continue;
    }
    const observedAt = now();
    const settlementId = stableId(
      marketKey(input.exchange.id, check.group.marketId),
    );
    const event: ShadowSettlementEvent = {
      schemaVersion: SCHEMA_VERSION,
      kind: "SETTLEMENT",
      settlementId,
      exchangeId: input.exchange.id,
      accountScope,
      marketId: check.group.marketId,
      marketSlug: check.group.marketSlug,
      state: check.settlement.state,
      ...(check.settlement.settlementPrice === undefined
        ? {}
        : { settlementPrice: check.settlement.settlementPrice.toFixed() }),
      ...(check.settlement.settledAt === undefined
        ? {}
        : { settledAt: check.settlement.settledAt.toISOString() }),
      observedAt: observedAt.toISOString(),
    };
    try {
      const written = await writeImmutableEvent(
        settlementDirectory,
        `${settlementId}.json`,
        event,
      );
      if (written) newSettlements.push(event);
    } catch {
      errors.push({
        marketSlug: check.group.marketSlug,
        code: "PERSISTENCE_FAILED",
      });
    }
  }

  const currentCycleObservationIds = new Set(
    input.capture.observations.map((item) => item.observationId),
  );
  const markable = checks
    .filter(
      (check) =>
        check.settlement !== undefined &&
        !terminalSettlementState(check.settlement.state) &&
        check.group.observations.some(
          (item) => !currentCycleObservationIds.has(item.observationId),
        ),
    )
    .slice(0, input.maximumMarkChecks);
  const newMarks = (
    await Promise.all(
      markable.map((check) =>
        limit(async (): Promise<ShadowMarkEvent | undefined> => {
          input.signal?.throwIfAborted();
          try {
            const book = await input.exchange.getOrderBook({
              exchange: input.exchange.id,
              value: check.group.marketId,
            });
            const markId = stableId(
              `${input.runId}|${input.cycleId}|${marketKey(
                input.exchange.id,
                check.group.marketId,
              )}`,
            );
            const event: ShadowMarkEvent = {
              schemaVersion: SCHEMA_VERSION,
              kind: "MARK",
              markId,
              runId: input.runId,
              cycleId: input.cycleId,
              exchangeId: input.exchange.id,
              accountScope,
              marketId: check.group.marketId,
              marketSlug: check.group.marketSlug,
              observedAt: book.observedAt.toISOString(),
              observationBasis: book.observationBasis ?? "CLIENT_RECEIPT_TIME",
              ...yesTopOfBook(book),
            };
            const written = await writeImmutableEvent(
              markDirectory,
              `${markId}.json`,
              event,
            );
            return written ? event : undefined;
          } catch (error) {
            if (input.signal?.aborted === true) throw error;
            errors.push({
              marketSlug: check.group.marketSlug,
              code: "MARK_CHECK_FAILED",
            });
            return undefined;
          }
        }),
      ),
    )
  ).filter((item): item is ShadowMarkEvent => item !== undefined);

  const settlements = [...settlementRead.values, ...newSettlements];
  const marks = [...markRead.values, ...newMarks];
  const cumulative = summarizeShadowLedger(
    observationRead.values,
    settlements,
    marks,
  );
  const updatedAt = now().toISOString();
  try {
    await writeJsonArtifact(
      dirname(resolve(base, "index.json")),
      "index.json",
      {
        schemaVersion: SCHEMA_VERSION,
        prospective: true,
        exchangeId: input.exchange.id,
        accountScope,
        updatedAt,
        eventDirectories: {
          observations: "observations",
          settlements: "settlements",
          marks: "marks",
        },
        summary: cumulative,
      },
    );
  } catch {
    errors.push({ code: "PERSISTENCE_FAILED" });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    prospective: true,
    status: errors.length === 0 ? "HEALTHY" : "DEGRADED",
    persistentLedgerPath: [
      "shadow-ledger",
      input.exchange.id,
      accountScope,
      "index.json",
    ].join("/"),
    capture: input.capture,
    reconciliation: {
      loadedObservationCount: observationRead.values.length,
      settlementCheckCount: checks.length,
      newlySettledMarketCount: newSettlements.length,
      markCheckCount: markable.length,
      newlyRecordedMarkCount: newMarks.length,
      errors,
    },
    cumulative,
    limitations: [
      "The ledger is prospective; historical reports are not backfilled because their quotes were not captured under this protocol.",
      "Minimum-lot fills use the contemporaneous order book and a local conservative taker-fee model; they are shadow observations, not exchange fills.",
      "Passed-candidate counterfactual P&L is reported separately and never counted as strategy profit.",
      "Observation-level outcomes can include repeated forecasts for one market and are not independent samples.",
    ],
  };
}

export function degradedShadowLedgerReport(input: {
  readonly rootDirectory: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  readonly capture: ShadowLedgerCaptureResult;
}): ShadowLedgerCycleReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    prospective: true,
    status: "DEGRADED",
    persistentLedgerPath: [
      "shadow-ledger",
      input.exchangeId,
      input.accountScope,
      "index.json",
    ].join("/"),
    capture: input.capture,
    reconciliation: {
      loadedObservationCount: 0,
      settlementCheckCount: 0,
      newlySettledMarketCount: 0,
      markCheckCount: 0,
      newlyRecordedMarkCount: 0,
      errors: [{ code: "PERSISTENCE_FAILED" }],
    },
    limitations: [
      "This cycle captured an in-run observation artifact, but the persistent cross-cycle shadow ledger could not be updated.",
    ],
  };
}
