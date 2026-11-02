import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Decimal } from "decimal.js";
import type { ExchangeId } from "../domain/primitives.js";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../exchanges/memory-scope.js";
import {
  type RunArtifactEnvelope,
  type RunJournalManifest,
  type RunJournalStage,
} from "./run-journal.js";

const KNOWN_STAGES: ReadonlySet<RunJournalStage> = new Set([
  "STARTED",
  "DECIDED",
  "VALIDATED",
  "EXECUTING",
  "RECONCILING",
  "SUCCESS",
  "PASS",
  "AMBIGUOUS",
  "SAFETY_STOP",
  "FAILED",
]);
const KNOWN_EXCHANGES: ReadonlySet<ExchangeId> = new Set([
  "kalshi",
  "polymarket-international",
  "polymarket-us",
]);
const EXECUTION_STATUSES = new Set([
  "WORKING",
  "FILLED",
  "PARTIAL",
  "NO_FILL",
  "REJECTED",
  "AMBIGUOUS",
]);
const ORDER_STATES = new Set([
  "NEW",
  "OPEN",
  "INFLIGHT",
  "PARTIALLY_FILLED",
  "PENDING_CLEARING",
  "CLEARED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "BUSTED",
  "UNKNOWN",
]);
const ORDER_ARTIFACT_PATTERN =
  /^(.+)-(intent|submission|reconciliation)\.json$/;
const MANIFEST_ORDER_KEY_PATTERN =
  /^order\.(.+)\.(intent|submission|reconciliation)$/;
const ACTIVE_ORDER_STATES = new Set([
  "NEW",
  "OPEN",
  "INFLIGHT",
  "PARTIALLY_FILLED",
]);
const MAXIMUM_MANAGED_RESTING_LIFETIME_MILLISECONDS = 15 * 60_000;
const ORDER_RESOLUTION_KIND_PREFIX = "order-resolution.";

/** Artifact kind of a later journal's proof of a prior order attempt's outcome. */
export function orderResolutionKind(
  runId: string,
  cycleId: string,
  attemptId: string,
): string {
  return `${ORDER_RESOLUTION_KIND_PREFIX}${runId}.${cycleId}.${attemptId}`;
}

export type JournalRecoveryIssueReason =
  | "JOURNAL_UNREADABLE"
  | "MANIFEST_INVALID"
  | "AMBIGUOUS_JOURNAL"
  | "ORDER_DIRECTORY_UNREADABLE"
  | "ORDER_ARTIFACT_INVALID"
  | "ORDER_ARTIFACT_MISSING"
  | "ORPHANED_ORDER_OUTCOME"
  | "OBSERVE_ORDER_ARTIFACT"
  | "UNRESOLVED_ORDER_INTENT";

export interface JournalRecoveryIssue {
  readonly reason: JournalRecoveryIssueReason;
  readonly runId: string;
  readonly cycleId: string;
  readonly journalDirectory: string;
  readonly manifestPath: string;
  readonly attemptId?: string;
  readonly intentPath?: string;
  readonly submissionPath?: string;
  readonly reconciliationPath?: string;
  readonly resolutionPath?: string;
  readonly message: string;
}

export interface JournalRecoveryReference {
  readonly runId: string;
  readonly cycleId: string;
  readonly stage: RunJournalStage;
  readonly journalDirectory: string;
  readonly manifestPath: string;
  readonly attemptId: string;
  readonly intentPath: string;
  readonly submissionPath?: string;
  readonly reconciliationPath?: string;
  readonly resolutionPath?: string;
}

export interface JournalRecoveryInspection {
  readonly scannedJournalCount: number;
  readonly liveJournalCount: number;
  readonly safeNoIntentJournalCount: number;
  readonly resolvedAttempts: readonly JournalRecoveryReference[];
  readonly issues: readonly JournalRecoveryIssue[];
}

export interface InspectLiveJournalRecoveryInput {
  readonly rootDirectory: string;
  readonly exchangeId?: ExchangeId;
  readonly exclude?: {
    readonly runId: string;
    readonly cycleId: string;
  };
}

/** Read-only projection produced only after the recovery verifier accepts a proof. */
export interface VerifiedOrderResolution extends JournalRecoveryReference {
  readonly resolutionPath: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  /** Original submission time; never the later resolution journal's time. */
  readonly submittedAt: string;
  readonly filledQuantity: Decimal;
  readonly averageFillPrice?: Decimal;
  readonly fees: Decimal;
  readonly intentId?: string;
  readonly orderId?: string;
  readonly tradeIds?: readonly string[];
  /** Earliest original fill time, when the proof's trade evidence covers the result. */
  readonly firstFilledAt?: string;
  readonly estimatedProbability?: Decimal;
  readonly authorizationProbability?: Decimal;
}

export class UnresolvedLiveJournalError extends Error {
  public readonly code = "UNRESOLVED_LIVE_JOURNAL" as const;

  public constructor(public readonly issues: readonly JournalRecoveryIssue[]) {
    super(
      `${issues.length} prior live journal issue${issues.length === 1 ? "" : "s"} require reconciliation before another live cycle`,
    );
    this.name = "UnresolvedLiveJournalError";
  }
}

interface OrderArtifactPaths {
  intentPath?: string;
  submissionPath?: string;
  reconciliationPath?: string;
}

