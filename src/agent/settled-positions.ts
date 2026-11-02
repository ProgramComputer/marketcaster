import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  isEffectiveTrade,
  type AccountActivity,
  type ResolutionActivity,
  type TradeActivity,
} from "../domain/activity.js";
import {
  DecimalInputSchema,
  type OutcomeSide,
  type TradeAction,
} from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import {
  readCrossCycleHistory,
  type CrossCycleHistoryEntry,
} from "../reporting/cross-cycle-history.js";
import { readVerifiedOrderResolutions } from "../reporting/journal-recovery.js";
import type {
  CycleReport,
  RestingOrderOutcomeReport,
} from "../reporting/types.js";

export const MAXIMUM_SETTLED_POSITIONS = 200;
/** Each cycle looks up at most this many earlier resting orders. */
export const MAXIMUM_RESTING_ORDER_LOOKUPS = 12;
const MAXIMUM_CYCLE_REPORT_BYTES = 16 * 1024 * 1024;
const FINAL_ORDER_STATES: ReadonlySet<string> = new Set([
  "CLEARED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "BUSTED",
]);

/** The exchange's final view of an order that was still resting when its cycle ended. */
export interface RestingOrderOutcome {
  readonly state: string;
  readonly filledQuantity: Decimal;
  readonly averageFillPrice?: Decimal;
  readonly fees?: Decimal;
  readonly lastTransactAt?: Date;
}

/** One fill recorded by a completed cycle, with the probability that authorized it. */
export interface EntryFill {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly quantity: Decimal;
  readonly averagePrice: Decimal;
  readonly fees: Decimal;
  /** Original cycle completion, or a recovered fill/submission time. */
  readonly enteredAt: Date;
  readonly estimatedProbability?: Decimal;
  readonly authorizationProbability?: Decimal;
  readonly orderId?: string;
  /** Exchange trade IDs of the fills reported with the order's submission. */
  readonly tradeIds?: readonly string[];
  readonly restUntil?: Date;
  /** Completion time of the cycle before the one that placed the order. */
  readonly previousCycleCompletedAt?: Date;
  /** A later cycle's lookup of an order that was still resting. */
  readonly restingOutcome?: RestingOrderOutcome;
}

/** An exchange settlement joined to the engine's own recorded entries. */
export interface SettledPosition {
  readonly marketSlug: string;
  /** Absent when the market was bought on both sides. */
  readonly side?: OutcomeSide;
  readonly firstEnteredAt: Date;
  /** Across all recorded BUY orders, including fills a later lookup confirmed. */
  readonly quantity: Decimal;
  readonly averageEntryPrice: Decimal;
  /** Filled notional plus fees. */
  readonly costUsd: Decimal;
  readonly realizedPnl: Decimal;
  readonly resolvedAt: Date;
  /**
   * The exchange reports zero realized PnL for some settled positions, which
   * does not say whether the position won, so it is not counted as either.
   */
  readonly outcome: "WON" | "LOST" | "UNKNOWN";
  /** From the earliest recorded entry that carried one. */
  readonly estimatedProbability?: Decimal;
  readonly authorizationProbability?: Decimal;
  /** Each recorded BUY order that opened the position, oldest first. */
  readonly entries: readonly SettledPositionEntry[];
}

export interface SettledPositionEntry {
  readonly side: OutcomeSide;
  /** Original cycle completion, or a recovered fill/submission time. */
  readonly enteredAt: Date;
  /** Filled quantity, including fills a later lookup confirmed. */
  readonly quantity: Decimal;
  readonly averagePrice: Decimal;
  readonly estimatedProbability?: Decimal;
  /** The exchange's latest transaction time for a resting order. */
  readonly lastTransactAt?: Date;
  /**
   * The exchange's own fills of this order, oldest first. They cover the
   * whole quantity unless fills after submission could not be told apart.
   */
  readonly fills?: readonly SettledPositionFill[];
}

export interface SettledPositionFill {
  readonly filledAt: Date;
  readonly quantity: Decimal;
  /** Price on the entry's side. */
  readonly price: Decimal;
}

