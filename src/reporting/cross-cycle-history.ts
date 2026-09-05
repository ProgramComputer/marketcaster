import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../exchanges/memory-scope.js";
import { writeJsonArtifact } from "./artifact.js";
import type {
  AccountReport,
  AgentStateReport,
  CycleReport,
  ExecutionReport,
  ObservedAccountActivityView,
  PerformanceComparisonReport,
} from "./types.js";

const HISTORY_SCHEMA_VERSION = 1 as const;
const MAXIMUM_HISTORY_ENTRIES = 100;
const MAXIMUM_HISTORY_BYTES = 8 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const ExchangeIdSchema = z.enum([
  "polymarket-us",
  "polymarket-international",
  "kalshi",
]);
const HistoryEntrySchema = z
  .object({
    runId: z.string().regex(SAFE_NAME),
    cycleId: z.string().regex(SAFE_NAME),
    reportPath: z.string().min(1).max(1_024),
    mode: z.enum(["observe", "live"]),
    status: z.enum(["SUCCESS", "PASS", "AMBIGUOUS", "SAFETY_STOP"]),
    outcome: z.enum([
      "NO_PROPOSAL",
      "ALL_REJECTED",
      "OBSERVE_ONLY",
      "EXECUTION_SKIPPED",
      "NO_FILL",
      "FILLED",
      "ORDER_WORKING",
      "AMBIGUOUS",
      "SAFETY_STOP",
    ]),
    completedAt: z.iso.datetime({ offset: true }),
    account: z.object({}).loose(),
    performanceChange: z.object({}).loose(),
    exchangeObservedActivity: z
      .object({
        after: z.object({}).loose(),
        newlyObserved: z.object({}).loose(),
      })
      .loose(),
    agentState: z.object({}).loose(),
    agentStateChanges: z.object({}).loose(),
    currentCycleExecutions: z.array(z.unknown()),
  })
  .loose();
const HistorySchema = z
  .object({
    schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
    exchangeId: ExchangeIdSchema,
    accountScope: z.string(),
    updatedAt: z.iso.datetime({ offset: true }),
    maximumEntries: z.literal(MAXIMUM_HISTORY_ENTRIES),
    entries: z.array(HistoryEntrySchema).max(MAXIMUM_HISTORY_ENTRIES),
  })
  .strict();

export interface CrossCycleHistoryEntry {
  readonly runId: string;
  readonly cycleId: string;
  readonly reportPath: string;
  readonly mode: CycleReport["mode"];
  readonly status: Exclude<CycleReport["status"], "FAILED">;
  readonly outcome: Exclude<CycleReport["outcome"], "FAILED">;
  readonly completedAt: string;
  readonly account: AccountReport;
  readonly performanceChange: PerformanceComparisonReport;
  readonly exchangeObservedActivity: {
    readonly source: "EXCHANGE_ACCOUNT_SNAPSHOT";
    readonly attribution: "UNATTRIBUTED";
    readonly after: ObservedAccountActivityView;
    readonly newlyObserved: ObservedAccountActivityView;
    readonly exactOrderMatches?: CycleReport["exchangeObservedActivity"]["exactOrderMatches"];
  };
  readonly agentState: AgentStateReport["after"];
  readonly agentStateChanges: AgentStateReport["changes"];
  readonly currentCycleExecutions: readonly ExecutionReport[];
}

export interface CrossCycleHistory {
  readonly schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  readonly exchangeId: CycleReport["exchangeId"];
  readonly accountScope: string;
  readonly updatedAt: string;
  readonly maximumEntries: typeof MAXIMUM_HISTORY_ENTRIES;
  /** Newest completed cycle first. */
  readonly entries: readonly CrossCycleHistoryEntry[];
}

export type CrossCycleHistoryPersistenceFailureReason =
  | "INVALID_ACCOUNT_SCOPE"
  | "UNSCOPED_ACCOUNT_SCOPE"
  | "INVALID_REPORT"
  | "READ_FAILED"
  | "HISTORY_VALIDATION_FAILED"
  | "ENTRY_TOO_LARGE"
  | "WRITE_FAILED";

export type PersistCrossCycleHistoryResult =
  | { readonly persisted: true; readonly entryCount: number }
  | {
      readonly persisted: false;
      readonly reason: CrossCycleHistoryPersistenceFailureReason;
    };

export interface PersistCrossCycleHistoryInput {
  readonly rootDirectory: string;
  readonly accountScope: string;
  readonly report: CycleReport;
}

type HistoryReadResult =
  | { readonly kind: "MISSING" }
  | { readonly kind: "VALUE"; readonly value: unknown }
  | { readonly kind: "FAILED" };

function historyPath(
  rootDirectory: string,
  exchangeId: CycleReport["exchangeId"],
  accountScope: string,
): string {
  return resolve(
    process.cwd(),
    rootDirectory,
    "history",
    exchangeId,
    accountScope,
    "index.json",
  );
}