interface OrderCorrelation {
  readonly attemptSequence: number;
  readonly submittedAt: string;
  readonly exchangeId: ExchangeId;
  readonly marketId: string;
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly canonicalLimitPrice: string;
  readonly quantity: string;
  readonly executionPolicy: "IOC" | "GTD";
  readonly restUntil?: string;
}

type DurableResult = "TERMINAL" | "UNRESOLVED" | "INVALID";

interface OrderArtifactDiscovery {
  readonly attempts: ReadonlyMap<string, OrderArtifactPaths>;
  readonly issues: readonly JournalRecoveryIssue[];
  readonly hasOrderArtifacts: boolean;
}

interface OrderResolution {
  readonly path: string;
  readonly envelope: RunArtifactEnvelope;
  readonly manifest: RunJournalManifest;
}

interface ScannedJournal {
  readonly manifest: RunJournalManifest;
  readonly journalDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    isRecord(error) &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function withinDirectory(directory: string, path: string): boolean {
  const pathWithinDirectory = relative(directory, path);
  return (
    pathWithinDirectory.length > 0 &&
    !pathWithinDirectory.startsWith("..") &&
    !isAbsolute(pathWithinDirectory) &&
    !pathWithinDirectory.includes(":")
  );
}

function isKnownExchangeId(value: unknown): value is ExchangeId {
  return typeof value === "string" && KNOWN_EXCHANGES.has(value as ExchangeId);
}

function isSafeAccountScope(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertSafeMemoryScope(value);
    return true;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function finiteDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function orderCorrelation(
  envelope: RunArtifactEnvelope,
  manifest: RunJournalManifest,
): OrderCorrelation | undefined {
  if (!isRecord(envelope.data)) return undefined;
  const { attemptSequence, submittedAt, validated } = envelope.data;
  if (
    !Number.isSafeInteger(attemptSequence) ||
    (attemptSequence as number) <= 0 ||
    !isTimestamp(submittedAt) ||
    !isRecord(validated) ||
    !isRecord(validated.order)
  ) {
    return undefined;
  }
  const order = validated.order;
  if (!isRecord(order.marketId)) return undefined;
  const exchangeId = order.marketId.exchange;
  const marketId = order.marketId.value;
  const { marketSlug, side, action } = order;
  const canonicalLimitPrice = finiteDecimal(order.canonicalLimitPrice);
  const quantity = finiteDecimal(order.quantity);
  const executionPolicy = order.executionPolicy ?? "IOC";
  const restUntil = order.restUntil;
  const canonicalQuantity =
    quantity?.gt(0) === true ? quantity.toFixed() : undefined;
  if (
    !isKnownExchangeId(exchangeId) ||
    exchangeId !== manifest.exchangeId ||
    typeof marketId !== "string" ||
    marketId.length === 0 ||
    typeof marketSlug !== "string" ||
    marketSlug.length === 0 ||
    (side !== "YES" && side !== "NO") ||
    (action !== "BUY" && action !== "SELL") ||
    canonicalLimitPrice === undefined ||
    !canonicalLimitPrice.gt(0) ||
    !canonicalLimitPrice.lt(1) ||
    canonicalQuantity === undefined ||
    (executionPolicy !== "IOC" && executionPolicy !== "GTD")
  ) {
    return undefined;
  }
  if (executionPolicy === "IOC" && restUntil !== undefined) return undefined;
  if (executionPolicy === "GTD") {
    if (
      exchangeId !== "polymarket-us" ||
      action !== "BUY" ||
      !isTimestamp(restUntil)
    ) {
      return undefined;
    }
    const submittedAtMilliseconds = new Date(submittedAt).getTime();
    const restUntilMilliseconds = new Date(restUntil).getTime();
    if (
      restUntilMilliseconds <= submittedAtMilliseconds ||
      restUntilMilliseconds - submittedAtMilliseconds >
        MAXIMUM_MANAGED_RESTING_LIFETIME_MILLISECONDS
    ) {
      return undefined;
    }
  }
  return {
    attemptSequence: attemptSequence as number,
    submittedAt,
    exchangeId,
    marketId,
    marketSlug,
    side,
    action,
    canonicalLimitPrice: canonicalLimitPrice.toFixed(),
    quantity: canonicalQuantity,
    executionPolicy,
    ...(executionPolicy === "GTD" ? { restUntil: restUntil as string } : {}),
  };
}

function attemptIdMatchesSequence(
  attemptId: string,
  attemptSequence: number,
): boolean {
  return (
    /^\d+$/.test(attemptId) &&
    Number.isSafeInteger(Number(attemptId)) &&
    Number(attemptId) === attemptSequence
  );
}

function sameOrderCorrelation(
  expected: OrderCorrelation,
  actual: OrderCorrelation,
): boolean {
  return (
    expected.attemptSequence === actual.attemptSequence &&
    expected.submittedAt === actual.submittedAt &&
    expected.exchangeId === actual.exchangeId &&
    expected.marketId === actual.marketId &&
    expected.marketSlug === actual.marketSlug &&
    expected.side === actual.side &&
    expected.action === actual.action &&
    expected.canonicalLimitPrice === actual.canonicalLimitPrice &&
    expected.quantity === actual.quantity &&
    expected.executionPolicy === actual.executionPolicy &&
    expected.restUntil === actual.restUntil
  );
}

function inspectDurableResult(
  value: unknown,
  correlation: OrderCorrelation,
  allowWorking: boolean,
): DurableResult {
  if (!isRecord(value)) return "INVALID";
  const { status, finalState } = value;
  if (
    typeof status !== "string" ||
    !EXECUTION_STATUSES.has(status) ||
    typeof finalState !== "string" ||
    !ORDER_STATES.has(finalState)
  ) {
    return "INVALID";
  }
  const filledQuantity = finiteDecimal(value.filledQuantity);
  const fees = finiteDecimal(value.fees);
  const orderedQuantity = new Decimal(correlation.quantity);
  if (
    filledQuantity === undefined ||
    filledQuantity.lt(0) ||
    filledQuantity.gt(orderedQuantity) ||
    fees === undefined ||
    fees.lt(0)
  ) {
    return "INVALID";
  }
  const averageFillPrice =
    value.averageFillPrice === undefined
      ? undefined
      : finiteDecimal(value.averageFillPrice);
  if (
    (averageFillPrice !== undefined &&
      (!averageFillPrice.gt(0) || !averageFillPrice.lt(1))) ||
    (status !== "WORKING" &&
      filledQuantity.gt(0) &&
      averageFillPrice === undefined) ||
    (filledQuantity.eq(0) && value.averageFillPrice !== undefined)
  ) {
    return "INVALID";
  }
  if (status === "AMBIGUOUS") return "UNRESOLVED";

  if (status === "WORKING") {
    const remainingQuantity = finiteDecimal(value.remainingQuantity);
    if (
      correlation.executionPolicy !== "GTD" ||
      typeof value.orderId !== "string" ||
      value.orderId.length === 0 ||
      !ACTIVE_ORDER_STATES.has(finalState) ||
      !filledQuantity.lt(orderedQuantity) ||
      remainingQuantity === undefined ||
      !remainingQuantity.gt(0) ||
      !remainingQuantity.eq(orderedQuantity.minus(filledQuantity))
    ) {
      return "INVALID";
    }
    if (!allowWorking) return "UNRESOLVED";
    // The mutation is durably known and bounded. A later cycle still discovers
    // the live order through the existing open-order safety gate.
    return "TERMINAL";
  }

  const validQuantity =
    (status === "FILLED" && filledQuantity.eq(orderedQuantity)) ||
    (status === "PARTIAL" &&
      filledQuantity.gt(0) &&
      filledQuantity.lt(orderedQuantity)) ||
    ((status === "NO_FILL" || status === "REJECTED") && filledQuantity.eq(0));
  if (!validQuantity) return "INVALID";

  const terminalStates: ReadonlySet<string> =
    status === "FILLED"
      ? new Set(["FILLED", "CLEARED", "CANCELED", "EXPIRED"])
      : status === "PARTIAL"
        ? new Set([
            "FILLED",
            "CLEARED",
            "CANCELED",
            "EXPIRED",
            "REJECTED",
            "BUSTED",
          ])
        : status === "NO_FILL"
          ? new Set(["CANCELED", "EXPIRED"])
          : new Set(["REJECTED", "CANCELED", "EXPIRED"]);
  if (terminalStates.has(finalState)) return "TERMINAL";
  return [
    "FILLED",
    "CLEARED",
    "CANCELED",
    "EXPIRED",
    "REJECTED",
    "BUSTED",
  ].includes(finalState)
    ? "INVALID"
    : "UNRESOLVED";
}

function validateManifest(
  value: unknown,
  runId: string,
  cycleId: string,
): RunJournalManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode !== "live" && value.mode !== "observe") return undefined;
  if (
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    value.cycleId !== cycleId ||
    !isKnownExchangeId(value.exchangeId) ||
    (value.accountScope !== undefined &&
      !isSafeAccountScope(value.accountScope)) ||
    typeof value.stage !== "string" ||
    !KNOWN_STAGES.has(value.stage as RunJournalStage) ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.history) ||
    !isRecord(value.artifacts) ||
    !Object.values(value.artifacts).every(
      (artifactPath) => typeof artifactPath === "string",
    )
  ) {
    return undefined;
  }
  return value as unknown as RunJournalManifest;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function issue(
  reason: JournalRecoveryIssueReason,
  runId: string,
  cycleId: string,
  journalDirectory: string,
  message: string,
  paths: Partial<
    Pick<
      JournalRecoveryIssue,
      | "attemptId"
      | "intentPath"
      | "submissionPath"
      | "reconciliationPath"
      | "resolutionPath"
    >
  > = {},
): JournalRecoveryIssue {
  return {
    reason,
    runId,
    cycleId,
    journalDirectory,
    manifestPath: resolve(journalDirectory, "manifest.json"),
    ...paths,
    message,
  };
}