const ExecutionSchema = z
  .object({
    marketSlug: z.string().min(1),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    filledQuantity: DecimalInputSchema,
    averageFillPrice: DecimalInputSchema.optional(),
    fees: DecimalInputSchema,
    intentId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    tradeIds: z.array(z.string().min(1)).max(1_000).optional(),
    restUntil: z.iso.datetime({ offset: true }).optional(),
  })
  .loose();

const PendingExecutionSchema = z
  .object({
    marketSlug: z.string().min(1),
    status: z.literal("WORKING"),
    orderId: z.string().min(1),
  })
  .loose();

const RestingOrderOutcomeSchema = z
  .object({
    orderId: z.string().min(1),
    state: z.string().min(1),
    filledQuantity: DecimalInputSchema,
    averageFillPrice: DecimalInputSchema.optional(),
    fees: DecimalInputSchema.optional(),
    lastTransactAt: z.iso.datetime({ offset: true }).optional(),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .loose();

const AcceptedProposalSchema = z
  .object({
    marketSlug: z.string().min(1),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    estimatedProbability: DecimalInputSchema,
    riskAdjustedProbability: DecimalInputSchema,
  })
  .loose();

/** The run journal's envelope around the completed cycle report. */
const CycleReportArtifactSchema = z
  .object({
    runId: z.string(),
    cycleId: z.string(),
    kind: z.literal("cycle-report"),
    data: z
      .object({
        risk: z.object({ accepted: z.array(z.unknown()).max(1_000) }).loose(),
      })
      .loose(),
  })
  .loose();

interface AcceptedProbabilities {
  readonly estimatedProbability: Decimal;
  readonly authorizationProbability: Decimal;
}

function positionKey(
  marketSlug: string,
  side: OutcomeSide,
  action: TradeAction,
) {
  return `${marketSlug}\u0000${side}\u0000${action}`;
}

/** Reads accepted probabilities from a cycle report inside the report root. */
async function readAcceptedProbabilities(
  rootDirectory: string,
  entry: CrossCycleHistoryEntry,
): Promise<ReadonlyMap<string, AcceptedProbabilities>> {
  const result = new Map<string, AcceptedProbabilities>();
  const root = resolve(process.cwd(), rootDirectory);
  const path = resolve(root, entry.reportPath);
  if (!path.startsWith(root + sep)) return result;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > MAXIMUM_CYCLE_REPORT_BYTES) return result;
    const report = CycleReportArtifactSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    if (
      !report.success ||
      report.data.runId !== entry.runId ||
      report.data.cycleId !== entry.cycleId
    ) {
      return result;
    }
    for (const item of report.data.data.risk.accepted) {
      const accepted = AcceptedProposalSchema.safeParse(item);
      if (!accepted.success) continue;
      const key = positionKey(
        accepted.data.marketSlug,
        accepted.data.side,
        accepted.data.action,
      );
      if (result.has(key)) continue;
      result.set(key, {
        estimatedProbability: accepted.data.estimatedProbability,
        authorizationProbability: accepted.data.riskAdjustedProbability,
      });
    }
  } catch {
    return new Map();
  }
  return result;
}

function chronological(
  entries: readonly CrossCycleHistoryEntry[],
): readonly CrossCycleHistoryEntry[] {
  return entries.toSorted(
    (left, right) =>
      Date.parse(left.completedAt) - Date.parse(right.completedAt),
  );
}

/** The latest recorded lookup of each order. */
function restingOutcomes(
  reports: readonly unknown[],
): ReadonlyMap<string, RestingOrderOutcome> {
  const latest = new Map<
    string,
    { readonly observedAt: number; readonly outcome: RestingOrderOutcome }
  >();
  for (const item of reports) {
    const parsed = RestingOrderOutcomeSchema.safeParse(item);
    if (!parsed.success) continue;
    const observedAt = Date.parse(parsed.data.observedAt);
    const prior = latest.get(parsed.data.orderId);
    if (prior !== undefined && prior.observedAt >= observedAt) continue;
    latest.set(parsed.data.orderId, {
      observedAt,
      outcome: {
        state: parsed.data.state,
        filledQuantity: parsed.data.filledQuantity,
        ...(parsed.data.averageFillPrice === undefined
          ? {}
          : { averageFillPrice: parsed.data.averageFillPrice }),
        ...(parsed.data.fees === undefined ? {} : { fees: parsed.data.fees }),
        ...(parsed.data.lastTransactAt === undefined
          ? {}
          : { lastTransactAt: new Date(parsed.data.lastTransactAt) }),
      },
    });
  }
  return new Map(
    [...latest].map(([orderId, { outcome }]) => [orderId, outcome]),
  );
}

