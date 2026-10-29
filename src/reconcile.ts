import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import { parseRuntimeEnvironment } from "./config/env.js";
import { loadRuntimeConfiguration } from "./config/runtime-overrides.js";
import type { TradeActivity } from "./domain/activity.js";
import type { ExchangeId } from "./domain/primitives.js";
import type { PredictionExchange } from "./exchanges/exchange.js";
import { createExchange } from "./exchanges/factory.js";
import { proveImmediateOrderOutcome } from "./execution/order-resolution.js";
import {
  inspectLiveJournalRecovery,
  orderResolutionKind,
} from "./reporting/journal-recovery.js";
import { createLogger } from "./reporting/logger.js";
import { createRunJournal } from "./reporting/run-journal.js";
import { safeErrorMessage } from "./utilities/redaction.js";

/** The account reads a reconciliation needs; it has no order methods. */
export type AccountReader = Pick<
  PredictionExchange,
  "id" | "memoryScope" | "getPositions" | "getOpenOrders" | "getActivities"
>;

export interface ReconcileJournalsInput {
  readonly rootDirectory: string;
  readonly account: AccountReader;
  readonly runId: string;
  readonly cycleId: string;
  readonly now?: () => Date;
}

export interface ReconciliationRefusal {
  readonly runId: string;
  readonly cycleId: string;
  readonly attemptId?: string;
  readonly reason: string;
}

export interface ReconcileJournalsResult {
  readonly resolved: number;
  readonly refusals: readonly ReconciliationRefusal[];
}

interface RecordedAttempt {
  readonly marketSlug: string;
  readonly submittedAt: Date;
}

interface RecordedIntent {
  readonly attemptSequence: number;
  readonly submittedAt: string;
  /** The validated order exactly as recorded, copied into the resolution. */
  readonly order: Record<string, unknown>;
  readonly marketSlug: string;
  readonly executionPolicy: unknown;
  readonly side: unknown;
  readonly action: unknown;
  readonly canonicalLimitPrice: Decimal;
  readonly quantity: Decimal;
  readonly positionsBefore: readonly Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRecordedIntent(path: string): Promise<RecordedIntent> {
  const envelope = JSON.parse(await readFile(path, "utf8")) as unknown;
  const data = isRecord(envelope) ? envelope.data : undefined;
  if (
    !isRecord(data) ||
    typeof data.attemptSequence !== "number" ||
    typeof data.submittedAt !== "string" ||
    !isRecord(data.validated) ||
    !isRecord(data.validated.order) ||
    typeof data.validated.order.marketSlug !== "string" ||
    !Array.isArray(data.positionsBefore)
  ) {
    throw new Error("Order intent is incomplete");
  }
  const order = data.validated.order;
  return {
    attemptSequence: data.attemptSequence,
    submittedAt: data.submittedAt,
    order,
    marketSlug: order.marketSlug as string,
    executionPolicy: order.executionPolicy,
    side: order.side,
    action: order.action,
    canonicalLimitPrice: decimalOf(order.canonicalLimitPrice),
    quantity: decimalOf(order.quantity),
    positionsBefore: data.positionsBefore.filter(isRecord),
  };
}

async function completedAt(manifestPath: string): Promise<Date | undefined> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest.completedAt !== "string") {
    return undefined;
  }
  const value = new Date(manifest.completedAt);
  return Number.isNaN(value.getTime()) ? undefined : value;
}

/** A recorded decimal: a live `Decimal` or its serialized string. */
function decimalOf(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === "string" && value.length > 0) return new Decimal(value);
  throw new Error("Recorded quantity is not a decimal");
}

function sideQuantity(
  positions: readonly {
    marketSlug: unknown;
    side: unknown;
    quantity: unknown;
  }[],
  marketSlug: string,
  side: string,
): Decimal {
  const position = positions.find(
    (candidate) =>
      candidate.marketSlug === marketSlug && candidate.side === side,
  );
  return position === undefined ? new Decimal(0) : decimalOf(position.quantity);
}

/**
 * Proves the outcome of each prior order attempt the journal check cannot
 * resolve and records it in a new observe-only journal. Reads account state
 * only; an attempt that cannot be proven stays unresolved.
 */