function getOrCreateAttempt(
  attempts: Map<string, OrderArtifactPaths>,
  attemptId: string,
): OrderArtifactPaths {
  const existing = attempts.get(attemptId);
  if (existing !== undefined) return existing;
  const created: OrderArtifactPaths = {};
  attempts.set(attemptId, created);
  return created;
}

function registerArtifactPath(
  attempts: Map<string, OrderArtifactPaths>,
  attemptId: string,
  phase: "intent" | "submission" | "reconciliation",
  path: string,
): boolean {
  const attempt = getOrCreateAttempt(attempts, attemptId);
  const property = `${phase}Path` as const;
  const existing = attempt[property];
  if (existing !== undefined && existing !== path) return false;
  attempt[property] = path;
  return true;
}

async function discoverOrderArtifacts(
  manifest: RunJournalManifest,
  journalDirectory: string,
): Promise<OrderArtifactDiscovery> {
  const attempts = new Map<string, OrderArtifactPaths>();
  const issues: JournalRecoveryIssue[] = [];
  let hasOrderArtifacts = false;
  for (const [kind, artifactPath] of Object.entries(manifest.artifacts)) {
    if (kind.startsWith("order.")) hasOrderArtifacts = true;
    const match = MANIFEST_ORDER_KEY_PATTERN.exec(kind);
    if (match === null) continue;
    const attemptId = match[1];
    const phase = match[2];
    if (
      attemptId === undefined ||
      (phase !== "intent" &&
        phase !== "submission" &&
        phase !== "reconciliation")
    ) {
      continue;
    }
    const resolvedPath = resolve(journalDirectory, artifactPath);
    if (!withinDirectory(journalDirectory, resolvedPath)) {
      issues.push(
        issue(
          "ORDER_ARTIFACT_INVALID",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} ${phase} path escapes its journal directory`,
          { attemptId },
        ),
      );
      continue;
    }
    if (!registerArtifactPath(attempts, attemptId, phase, resolvedPath)) {
      issues.push(
        issue(
          "ORDER_ARTIFACT_INVALID",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} has conflicting ${phase} artifact paths`,
          { attemptId },
        ),
      );
    }
  }

  const ordersDirectory = resolve(journalDirectory, "orders");
  let entries;
  try {
    entries = await readdir(ordersDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { attempts, issues, hasOrderArtifacts };
    }
    issues.push(
      issue(
        "ORDER_DIRECTORY_UNREADABLE",
        manifest.runId,
        manifest.cycleId,
        journalDirectory,
        "Could not inspect durable order journal artifacts",
      ),
    );
    return { attempts, issues, hasOrderArtifacts };
  }
  for (const entry of entries) {
    hasOrderArtifacts = true;
    if (!entry.isFile()) continue;
    const match = ORDER_ARTIFACT_PATTERN.exec(entry.name);
    if (match === null) continue;
    const attemptId = match[1];
    const phase = match[2];
    if (
      attemptId === undefined ||
      (phase !== "intent" &&
        phase !== "submission" &&
        phase !== "reconciliation")
    ) {
      continue;
    }
    const path = resolve(ordersDirectory, entry.name);
    if (!registerArtifactPath(attempts, attemptId, phase, path)) {
      issues.push(
        issue(
          "ORDER_ARTIFACT_INVALID",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} has conflicting ${phase} artifact paths`,
          { attemptId },
        ),
      );
    }
  }
  return { attempts, issues, hasOrderArtifacts };
}

async function readOrderArtifact(
  path: string,
  manifest: RunJournalManifest,
  attemptId: string,
  phase: "intent" | "submission" | "reconciliation",
): Promise<RunArtifactEnvelope | undefined> {
  let value: unknown;
  try {
    value = await readJson(path);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runId !== manifest.runId ||
    value.cycleId !== manifest.cycleId ||
    value.accountScope !== manifest.accountScope ||
    value.kind !== `order.${attemptId}.${phase}` ||
    !isTimestamp(value.recordedAt) ||
    !("data" in value)
  ) {
    return undefined;
  }
  return value as unknown as RunArtifactEnvelope;
}

function attemptKey(runId: string, cycleId: string, attemptId: string): string {
  return `${runId}/${cycleId}/${attemptId}`;
}

async function discoverOrderResolutions(
  journals: readonly ScannedJournal[],
): Promise<{
  readonly resolutions: ReadonlyMap<string, readonly OrderResolution[]>;
  readonly issues: readonly JournalRecoveryIssue[];
}> {
  const resolutions = new Map<string, OrderResolution[]>();
  const issues: JournalRecoveryIssue[] = [];
  for (const { manifest, journalDirectory } of journals) {
    for (const [kind, artifactPath] of Object.entries(manifest.artifacts)) {
      if (!kind.startsWith(ORDER_RESOLUTION_KIND_PREFIX)) continue;
      const invalid = (message: string): void => {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            message,
          ),
        );
      };
      const path = resolve(journalDirectory, artifactPath);
      if (!withinDirectory(journalDirectory, path)) {
        invalid("Order resolution path escapes its journal directory");
        continue;
      }
      let value: unknown;
      try {
        value = await readJson(path);
      } catch {
        invalid("Order resolution is missing or unreadable");
        continue;
      }
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.runId !== manifest.runId ||
        value.cycleId !== manifest.cycleId ||
        value.accountScope !== manifest.accountScope ||
        value.kind !== kind ||
        !isTimestamp(value.recordedAt) ||
        !isRecord(value.data) ||
        !isRecord(value.data.target)
      ) {
        invalid("Order resolution has an invalid identity");
        continue;
      }
      const { runId, cycleId, attemptId } = value.data.target;
      if (
        typeof runId !== "string" ||
        typeof cycleId !== "string" ||
        typeof attemptId !== "string" ||
        runId === manifest.runId ||
        orderResolutionKind(runId, cycleId, attemptId) !== kind
      ) {
        invalid("Order resolution names an invalid order attempt");
        continue;
      }
      const key = attemptKey(runId, cycleId, attemptId);
      resolutions.set(key, [
        ...(resolutions.get(key) ?? []),
        {
          path,
          envelope: value as unknown as RunArtifactEnvelope,
          manifest,
        },
      ]);
    }
  }
  return { resolutions, issues };
}

function submissionResult(
  envelope: RunArtifactEnvelope,
  correlation: OrderCorrelation,
): DurableResult {
  if (!isRecord(envelope.data) || typeof envelope.data.kind !== "string") {
    return "INVALID";
  }
  if (envelope.data.kind === "NOT_SUBMITTED") {
    return envelope.data.reason === "ABORTED_BEFORE_SUBMISSION"
      ? "TERMINAL"
      : "INVALID";
  }
  if (envelope.data.kind === "THREW") return "UNRESOLVED";
  if (envelope.data.kind !== "RETURNED") return "INVALID";
  return inspectDurableResult(envelope.data.result, correlation, false);
}

function reconciliationResult(
  envelope: RunArtifactEnvelope,
  correlation: OrderCorrelation,
): DurableResult {
  if (
    !isRecord(envelope.data) ||
    typeof envelope.data.attempted !== "boolean" ||
    !("finalResult" in envelope.data)
  ) {
    return "INVALID";
  }
  if (
    isRecord(envelope.data.finalResult) &&
    envelope.data.finalResult.status === "WORKING"
  ) {
    if (
      !envelope.data.attempted ||
      !("reconciliationResult" in envelope.data)
    ) {
      return "UNRESOLVED";
    }
    const reconciled = inspectDurableResult(
      envelope.data.reconciliationResult,
      correlation,
      true,
    );
    if (
      reconciled !== "TERMINAL" ||
      !isRecord(envelope.data.reconciliationResult) ||
      envelope.data.reconciliationResult.status !== "WORKING"
    ) {
      return reconciled === "INVALID" ? "INVALID" : "UNRESOLVED";
    }
    return inspectDurableResult(envelope.data.finalResult, correlation, true);
  }
  return inspectDurableResult(envelope.data.finalResult, correlation, false);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function probability(value: unknown): Decimal | undefined {
  const parsed = finiteDecimal(value);
  return parsed?.gte(0) === true && parsed.lte(1) ? parsed : undefined;
}

/** Trade evidence supplies identity/time only when it covers the terminal result. */
function resolutionTrades(
  data: Record<string, unknown>,
  correlation: OrderCorrelation,
  filledQuantity: Decimal,
  averageFillPrice: Decimal | undefined,
  orderId: string | undefined,
):
  | { readonly tradeIds: readonly string[]; readonly firstFilledAt: string }
  | undefined {
  const evidence = data.evidence;
  if (
    !filledQuantity.gt(0) ||
    averageFillPrice === undefined ||
    !isRecord(evidence) ||
    !isRecord(evidence.window) ||
    evidence.window.from !== correlation.submittedAt ||
    !isTimestamp(evidence.window.to) ||
    !Array.isArray(evidence.trades) ||
    evidence.trades.length === 0 ||
    evidence.trades.length > 1_000
  )
    return undefined;
  const ids = new Set<string>();
  let firstFilledAt: string | undefined;
  let firstFilledAtMilliseconds = Infinity;
  const submittedAtMilliseconds = Date.parse(correlation.submittedAt);
  const windowEndMilliseconds = Date.parse(evidence.window.to);
  let quantity = new Decimal(0);
  let yesNotional = new Decimal(0);
  for (const trade of evidence.trades as unknown[]) {
    if (!isRecord(trade)) return undefined;
    const tradeId = nonemptyString(trade.tradeId);
    const size = finiteDecimal(trade.quantity);
    const price = finiteDecimal(trade.price);
    const createdAtMilliseconds =
      typeof trade.createdAt === "string" ? Date.parse(trade.createdAt) : NaN;
    if (
      tradeId === undefined ||
      ids.has(tradeId) ||
      size?.gt(0) !== true ||
      price?.gt(0) !== true ||
      !price.lt(1) ||
      !isTimestamp(trade.createdAt) ||
      createdAtMilliseconds < submittedAtMilliseconds ||
      createdAtMilliseconds > windowEndMilliseconds ||
      (trade.marketSlug !== undefined &&
        trade.marketSlug !== correlation.marketSlug) ||
      (trade.side !== undefined && trade.side !== correlation.side) ||
      (trade.action !== undefined && trade.action !== correlation.action) ||
      (trade.orderId !== undefined &&
        (orderId === undefined || trade.orderId !== orderId)) ||
      trade.state === "TRADE_STATE_BUSTED" ||
      trade.aggressor === false
    )
      return undefined;
    ids.add(tradeId);
    quantity = quantity.plus(size);
    yesNotional = yesNotional.plus(size.mul(price));
    if (createdAtMilliseconds < firstFilledAtMilliseconds) {
      firstFilledAt = trade.createdAt;
      firstFilledAtMilliseconds = createdAtMilliseconds;
    }
  }
  if (!quantity.eq(filledQuantity) || firstFilledAt === undefined)
    return undefined;
  const yesAverage = yesNotional.div(quantity);
  const sideAverage =
    correlation.side === "YES" ? yesAverage : new Decimal(1).minus(yesAverage);
  if (!sideAverage.toDecimalPlaces(6).eq(averageFillPrice)) return undefined;
  // These rows are an attestation inside the exact verified resolution, rather
  // than an independent account snapshot. Any supplied result identity must agree.
  if (isRecord(data.result) && Array.isArray(data.result.tradeIds)) {
    const resultIds = new Set(data.result.tradeIds as unknown[]);
    if (
      resultIds.size !== ids.size ||
      [...ids].some((id) => !resultIds.has(id))
    )
      return undefined;
  }
  return { tradeIds: [...ids], firstFilledAt };
}

function verifiedResolution(
  reference: JournalRecoveryReference & { readonly resolutionPath: string },
  manifest: RunJournalManifest,
  intent: RunArtifactEnvelope,
  correlation: OrderCorrelation,
  resolution: OrderResolution,
  knownOrderId: string | undefined,
): VerifiedOrderResolution | undefined {
  if (
    manifest.accountScope === undefined ||
    !isRecord(intent.data) ||
    !isRecord(intent.data.validated) ||
    !isRecord(resolution.envelope.data) ||
    !isRecord(resolution.envelope.data.result)
  )
    return undefined;
  const data = resolution.envelope.data;
  const result = data.result as Record<string, unknown>;
  const filledQuantity = finiteDecimal(result.filledQuantity);
  const fees = finiteDecimal(result.fees);
  if (filledQuantity === undefined || fees === undefined) return undefined;
  const averageFillPrice = finiteDecimal(result.averageFillPrice);
  const orderId = nonemptyString(result.orderId) ?? knownOrderId;
  const trades = resolutionTrades(
    data,
    correlation,
    filledQuantity,
    averageFillPrice,
    orderId,
  );
  const rawIds = result.tradeIds;
  const resultIds =
    Array.isArray(rawIds) &&
    rawIds.length <= 1_000 &&
    rawIds.every((id: unknown) => nonemptyString(id) !== undefined)
      ? [...new Set(rawIds as string[])]
      : undefined;
  const tradeIds = trades?.tradeIds ?? resultIds;
  const proposal = intent.data.validated.proposal;
  const matchesProposal =
    isRecord(proposal) &&
    proposal.marketSlug === correlation.marketSlug &&
    proposal.side === correlation.side &&
    proposal.action === correlation.action;
  const estimatedProbability = matchesProposal
    ? probability(proposal.estimatedProbability)
    : undefined;
  const authorizationProbability = matchesProposal
    ? probability(intent.data.validated.authorizationProbability)
    : undefined;
  const intentId = nonemptyString(intent.data.intentId);
  return {
    ...reference,
    exchangeId: manifest.exchangeId,
    accountScope: manifest.accountScope,
    marketSlug: correlation.marketSlug,
    side: correlation.side,
    action: correlation.action,
    submittedAt: correlation.submittedAt,
    filledQuantity,
    fees,
    ...(averageFillPrice === undefined ? {} : { averageFillPrice }),
    ...(intentId === undefined ? {} : { intentId }),
    ...(orderId === undefined ? {} : { orderId }),
    ...(tradeIds === undefined ? {} : { tradeIds }),
    ...(trades === undefined ? {} : { firstFilledAt: trades.firstFilledAt }),
    ...(estimatedProbability === undefined ? {} : { estimatedProbability }),
    ...(authorizationProbability === undefined
      ? {}
      : { authorizationProbability }),
  };
}

async function inspectLiveJournal(
  manifest: RunJournalManifest,
  journalDirectory: string,
  resolutions: ReadonlyMap<string, readonly OrderResolution[]>,
  verifiedResolutions?: VerifiedOrderResolution[],
): Promise<{
  readonly noIntent: boolean;
  readonly resolved: readonly JournalRecoveryReference[];
  readonly issues: readonly JournalRecoveryIssue[];
}> {
  const discovery = await discoverOrderArtifacts(manifest, journalDirectory);
  const issues = [...discovery.issues];
  const resolved: JournalRecoveryReference[] = [];

  let intentCount = 0;
  for (const [attemptId, paths] of discovery.attempts) {
    const referencePaths = {
      attemptId,
      ...(paths.intentPath === undefined
        ? {}
        : { intentPath: paths.intentPath }),
      ...(paths.submissionPath === undefined
        ? {}
        : { submissionPath: paths.submissionPath }),
      ...(paths.reconciliationPath === undefined
        ? {}
        : { reconciliationPath: paths.reconciliationPath }),
    };
    if (paths.intentPath === undefined) {
      issues.push(
        issue(
          "ORPHANED_ORDER_OUTCOME",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} has an outcome artifact but no durable intent`,
          referencePaths,
        ),
      );
      continue;
    }
    intentCount += 1;
    const intent = await readOrderArtifact(
      paths.intentPath,
      manifest,
      attemptId,
      "intent",
    );
    if (intent === undefined) {
      issues.push(
        issue(
          "ORDER_ARTIFACT_INVALID",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} intent is missing, unreadable, or has invalid identity`,
          referencePaths,
        ),
      );
      continue;
    }
    const intentCorrelation = orderCorrelation(intent, manifest);
    if (
      intentCorrelation === undefined ||
      !attemptIdMatchesSequence(attemptId, intentCorrelation.attemptSequence)
    ) {
      issues.push(
        issue(
          "ORDER_ARTIFACT_INVALID",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} intent has an invalid attempt, timestamp, or order fingerprint`,
          referencePaths,
        ),
      );
      continue;
    }

    let durableResult: DurableResult = "UNRESOLVED";
    let knownOrderId: string | undefined;
    if (paths.submissionPath !== undefined) {
      const submission = await readOrderArtifact(
        paths.submissionPath,
        manifest,
        attemptId,
        "submission",
      );
      if (submission === undefined) {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} submission outcome is unreadable or invalid`,
            referencePaths,
          ),
        );
        continue;
      }
      const submissionCorrelation = orderCorrelation(submission, manifest);
      if (
        submissionCorrelation === undefined ||
        !sameOrderCorrelation(intentCorrelation, submissionCorrelation)
      ) {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} submission does not match its durable intent`,
            referencePaths,
          ),
        );
        continue;
      }
      durableResult = submissionResult(submission, intentCorrelation);
      if (isRecord(submission.data)) {
        knownOrderId =
          nonemptyString(submission.data.orderId) ??
          (isRecord(submission.data.result)
            ? nonemptyString(submission.data.result.orderId)
            : undefined);
      }
      if (durableResult === "INVALID") {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} submission outcome has an invalid payload`,
            referencePaths,
          ),
        );
        continue;
      }
    }

    if (paths.reconciliationPath !== undefined) {
      const reconciliation = await readOrderArtifact(
        paths.reconciliationPath,
        manifest,
        attemptId,
        "reconciliation",
      );
      if (reconciliation === undefined) {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} reconciliation outcome is unreadable or invalid`,
            referencePaths,
          ),
        );
        continue;
      }
      const reconciliationCorrelation = orderCorrelation(
        reconciliation,
        manifest,
      );
      if (
        reconciliationCorrelation === undefined ||
        !sameOrderCorrelation(intentCorrelation, reconciliationCorrelation)
      ) {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} reconciliation does not match its durable intent`,
            referencePaths,
          ),
        );
        continue;
      }
      durableResult = reconciliationResult(reconciliation, intentCorrelation);
      if (durableResult === "INVALID") {
        issues.push(
          issue(
            "ORDER_ARTIFACT_INVALID",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            `Order ${attemptId} reconciliation outcome has an invalid payload`,
            referencePaths,
          ),
        );
        continue;
      }
    }

    let resolutionPath: string | undefined;
    if (durableResult !== "TERMINAL") {
      const candidates =
        resolutions.get(
          attemptKey(manifest.runId, manifest.cycleId, attemptId),
        ) ?? [];
      const resolution = candidates[0];
      if (resolution !== undefined) {
        const resolutionCorrelation = orderCorrelation(
          resolution.envelope,
          manifest,
        );
        const result = isRecord(resolution.envelope.data)
          ? resolution.envelope.data.result
          : undefined;
        if (
          candidates.length > 1 ||
          resolution.manifest.accountScope !== manifest.accountScope ||
          resolution.manifest.exchangeId !== manifest.exchangeId ||
          resolutionCorrelation === undefined ||
          !sameOrderCorrelation(intentCorrelation, resolutionCorrelation) ||
          (isRecord(result) && result.status === "WORKING") ||
          inspectDurableResult(result, intentCorrelation, false) !== "TERMINAL"
        ) {
          issues.push(
            issue(
              "ORDER_ARTIFACT_INVALID",
              manifest.runId,
              manifest.cycleId,
              journalDirectory,
              `Order ${attemptId} resolution does not prove a terminal outcome of its durable intent`,
              { ...referencePaths, resolutionPath: resolution.path },
            ),
          );
          continue;
        }
        durableResult = "TERMINAL";
        resolutionPath = resolution.path;
        if (
          verifiedResolutions !== undefined &&
          !issues.some(
            (item) =>
              item.attemptId === undefined || item.attemptId === attemptId,
          )
        ) {
          const projected = verifiedResolution(
            {
              runId: manifest.runId,
              cycleId: manifest.cycleId,
              stage: manifest.stage,
              journalDirectory,
              manifestPath: resolve(journalDirectory, "manifest.json"),
              attemptId,
              intentPath: paths.intentPath,
              resolutionPath,
            },
            manifest,
            intent,
            intentCorrelation,
            resolution,
            knownOrderId,
          );
          if (projected !== undefined) verifiedResolutions.push(projected);
        }
      }
    }

    if (durableResult !== "TERMINAL") {
      issues.push(
        issue(
          "UNRESOLVED_ORDER_INTENT",
          manifest.runId,
          manifest.cycleId,
          journalDirectory,
          `Order ${attemptId} intent has no demonstrably safe durable outcome`,
          referencePaths,
        ),
      );
      continue;
    }
    resolved.push({
      runId: manifest.runId,
      cycleId: manifest.cycleId,
      stage: manifest.stage,
      journalDirectory,
      manifestPath: resolve(journalDirectory, "manifest.json"),
      attemptId,
      intentPath: paths.intentPath,
      ...(paths.submissionPath === undefined
        ? {}
        : { submissionPath: paths.submissionPath }),
      ...(paths.reconciliationPath === undefined
        ? {}
        : { reconciliationPath: paths.reconciliationPath }),
      ...(resolutionPath === undefined ? {} : { resolutionPath }),
    });
  }
  if (manifest.stage === "AMBIGUOUS" && intentCount === 0) {
    issues.push(
      issue(
        "AMBIGUOUS_JOURNAL",
        manifest.runId,
        manifest.cycleId,
        journalDirectory,
        "The prior live journal is ambiguous but has no durable order intent to reconcile",
      ),
    );
  }
  return { noIntent: intentCount === 0, resolved, issues };
}

async function inspectJournalRecovery(
  input: InspectLiveJournalRecoveryInput,
  verifiedResolutions?: VerifiedOrderResolution[],
  accountScope?: string,
): Promise<JournalRecoveryInspection> {
  if (input.exchangeId !== undefined && !isKnownExchangeId(input.exchangeId)) {
    throw new TypeError("Unknown recovery exchange ID");
  }
  const rootDirectory = resolve(process.cwd(), input.rootDirectory);
  const runsDirectory = resolve(rootDirectory, "runs");
  const issues: JournalRecoveryIssue[] = [];
  const resolvedAttempts: JournalRecoveryReference[] = [];
  const journals: ScannedJournal[] = [];
  let scannedJournalCount = 0;
  let liveJournalCount = 0;
  let safeNoIntentJournalCount = 0;
  let runEntries;
  try {
    runEntries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return {
        scannedJournalCount,
        liveJournalCount,
        safeNoIntentJournalCount,
        resolvedAttempts,
        issues,
      };
    }
    throw error;
  }

  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runId = runEntry.name;
    const runDirectory = resolve(runsDirectory, runId);
    let cycleEntries;
    try {
      cycleEntries = await readdir(runDirectory, { withFileTypes: true });
    } catch {
      issues.push(
        issue(
          "JOURNAL_UNREADABLE",
          runId,
          "<unknown>",
          runDirectory,
          "Could not enumerate prior journal cycles",
        ),
      );
      continue;
    }
    for (const cycleEntry of cycleEntries) {
      if (!cycleEntry.isDirectory()) continue;
      const cycleId = cycleEntry.name;
      if (input.exclude?.runId === runId && input.exclude.cycleId === cycleId) {
        continue;
      }
      scannedJournalCount += 1;
      const journalDirectory = resolve(runDirectory, cycleId);
      const manifestPath = resolve(journalDirectory, "manifest.json");
      let rawManifest: unknown;
      try {
        rawManifest = await readJson(manifestPath);
      } catch {
        issues.push(
          issue(
            "JOURNAL_UNREADABLE",
            runId,
            cycleId,
            journalDirectory,
            "Prior journal manifest is missing, corrupt, or unreadable",
          ),
        );
        continue;
      }
      const manifest = validateManifest(rawManifest, runId, cycleId);
      if (manifest === undefined) {
        issues.push(
          issue(
            "MANIFEST_INVALID",
            runId,
            cycleId,
            journalDirectory,
            "Prior journal manifest is invalid and cannot be proven non-live",
          ),
        );
        continue;
      }
      if (
        (input.exchangeId !== undefined &&
          manifest.exchangeId !== input.exchangeId) ||
        (accountScope !== undefined && manifest.accountScope !== accountScope)
      ) {
        continue;
      }
      journals.push({ manifest, journalDirectory });
    }
  }

  // A later journal may hold the proof of an earlier attempt's outcome.
  const resolutionDiscovery = await discoverOrderResolutions(journals);
  issues.push(...resolutionDiscovery.issues);
  for (const { manifest, journalDirectory } of journals) {
    if (manifest.mode === "observe") {
      const discovery = await discoverOrderArtifacts(
        manifest,
        journalDirectory,
      );
      issues.push(...discovery.issues);
      if (discovery.hasOrderArtifacts) {
        issues.push(
          issue(
            "OBSERVE_ORDER_ARTIFACT",
            manifest.runId,
            manifest.cycleId,
            journalDirectory,
            "An observe-only journal contains an order artifact, violating the non-trading invariant",
          ),
        );
      }
      continue;
    }
    liveJournalCount += 1;
    const inspection = await inspectLiveJournal(
      manifest,
      journalDirectory,
      resolutionDiscovery.resolutions,
      verifiedResolutions,
    );
    if (inspection.noIntent && inspection.issues.length === 0) {
      safeNoIntentJournalCount += 1;
    }
    resolvedAttempts.push(...inspection.resolved);
    issues.push(...inspection.issues);
  }
  return {
    scannedJournalCount,
    liveJournalCount,
    safeNoIntentJournalCount,
    resolvedAttempts,
    issues,
  };
}

export async function inspectLiveJournalRecovery(
  input: InspectLiveJournalRecoveryInput,
): Promise<JournalRecoveryInspection> {
  return inspectJournalRecovery(input);
}

/** Uses the recovery verifier without querying an account or changing any journal. */
export async function readVerifiedOrderResolutions(
  input: InspectLiveJournalRecoveryInput & {
    readonly exchangeId: ExchangeId;
    readonly accountScope: string;
  },
): Promise<{
  readonly resolutions: readonly VerifiedOrderResolution[];
  readonly issues: readonly JournalRecoveryIssue[];
}> {
  const scope = assertSafeMemoryScope(input.accountScope);
  if (scope === UNSCOPED_MEMORY_SCOPE) return { resolutions: [], issues: [] };
  const resolutions: VerifiedOrderResolution[] = [];
  const inspection = await inspectJournalRecovery(input, resolutions, scope);
  return { resolutions, issues: inspection.issues };
}

export async function assertNoUnresolvedLiveJournals(
  input: InspectLiveJournalRecoveryInput,
): Promise<JournalRecoveryInspection> {
  const inspection = await inspectLiveJournalRecovery(input);
  if (inspection.issues.length > 0) {
    throw new UnresolvedLiveJournalError(inspection.issues);
  }
  return inspection;
}