export interface LoadEntryFillsInput {
  readonly rootDirectory: string;
  readonly exchangeId: CycleReport["exchangeId"];
  readonly accountScope: string;
  /** Lookups made by the current cycle, which the history does not hold yet. */
  readonly restingOrderOutcomes?: readonly RestingOrderOutcomeReport[];
  /** Review-only synchronous observer. Observer failures never change history. */
  readonly onDiagnostic?: (event: EntryHistoryDiagnostic) => void;
}

export interface EntryHistoryDiagnostic {
  readonly stage: "ENTRY_HISTORY" | "SETTLEMENT_ATTRIBUTION";
  readonly reason:
    | "HISTORY_UNAVAILABLE"
    | "INVALID_EXECUTION"
    | "ZERO_FILL"
    | "MISSING_FILL_PRICE"
    | "RECOVERY_UNAVAILABLE"
    | "RECOVERY_ISSUE"
    | "DUPLICATE_ENTRY"
    | "CONFLICTING_ENTRY"
    | "ENTRY_INCLUDED"
    | "PROBABILITY_UNAVAILABLE"
    | "NO_RECORDED_BUY_ENTRY"
    | "ENTRY_AFTER_SETTLEMENT"
    | "SELL_IS_NOT_ENTRY"
    | "SETTLEMENT_INCLUDED";
  readonly source?: "CYCLE_EXECUTION" | "VERIFIED_ORDER_RESOLUTION";
  readonly runId?: string;
  readonly cycleId?: string;
  readonly attemptId?: string;
  readonly marketSlug?: string;
  readonly side?: OutcomeSide;
  readonly action?: TradeAction;
  readonly orderId?: string;
  readonly tradeIds?: readonly string[];
  readonly enteredAt?: string;
  readonly quantity?: string;
  readonly probabilitySource?:
    "ORIGINAL_CYCLE_REPORT" | "ORIGINAL_DURABLE_INTENT" | "UNAVAILABLE";
  readonly recoveryIssue?: string;
}

function diagnose(
  observer: LoadEntryFillsInput["onDiagnostic"],
  event: EntryHistoryDiagnostic,
): void {
  try {
    if (observer !== undefined) {
      // Copy the only nested value so an observer cannot mutate an entry's IDs.
      void Promise.resolve(
        observer({
          ...event,
          ...(event.tradeIds === undefined
            ? {}
            : { tradeIds: [...event.tradeIds] }),
        }),
      ).catch(() => undefined);
    }
  } catch {
    /* Review-only observers cannot affect the result. */
  }
}

interface AttributedFill {
  readonly fill: EntryFill;
  readonly runId: string;
  readonly cycleId: string;
  readonly intentId?: string;
  readonly diagnostic: EntryHistoryDiagnostic;
}

function sameFill(left: EntryFill, right: EntryFill): boolean {
  return (
    left.marketSlug === right.marketSlug &&
    left.side === right.side &&
    left.action === right.action &&
    left.quantity.eq(right.quantity) &&
    left.averagePrice.eq(right.averagePrice) &&
    left.fees.eq(right.fees)
  );
}

