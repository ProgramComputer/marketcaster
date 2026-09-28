import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type {
  AccountActivity,
  ResolutionActivity,
} from "../domain/activity.js";
import {
  DecimalInputSchema,
  type OutcomeSide,
  type TradeAction,
} from "../domain/primitives.js";
import {
  readCrossCycleHistory,
  type CrossCycleHistoryEntry,
} from "../reporting/cross-cycle-history.js";
import type { CycleReport } from "../reporting/types.js";

export const MAXIMUM_SETTLED_POSITIONS = 200;
const MAXIMUM_CYCLE_REPORT_BYTES = 16 * 1024 * 1024;

/** One fill recorded by a completed cycle, with the probability that authorized it. */
export interface EntryFill {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly quantity: Decimal;
  readonly averagePrice: Decimal;
  readonly fees: Decimal;
  /** Completion time of the cycle that placed the order. */
  readonly enteredAt: Date;
  readonly estimatedProbability?: Decimal;
  readonly authorizationProbability?: Decimal;
}

/** An exchange settlement joined to the engine's own recorded entries. */
export interface SettledPosition {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly firstEnteredAt: Date;
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
}

const ExecutionSchema = z
  .object({
    marketSlug: z.string().min(1),
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    filledQuantity: DecimalInputSchema,
    averageFillPrice: DecimalInputSchema.optional(),
    fees: DecimalInputSchema,
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

export interface LoadEntryFillsInput {
  readonly rootDirectory: string;
  readonly exchangeId: CycleReport["exchangeId"];
  readonly accountScope: string;
}

/**
 * Collects filled orders from the cross-cycle history. Each entry's own cycle
 * report supplies the probability that authorized the order. Unreadable
 * history or reports yield fewer fills, never a failure.
 */
export async function loadEntryFills(
  input: LoadEntryFillsInput,
): Promise<readonly EntryFill[]> {
  const history = await readCrossCycleHistory(input);
  if (history === undefined) return [];
  const fills: EntryFill[] = [];
  for (const entry of history.entries) {
    const executions = entry.currentCycleExecutions.flatMap((item) => {
      const execution = ExecutionSchema.safeParse(item);
      if (!execution.success) return [];
      const { averageFillPrice, filledQuantity } = execution.data;
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
      fills.push({
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
      });
    }
  }
  return fills;
}

/**
 * Joins each settled market to the BUY fills that opened it. A market with a
 * recorded SELL fill, fills on both sides, or no recorded entry is omitted,
 * because its settlement PnL is not the result of one recorded position.
 */
export function summarizeSettledPositions(
  activities: readonly AccountActivity[],
  fills: readonly EntryFill[],
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
    const entries = fills
      .filter(
        (fill) =>
          fill.marketSlug === settlement.marketSlug &&
          fill.enteredAt.getTime() <= settlement.resolvedAt.getTime(),
      )
      .toSorted(
        (left, right) => left.enteredAt.getTime() - right.enteredAt.getTime(),
      );
    const first = entries[0];
    if (
      first === undefined ||
      entries.some((fill) => fill.action !== "BUY" || fill.side !== first.side)
    ) {
      continue;
    }
    const quantity = Decimal.sum(...entries.map((fill) => fill.quantity));
    const notional = Decimal.sum(
      ...entries.map((fill) => fill.quantity.mul(fill.averagePrice)),
    );
    const forecast = entries.find(
      (fill) => fill.estimatedProbability !== undefined,
    );
    const pnl = settlement.realizedPnl;
    positions.push({
      marketSlug: settlement.marketSlug,
      side: first.side,
      firstEnteredAt: first.enteredAt,
      quantity,
      averageEntryPrice: notional.div(quantity),
      costUsd: notional.plus(Decimal.sum(...entries.map((fill) => fill.fees))),
      realizedPnl: pnl,
      resolvedAt: settlement.resolvedAt,
      outcome: pnl.gt(0) ? "WON" : pnl.lt(0) ? "LOST" : "UNKNOWN",
      ...(forecast?.estimatedProbability === undefined
        ? {}
        : { estimatedProbability: forecast.estimatedProbability }),
      ...(forecast?.authorizationProbability === undefined
        ? {}
        : { authorizationProbability: forecast.authorizationProbability }),
    });
  }
  return positions
    .toSorted(
      (left, right) => right.resolvedAt.getTime() - left.resolvedAt.getTime(),
    )
    .slice(0, MAXIMUM_SETTLED_POSITIONS);
}