export async function reconcileJournals(
  input: ReconcileJournalsInput,
): Promise<ReconcileJournalsResult> {
  const now = input.now ?? (() => new Date());
  const { account } = input;
  const inspection = await inspectLiveJournalRecovery({
    rootDirectory: input.rootDirectory,
    exchangeId: account.id,
  });
  const journal = await createRunJournal({
    rootDirectory: input.rootDirectory,
    runId: input.runId,
    cycleId: input.cycleId,
    mode: "observe",
    exchangeId: account.id,
    accountScope: account.memoryScope,
    now,
  });
  await journal.transition("DECIDED");
  await journal.transition("VALIDATED");
  await journal.transition("RECONCILING");

  const refusals: ReconciliationRefusal[] = [];
  const unresolved = inspection.issues.flatMap((issue) =>
    issue.reason === "UNRESOLVED_ORDER_INTENT" &&
    issue.attemptId !== undefined &&
    issue.intentPath !== undefined
      ? [{ issue, attemptId: issue.attemptId, intentPath: issue.intentPath }]
      : [],
  );
  for (const issue of inspection.issues) {
    if (!unresolved.some((attempt) => attempt.issue === issue)) {
      refusals.push({
        runId: issue.runId,
        cycleId: issue.cycleId,
        ...(issue.attemptId === undefined
          ? {}
          : { attemptId: issue.attemptId }),
        reason: `Journal issue ${issue.reason} is not an unresolved order`,
      });
    }
  }

  let resolved = 0;
  if (refusals.length === 0 && unresolved.length > 0) {
    const attempts: RecordedAttempt[] = [];
    for (const { intentPath } of [
      ...inspection.resolvedAttempts,
      ...unresolved,
    ]) {
      const intent = await readRecordedIntent(intentPath);
      attempts.push({
        marketSlug: intent.marketSlug,
        submittedAt: new Date(intent.submittedAt),
      });
    }
    const [positions, openOrders] = await Promise.all([
      account.getPositions(),
      account.getOpenOrders(),
    ]);
    for (const { issue, attemptId, intentPath } of unresolved) {
      const refuse = (reason: string): void => {
        refusals.push({
          runId: issue.runId,
          cycleId: issue.cycleId,
          attemptId,
          reason,
        });
      };
      const intent = await readRecordedIntent(intentPath);
      const { marketSlug, side, action } = intent;
      const submittedAt = new Date(intent.submittedAt);
      const windowEnd = await completedAt(issue.manifestPath);
      if ((intent.executionPolicy ?? "IOC") !== "IOC") {
        refuse(
          "Only immediate-or-cancel orders can be proven from account state",
        );
        continue;
      }
      if (
        (side !== "YES" && side !== "NO") ||
        (action !== "BUY" && action !== "SELL")
      ) {
        refuse("Order intent has an invalid side or action");
        continue;
      }
      if (windowEnd === undefined || windowEnd < submittedAt) {
        refuse("The order's journal has no completion time");
        continue;
      }
      // A later order in the market would mix its trades into the evidence.
      if (
        attempts.some(
          (attempt) =>
            attempt.marketSlug === marketSlug &&
            attempt.submittedAt > submittedAt,
        )
      ) {
        refuse("A later order attempt traded the same market");
        continue;
      }
      const page = await account.getActivities({
        marketSlug,
        kinds: ["TRADE"],
        createdAfter: new Date(submittedAt.getTime() - 1),
        sortOrder: "ASCENDING",
      });
      if (!page.eof) {
        refuse("The market's trade history is incomplete");
        continue;
      }
      const trades = page.items.filter(
        (activity): activity is TradeActivity =>
          activity.kind === "TRADE" &&
          activity.marketSlug === marketSlug &&
          activity.createdAt >= submittedAt &&
          activity.createdAt <= windowEnd,
      );
      const quantityBefore = sideQuantity(
        intent.positionsBefore as {
          marketSlug: unknown;
          side: unknown;
          quantity: unknown;
        }[],
        marketSlug,
        side,
      );
      const quantityNow = sideQuantity(positions, marketSlug, side);
      const proof = proveImmediateOrderOutcome({
        order: {
          marketSlug,
          side,
          action,
          canonicalLimitPrice: intent.canonicalLimitPrice,
          quantity: intent.quantity,
        },
        quantityBefore,
        quantityNow,
        openOrders,
        trades,
      });
      if (!proof.proven) {
        refuse(proof.reason);
        continue;
      }
      await journal.recordArtifact(
        orderResolutionKind(issue.runId, issue.cycleId, attemptId),
        {
          target: { runId: issue.runId, cycleId: issue.cycleId, attemptId },
          attemptSequence: intent.attemptSequence,
          submittedAt: intent.submittedAt,
          validated: { order: intent.order },
          result: proof.result,
          evidence: {
            observedAt: now().toISOString(),
            window: {
              from: submittedAt.toISOString(),
              to: windowEnd.toISOString(),
            },
            quantityBefore,
            quantityNow,
            openOrderCount: openOrders.length,
            trades: trades.map((trade) => ({
              tradeId: trade.tradeId,
              price: trade.price,
              quantity: trade.quantity,
              state: trade.state,
              aggressor: trade.aggressor,
              createdAt: trade.createdAt.toISOString(),
            })),
          },
        },
        {
          filename: `resolutions/${issue.runId}.${issue.cycleId}.${attemptId}.json`,
        },
      );
      resolved += 1;
    }
  }

  if (refusals.length === 0) {
    await journal.complete("SUCCESS", { resolvedOrderAttempts: resolved });
  } else {
    await journal.fail({ refusals }, { resolvedOrderAttempts: resolved });
  }
  return { resolved, refusals };
}

function safeExchangeId(value: string | undefined): ExchangeId {
  return value === "kalshi" ||
    value === "polymarket-international" ||
    value === "polymarket-us"
    ? value
    : "polymarket-us";
}

export async function main(env = process.env): Promise<number> {
  const runId = env.GITHUB_RUN_ID ?? randomUUID();
  const cycleId = randomUUID();
  const logger = createLogger({
    runId,
    cycleId,
    exchangeId: safeExchangeId(env.EXCHANGE_ID),
    runtimeMode: "observe",
    stage: "journal-reconciliation",
  });
  try {
    const environment = parseRuntimeEnvironment(env);
    const { config } = await loadRuntimeConfiguration(environment);
    const exchange = createExchange(environment, config);
    const account: AccountReader = {
      id: exchange.id,
      memoryScope: exchange.memoryScope,
      getPositions: () => exchange.getPositions(),
      getOpenOrders: () => exchange.getOpenOrders(),
      getActivities: (query) => exchange.getActivities(query),
    };
    const result = await reconcileJournals({
      rootDirectory: config.reporting.directory,
      account,
      runId,
      cycleId,
    });
    logger.info(result, "Journal reconciliation completed");
    return result.refusals.length === 0 ? 0 : 4;
  } catch (error) {
    logger.error(
      { error: safeErrorMessage(error) },
      "Journal reconciliation failed",
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await main();
}