function addEntry(
  entries: AttributedFill[],
  candidate: AttributedFill,
  observer: LoadEntryFillsInput["onDiagnostic"],
): void {
  const ids = new Set(candidate.fill.tradeIds ?? []);
  const duplicate = entries.find(
    (existing) =>
      (candidate.fill.orderId !== undefined &&
        existing.fill.orderId === candidate.fill.orderId) ||
      existing.fill.tradeIds?.some((id) => ids.has(id)) === true ||
      (candidate.intentId !== undefined &&
        existing.runId === candidate.runId &&
        existing.cycleId === candidate.cycleId &&
        existing.intentId === candidate.intentId),
  );
  if (duplicate !== undefined) {
    diagnose(observer, {
      ...candidate.diagnostic,
      reason: sameFill(duplicate.fill, candidate.fill)
        ? "DUPLICATE_ENTRY"
        : "CONFLICTING_ENTRY",
    });
    return;
  }
  entries.push(candidate);
  diagnose(observer, { ...candidate.diagnostic, reason: "ENTRY_INCLUDED" });
  if (candidate.fill.estimatedProbability === undefined) {
    diagnose(observer, {
      ...candidate.diagnostic,
      reason: "PROBABILITY_UNAVAILABLE",
    });
  }
}

/**
 * Collects ordinary history entries and verified later resolutions of original
 * attempts. Probabilities come only from the original report or durable intent.
 * Unreadable history or proofs yield fewer fills, never a failure.
 */