async function readHistory(path: string): Promise<HistoryReadResult> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.size > MAXIMUM_HISTORY_BYTES) {
      return { kind: "FAILED" };
    }
    return {
      kind: "VALUE",
      value: JSON.parse(await readFile(path, "utf8")) as unknown,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "MISSING" };
    }
    return { kind: "FAILED" };
  }
}

function validReport(report: CycleReport): boolean {
  return (
    SAFE_NAME.test(report.runId) &&
    SAFE_NAME.test(report.cycleId) &&
    ExchangeIdSchema.safeParse(report.exchangeId).success &&
    report.status !== "FAILED" &&
    report.outcome !== "FAILED" &&
    z.iso.datetime({ offset: true }).safeParse(report.completedAt).success
  );
}

function historyEntry(report: CycleReport): CrossCycleHistoryEntry {
  if (report.status === "FAILED" || report.outcome === "FAILED") {
    throw new Error("Failed cycles cannot enter completed history");
  }
  return {
    runId: report.runId,
    cycleId: report.cycleId,
    reportPath: [
      "runs",
      report.runId,
      report.cycleId,
      "cycle-report.json",
    ].join("/"),
    mode: report.mode,
    status: report.status,
    outcome: report.outcome,
    completedAt: report.completedAt,
    account: report.accountAfter,
    performanceChange: report.performance,
    exchangeObservedActivity: {
      source: report.exchangeObservedActivity.source,
      attribution: report.exchangeObservedActivity.attribution,
      after: report.exchangeObservedActivity.after,
      newlyObserved: report.exchangeObservedActivity.newlyObserved,
      ...(report.exchangeObservedActivity.exactOrderMatches === undefined
        ? {}
        : {
            exactOrderMatches:
              report.exchangeObservedActivity.exactOrderMatches,
          }),
    },
    agentState: report.agentState.after,
    agentStateChanges: report.agentState.changes,
    currentCycleExecutions: report.currentCycleExecutions,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

function failure(
  reason: CrossCycleHistoryPersistenceFailureReason,
): PersistCrossCycleHistoryResult {
  return { persisted: false, reason };
}

/**
 * Updates a bounded, account-scoped cross-cycle index. Callers intentionally
 * invoke this only after the authoritative run journal has completed; every
 * failure is converted to a stable non-fatal result.
 */
export async function persistCrossCycleHistory(
  input: PersistCrossCycleHistoryInput,
): Promise<PersistCrossCycleHistoryResult> {
  let accountScope: string;
  try {
    accountScope = assertSafeMemoryScope(input.accountScope);
  } catch {
    return failure("INVALID_ACCOUNT_SCOPE");
  }
  if (accountScope === UNSCOPED_MEMORY_SCOPE) {
    return failure("UNSCOPED_ACCOUNT_SCOPE");
  }
  if (!validReport(input.report)) return failure("INVALID_REPORT");

  const path = historyPath(
    input.rootDirectory,
    input.report.exchangeId,
    accountScope,
  );
  const read = await readHistory(path);
  if (read.kind === "FAILED") return failure("READ_FAILED");

  let existingEntries: readonly CrossCycleHistoryEntry[] = [];
  if (read.kind === "VALUE") {
    const parsed = HistorySchema.safeParse(read.value);
    if (
      !parsed.success ||
      parsed.data.exchangeId !== input.report.exchangeId ||
      parsed.data.accountScope !== accountScope
    ) {
      return failure("HISTORY_VALIDATION_FAILED");
    }
    existingEntries = parsed.data
      .entries as unknown as readonly CrossCycleHistoryEntry[];
  }

  const entry = historyEntry(input.report);
  let entries = [
    entry,
    ...existingEntries.filter(
      (existing) =>
        existing.runId !== entry.runId || existing.cycleId !== entry.cycleId,
    ),
  ]
    .toSorted((left, right) =>
      right.completedAt.localeCompare(left.completedAt),
    )
    .slice(0, MAXIMUM_HISTORY_ENTRIES);
  let history: CrossCycleHistory = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    exchangeId: input.report.exchangeId,
    accountScope,
    updatedAt: entries[0]?.completedAt ?? entry.completedAt,
    maximumEntries: MAXIMUM_HISTORY_ENTRIES,
    entries,
  };
  while (entries.length > 1 && jsonBytes(history) > MAXIMUM_HISTORY_BYTES) {
    entries = entries.slice(0, -1);
    history = {
      ...history,
      updatedAt: entries[0]?.completedAt ?? entry.completedAt,
      entries,
    };
  }
  if (jsonBytes(history) > MAXIMUM_HISTORY_BYTES) {
    return failure("ENTRY_TOO_LARGE");
  }

  const validated = HistorySchema.safeParse(history);
  if (!validated.success) return failure("HISTORY_VALIDATION_FAILED");
  try {
    await writeJsonArtifact(dirname(path), "index.json", validated.data);
  } catch {
    return failure("WRITE_FAILED");
  }
  return { persisted: true, entryCount: entries.length };
}