export async function loadEntryFills(
  input: LoadEntryFillsInput,
): Promise<readonly EntryFill[]> {
  const history = await readCrossCycleHistory(input);
  if (history === undefined)
    diagnose(input.onDiagnostic, {
      stage: "ENTRY_HISTORY",
      reason: "HISTORY_UNAVAILABLE",
    });
  const outcomes = restingOutcomes([
    ...(history?.entries ?? []).flatMap(
      (entry) => entry.restingOrderOutcomes ?? [],
    ),
    ...(input.restingOrderOutcomes ?? []),
  ]);
  const ordered = chronological(history?.entries ?? []);
  const previousCompletion = new Map(
    ordered.map((entry, index) => [entry, ordered[index - 1]?.completedAt]),
  );
  const entries: AttributedFill[] = [];
  for (const entry of history?.entries ?? []) {
    const priorCompletedAt = previousCompletion.get(entry);
    const priorCycle =
      priorCompletedAt === undefined ? undefined : new Date(priorCompletedAt);
    const executions = entry.currentCycleExecutions.flatMap((item) => {
      const execution = ExecutionSchema.safeParse(item);
      const diagnostic = {
        stage: "ENTRY_HISTORY" as const,
        source: "CYCLE_EXECUTION" as const,
        runId: entry.runId,
        cycleId: entry.cycleId,
      };
      if (!execution.success) {
        diagnose(input.onDiagnostic, {
          ...diagnostic,
          reason: "INVALID_EXECUTION",
        });
        return [];
      }
      const { averageFillPrice, filledQuantity } = execution.data;
      if (!filledQuantity.gt(0) || averageFillPrice === undefined) {
        diagnose(input.onDiagnostic, {
          ...diagnostic,
          marketSlug: execution.data.marketSlug,
          reason: filledQuantity.eq(0)
            ? "ZERO_FILL"
            : averageFillPrice === undefined
              ? "MISSING_FILL_PRICE"
              : "INVALID_EXECUTION",
        });
      }
      return filledQuantity.gt(0) && averageFillPrice !== undefined
        ? [{ ...execution.data, averageFillPrice }]
        : [];
    });
    if (executions.length === 0) continue;
    const probabilities = await readAcceptedProbabilities(
      input.rootDirectory,
      entry,
    );
    const enteredAt = new Date(entry.completedAt);
    for (const execution of executions) {
      const accepted = probabilities.get(
        positionKey(execution.marketSlug, execution.side, execution.action),
      );
      const outcome =
        execution.orderId === undefined
          ? undefined
          : outcomes.get(execution.orderId);
      const fill: EntryFill = {
        marketSlug: execution.marketSlug,
        side: execution.side,
        action: execution.action,
        quantity: execution.filledQuantity,
        averagePrice: execution.averageFillPrice,
        fees: execution.fees,
        enteredAt,
        ...(accepted === undefined
          ? {}
          : {
              estimatedProbability: accepted.estimatedProbability,
              authorizationProbability: accepted.authorizationProbability,
            }),
        ...(execution.orderId === undefined
          ? {}
          : { orderId: execution.orderId }),
        ...(execution.tradeIds === undefined
          ? {}
          : { tradeIds: execution.tradeIds }),
        ...(execution.restUntil === undefined
          ? {}
          : { restUntil: new Date(execution.restUntil) }),
        ...(priorCycle === undefined
          ? {}
          : { previousCycleCompletedAt: priorCycle }),
        ...(outcome === undefined ? {} : { restingOutcome: outcome }),
      };
      addEntry(
        entries,
        {
          fill,
          runId: entry.runId,
          cycleId: entry.cycleId,
          ...(execution.intentId === undefined
            ? {}
            : { intentId: execution.intentId }),
          diagnostic: {
            stage: "ENTRY_HISTORY",
            reason: "ENTRY_INCLUDED",
            source: "CYCLE_EXECUTION",
            runId: entry.runId,
            cycleId: entry.cycleId,
            marketSlug: fill.marketSlug,
            side: fill.side,
            action: fill.action,
            enteredAt: fill.enteredAt.toISOString(),
            quantity: fill.quantity.toFixed(),
            ...(fill.orderId === undefined ? {} : { orderId: fill.orderId }),
            ...(fill.tradeIds === undefined ? {} : { tradeIds: fill.tradeIds }),
            probabilitySource:
              accepted === undefined ? "UNAVAILABLE" : "ORIGINAL_CYCLE_REPORT",
          },
        },
        input.onDiagnostic,
      );
    }
  }
  try {
    const recovery = await readVerifiedOrderResolutions(input);
    for (const issue of recovery.issues) {
      diagnose(input.onDiagnostic, {
        stage: "ENTRY_HISTORY",
        reason: "RECOVERY_ISSUE",
        source: "VERIFIED_ORDER_RESOLUTION",
        runId: issue.runId,
        cycleId: issue.cycleId,
        recoveryIssue: issue.reason,
        ...(issue.attemptId === undefined
          ? {}
          : { attemptId: issue.attemptId }),
      });
    }
    for (const recovered of recovery.resolutions) {
      const enteredAt = new Date(
        recovered.firstFilledAt ?? recovered.submittedAt,
      );
      const diagnostic: EntryHistoryDiagnostic = {
        stage: "ENTRY_HISTORY",
        reason: "ENTRY_INCLUDED",
        source: "VERIFIED_ORDER_RESOLUTION",
        runId: recovered.runId,
        cycleId: recovered.cycleId,
        attemptId: recovered.attemptId,
        marketSlug: recovered.marketSlug,
        side: recovered.side,
        action: recovered.action,
        enteredAt: enteredAt.toISOString(),
        quantity: recovered.filledQuantity.toFixed(),
        ...(recovered.orderId === undefined
          ? {}
          : { orderId: recovered.orderId }),
        ...(recovered.tradeIds === undefined
          ? {}
          : { tradeIds: recovered.tradeIds }),
        probabilitySource:
          recovered.estimatedProbability === undefined
            ? "UNAVAILABLE"
            : "ORIGINAL_DURABLE_INTENT",
      };
      if (
        !recovered.filledQuantity.gt(0) ||
        recovered.averageFillPrice === undefined
      ) {
        diagnose(input.onDiagnostic, {
          ...diagnostic,
          reason: recovered.filledQuantity.eq(0)
            ? "ZERO_FILL"
            : "MISSING_FILL_PRICE",
        });
        continue;
      }
      // Without an exchange/intent identity, an existing entry in the original
      // cycle could already cover this attempt. Do not risk counting it twice.
      if (
        recovered.orderId === undefined &&
        (recovered.tradeIds?.length ?? 0) === 0 &&
        recovered.intentId === undefined &&
        entries.some(
          (entry) =>
            entry.runId === recovered.runId &&
            entry.cycleId === recovered.cycleId &&
            entry.fill.marketSlug === recovered.marketSlug &&
            entry.fill.side === recovered.side &&
            entry.fill.action === recovered.action,
        )
      ) {
        diagnose(input.onDiagnostic, {
          ...diagnostic,
          reason: "CONFLICTING_ENTRY",
        });
        continue;
      }
      const prior = ordered
        .filter(
          (entry) =>
            Date.parse(entry.completedAt) < Date.parse(recovered.submittedAt),
        )
        .at(-1);
      const fill: EntryFill = {
        marketSlug: recovered.marketSlug,
        side: recovered.side,
        action: recovered.action,
        quantity: recovered.filledQuantity,
        averagePrice: recovered.averageFillPrice,
        fees: recovered.fees,
        enteredAt,
        ...(recovered.estimatedProbability === undefined
          ? {}
          : { estimatedProbability: recovered.estimatedProbability }),
        ...(recovered.authorizationProbability === undefined
          ? {}
          : { authorizationProbability: recovered.authorizationProbability }),
        ...(recovered.orderId === undefined
          ? {}
          : { orderId: recovered.orderId }),
        ...(recovered.tradeIds === undefined
          ? {}
          : { tradeIds: recovered.tradeIds }),
        ...(prior === undefined
          ? {}
          : { previousCycleCompletedAt: new Date(prior.completedAt) }),
      };
      addEntry(
        entries,
        {
          fill,
          runId: recovered.runId,
          cycleId: recovered.cycleId,
          diagnostic,
          ...(recovered.intentId === undefined
            ? {}
            : { intentId: recovered.intentId }),
        },
        input.onDiagnostic,
      );
    }
  } catch {
    diagnose(input.onDiagnostic, {
      stage: "ENTRY_HISTORY",
      reason: "RECOVERY_UNAVAILABLE",
    });
  }
  return entries.map((entry) => entry.fill);
}

export interface LookUpRestingOrdersInput {
  readonly rootDirectory: string;
  readonly exchangeId: CycleReport["exchangeId"];
  readonly accountScope: string;
  readonly exchange: Pick<PredictionExchange, "getOrder">;
  /** The oldest activity in the account snapshot; older orders cannot be joined to fills. */
  readonly since: Date;
  readonly observedAt: Date;
}

/**
 * Looks up, once each, orders that earlier cycles left resting and returns
 * their final states for this cycle's report. An order that is still active
 * or cannot be read is left for a later cycle.
 */
export async function lookUpRestingOrders(
  input: LookUpRestingOrdersInput,
): Promise<readonly RestingOrderOutcomeReport[]> {
  const history = await readCrossCycleHistory(input);
  if (history === undefined) return [];
  const entries = chronological(history.entries);
  const known = restingOutcomes(
    entries.flatMap((entry) => entry.restingOrderOutcomes ?? []),
  );
  const pending = new Map<string, string>();
  for (const entry of entries) {
    if (Date.parse(entry.completedAt) < input.since.getTime()) continue;
    for (const item of entry.currentCycleExecutions) {
      const execution = PendingExecutionSchema.safeParse(item);
      if (!execution.success || known.has(execution.data.orderId)) continue;
      pending.set(execution.data.orderId, execution.data.marketSlug);
    }
  }
  const outcomes: RestingOrderOutcomeReport[] = [];
  for (const [orderId, marketSlug] of [...pending].slice(
    0,
    MAXIMUM_RESTING_ORDER_LOOKUPS,
  )) {
    try {
      const order = await input.exchange.getOrder(orderId);
      if (!FINAL_ORDER_STATES.has(order.state)) continue;
      outcomes.push({
        orderId,
        marketSlug,
        state: order.state,
        filledQuantity: order.filledQuantity.toFixed(),
        ...(order.averageFillPrice === undefined
          ? {}
          : { averageFillPrice: order.averageFillPrice.toFixed() }),
        ...(order.fees === undefined ? {} : { fees: order.fees.toFixed() }),
        ...(order.lastTransactAt === undefined
          ? {}
          : { lastTransactAt: order.lastTransactAt.toISOString() }),
        observedAt: input.observedAt.toISOString(),
      });
    } catch {
      continue;
    }
  }
  return outcomes;
}

/** The fill's price on `side`; adapters report the YES price for a fill without a side. */
function priceOnSide(
  trade: TradeActivity,
  side: OutcomeSide,
): Decimal | undefined {
  if (trade.side !== undefined) {
    return trade.side === side ? trade.price : undefined;
  }
  const yesPrice = trade.yesPrice ?? trade.price;
  return side === "YES" ? yesPrice : new Decimal(1).minus(yesPrice);
}

function totalQuantity(trades: readonly TradeActivity[]): Decimal {
  return Decimal.sum(0, ...trades.map((trade) => trade.quantity));
}

/**
 * The exchange fills of one recorded order. Fills that carry the order ID are
 * exact. Otherwise the order's fills are those in its time window that add up
 * to its total: the exchange's final view of a resting order, else the
 * recorded fill. When the window also holds other fills, the set starts at
 * the order's submission, from the recorded trade IDs or else from a burst of
 * taking fills, and is used only if it then adds up.
 */
function orderFills(
  entry: EntryFill,
  trades: readonly TradeActivity[],
  claimed: ReadonlySet<string>,
): readonly TradeActivity[] {
  const priced = trades.filter(
    (trade) =>
      !claimed.has(trade.tradeId) &&
      priceOnSide(trade, entry.side) !== undefined,
  );
  if (
    entry.orderId !== undefined &&
    priced.some((trade) => trade.orderId != null)
  ) {
    return priced.filter((trade) => trade.orderId === entry.orderId);
  }
  const after = entry.previousCycleCompletedAt?.getTime() ?? -Infinity;
  const outcome = entry.restingOutcome;
  const until = Math.max(
    entry.enteredAt.getTime(),
    outcome?.lastTransactAt?.getTime() ?? entry.restUntil?.getTime() ?? 0,
  );
  const window = priced
    .filter(
      (trade) =>
        trade.createdAt.getTime() > after && trade.createdAt.getTime() <= until,
    )
    .toSorted(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  const target = outcome?.filledQuantity ?? entry.quantity;
  if (totalQuantity(window).eq(target)) return window;
  const tradeIds = new Set(entry.tradeIds ?? []);
  const submitted = priced.filter((trade) => tradeIds.has(trade.tradeId));
  const starts =
    submitted.length > 0
      ? [Math.min(...submitted.map((trade) => trade.createdAt.getTime()))]
      : [
          ...new Set(
            window
              .filter((trade) => trade.aggressor)
              .map((trade) => trade.createdAt.getTime()),
          ),
        ].toSorted((left, right) => right - left);
  for (const start of starts) {
    const fromStart = window.filter(
      (trade) =>
        trade.createdAt.getTime() >= start || tradeIds.has(trade.tradeId),
    );
    if (totalQuantity(fromStart).eq(target)) return fromStart;
  }
  return submitted;
}

/**
 * Joins each settled market to the recorded BUY orders that opened it and to
 * the exchange's own fills of those orders. Sells are not entries, and a
 * market bought on both sides has no single side.
 */
export function summarizeSettledPositions(
  activities: readonly AccountActivity[],
  fills: readonly EntryFill[],
  onDiagnostic?: (event: EntryHistoryDiagnostic) => void,
): readonly SettledPosition[] {
  const settlements = new Map<string, ResolutionActivity>();
  for (const activity of activities) {
    if (activity.kind !== "RESOLUTION") continue;
    const prior = settlements.get(activity.marketSlug);
    if (
      prior === undefined ||
      activity.resolvedAt.getTime() > prior.resolvedAt.getTime()
    ) {
      settlements.set(activity.marketSlug, activity);
    }
  }
  const positions: SettledPosition[] = [];
  for (const settlement of settlements.values()) {
    for (const fill of fills.filter(
      (item) => item.marketSlug === settlement.marketSlug,
    )) {
      if (
        fill.action === "SELL" ||
        fill.enteredAt.getTime() > settlement.resolvedAt.getTime()
      ) {
        diagnose(onDiagnostic, {
          stage: "SETTLEMENT_ATTRIBUTION",
          reason:
            fill.action === "SELL"
              ? "SELL_IS_NOT_ENTRY"
              : "ENTRY_AFTER_SETTLEMENT",
          marketSlug: fill.marketSlug,
          side: fill.side,
          action: fill.action,
          enteredAt: fill.enteredAt.toISOString(),
        });
      }
    }
    const buys = fills
      .filter(
        (fill) =>
          fill.marketSlug === settlement.marketSlug &&
          fill.action === "BUY" &&
          fill.enteredAt.getTime() <= settlement.resolvedAt.getTime(),
      )
      .toSorted(
        (left, right) => left.enteredAt.getTime() - right.enteredAt.getTime(),
      );
    const first = buys[0];
    if (first === undefined) {
      diagnose(onDiagnostic, {
        stage: "SETTLEMENT_ATTRIBUTION",
        reason: "NO_RECORDED_BUY_ENTRY",
        marketSlug: settlement.marketSlug,
      });
      continue;
    }
    const trades = activities.filter(
      (activity): activity is TradeActivity =>
        isEffectiveTrade(activity) &&
        activity.marketSlug === settlement.marketSlug &&
        activity.action !== "SELL" &&
        activity.realizedPnl === undefined &&
        activity.createdAt.getTime() <= settlement.resolvedAt.getTime(),
    );
    const claimed = new Set<string>();
    const entries = buys.map((buy): SettledPositionEntry => {
      const matched = orderFills(buy, trades, claimed);
      for (const trade of matched) claimed.add(trade.tradeId);
      const outcome = buy.restingOutcome;
      const matchedQuantity = totalQuantity(matched);
      const quantity = Decimal.max(
        buy.quantity,
        outcome?.filledQuantity ?? 0,
        matchedQuantity,
      );
      const averagePrice = matchedQuantity.eq(quantity)
        ? Decimal.sum(
            ...matched.map((trade) =>
              trade.quantity.mul(priceOnSide(trade, buy.side) ?? trade.price),
            ),
          ).div(quantity)
        : quantity.gt(buy.quantity)
          ? (outcome?.averageFillPrice ?? buy.averagePrice)
          : buy.averagePrice;
      return {
        side: buy.side,
        enteredAt: buy.enteredAt,
        quantity,
        averagePrice,
        ...(buy.estimatedProbability === undefined
          ? {}
          : { estimatedProbability: buy.estimatedProbability }),
        ...(outcome?.lastTransactAt === undefined
          ? {}
          : { lastTransactAt: outcome.lastTransactAt }),
        ...(matched.length === 0
          ? {}
          : {
              fills: matched.map((trade) => ({
                filledAt: trade.createdAt,
                quantity: trade.quantity,
                price: priceOnSide(trade, buy.side) ?? trade.price,
              })),
            }),
      };
    });
    const quantity = Decimal.sum(...entries.map((entry) => entry.quantity));
    const notional = Decimal.sum(
      ...entries.map((entry) => entry.quantity.mul(entry.averagePrice)),
    );
    const fees = Decimal.sum(
      ...buys.map((buy) => buy.restingOutcome?.fees ?? buy.fees),
    );
    const forecast = buys.find(
      (fill) => fill.estimatedProbability !== undefined,
    );
    const pnl = settlement.realizedPnl;
    positions.push({
      marketSlug: settlement.marketSlug,
      ...(buys.every((buy) => buy.side === first.side)
        ? { side: first.side }
        : {}),
      firstEnteredAt: first.enteredAt,
      quantity,
      averageEntryPrice: notional.div(quantity),
      costUsd: notional.plus(fees),
      realizedPnl: pnl,
      resolvedAt: settlement.resolvedAt,
      outcome: pnl.gt(0) ? "WON" : pnl.lt(0) ? "LOST" : "UNKNOWN",
      ...(forecast?.estimatedProbability === undefined
        ? {}
        : { estimatedProbability: forecast.estimatedProbability }),
      ...(forecast?.authorizationProbability === undefined
        ? {}
        : { authorizationProbability: forecast.authorizationProbability }),
      entries,
    });
    diagnose(onDiagnostic, {
      stage: "SETTLEMENT_ATTRIBUTION",
      reason: "SETTLEMENT_INCLUDED",
      marketSlug: settlement.marketSlug,
      enteredAt: first.enteredAt.toISOString(),
      quantity: quantity.toFixed(),
      ...(forecast === undefined
        ? { probabilitySource: "UNAVAILABLE" as const }
        : {}),
    });
  }
  return positions
    .toSorted(
      (left, right) => right.resolvedAt.getTime() - left.resolvedAt.getTime(),
    )
    .slice(0, MAXIMUM_SETTLED_POSITIONS);
}
