import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ExchangeId } from "../domain/primitives.js";
import type { ImmediateOrder } from "../domain/order.js";
import { ExchangeError } from "../exchanges/exchange.js";
import {
  assertSafeMemoryScope,
  UNSCOPED_MEMORY_SCOPE,
} from "../exchanges/memory-scope.js";

export const EXECUTION_FAILURE_CODES = [
  "AUTHENTICATION",
  "NOT_FOUND",
  "RATE_LIMITED",
  "SCHEMA",
  "TRANSIENT",
  "AMBIGUOUS_SUBMISSION",
  "INVALID_REQUEST",
  "UNSUPPORTED",
  "UNKNOWN",
  "SAFETY_GUARD",
  "PREVIEW_REJECTED",
  "ORDER_REJECTED",
  "NO_FILL",
  "AMBIGUOUS",
] as const;
export type ExecutionFailureCode = (typeof EXECUTION_FAILURE_CODES)[number];
export type ExecutionFailurePhase =
  "PRECHECK" | "PREVIEW" | "SUBMISSION" | "RECONCILIATION";

export type ExecutionHealthKey = Pick<
  ImmediateOrder,
  "marketSlug" | "side" | "action"
>;

export interface ExecutionFailure extends ExecutionHealthKey {
  readonly failureCode: ExecutionFailureCode;
  readonly phase: ExecutionFailurePhase;
  readonly observedAt: string;
  readonly mutationMayHaveOccurred: boolean;
}

export interface ExecutionCooldown {
  readonly failureCode: ExecutionFailureCode;
  readonly retryAfter: string;
}

export interface ExecutionHealth {
  blockedUntil(
    order: ExecutionHealthKey,
    at: Date,
  ): Promise<ExecutionCooldown | undefined>;
  recordFailure(failure: ExecutionFailure): Promise<void>;
}

export function executionFailureCode(error: unknown): ExecutionFailureCode {
  return error instanceof ExchangeError ? error.code : "UNKNOWN";
}

const MAXIMUM_RECORDS = 1_000;
const MAXIMUM_BYTES = 1_048_576;
const MarketSlugSchema = z.string().min(1).max(1_000);
const FailureSchema = z
  .object({
    marketSlug: MarketSlugSchema,
    side: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    failureCode: z.enum(EXECUTION_FAILURE_CODES),
    phase: z.enum(["PRECHECK", "PREVIEW", "SUBMISSION", "RECONCILIATION"]),
    observedAt: z.iso.datetime({ offset: true }),
    mutationMayHaveOccurred: z.boolean(),
  })
  .strict();
const SnapshotSchema = z
  .object({
    version: z.literal(1),
    exchangeId: z.enum(["kalshi", "polymarket-us", "polymarket-international"]),
    accountScope: z.string(),
    failures: z.array(FailureSchema).max(MAXIMUM_RECORDS),
  })
  .strict();

export interface FileExecutionHealthOptions {
  readonly rootDirectory: string;
  readonly exchangeId: ExchangeId;
  readonly accountScope: string;
  /** Policy belongs to the deployment. Omitted or zero durations never block. */
  readonly cooldownMilliseconds: Readonly<
    Partial<Record<ExecutionFailureCode, number>>
  >;
}

/** Stores only typed failure facts. Messages, responses and credentials are excluded. */
export class FileExecutionHealth implements ExecutionHealth {
  private readonly path: string;
  private readonly accountScope: string;
  private readonly exchangeId: ExchangeId;
  private readonly cooldownMilliseconds: Readonly<
    Partial<Record<ExecutionFailureCode, number>>
  >;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: FileExecutionHealthOptions) {
    this.accountScope = assertSafeMemoryScope(options.accountScope);
    if (this.accountScope === UNSCOPED_MEMORY_SCOPE)
      throw new Error("Execution health requires an account scope");
    this.exchangeId = SnapshotSchema.shape.exchangeId.parse(options.exchangeId);
    this.cooldownMilliseconds = Object.freeze({
      ...options.cooldownMilliseconds,
    });
    for (const [code, duration] of Object.entries(this.cooldownMilliseconds)) {
      if (
        !EXECUTION_FAILURE_CODES.includes(code as ExecutionFailureCode) ||
        !Number.isSafeInteger(duration) ||
        duration < 0
      ) {
        throw new RangeError(
          "Execution cooldown durations must be non-negative safe integers for known failure codes",
        );
      }
    }
    this.path = resolve(
      options.rootDirectory,
      "execution-health",
      this.exchangeId,
      this.accountScope,
      "index.json",
    );
  }

  private async readFailures(): Promise<readonly ExecutionFailure[]> {
    try {
      const file = await lstat(this.path);
      if (!file.isFile() || file.size > MAXIMUM_BYTES)
        throw new Error("Invalid execution-health file");
      const parsed = SnapshotSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")) as unknown,
      );
      if (
        parsed.exchangeId !== this.exchangeId ||
        parsed.accountScope !== this.accountScope
      )
        throw new Error("Execution-health account scope mismatch");
      return parsed.failures;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public blockedUntil(
    order: ExecutionHealthKey,
    at: Date,
  ): Promise<ExecutionCooldown | undefined> {
    return this.queue.then(async () => {
      MarketSlugSchema.parse(order.marketSlug);
      if (!Number.isFinite(at.getTime()))
        throw new Error("Execution-health timestamp is invalid");
      const failures = await this.readFailures();
      let latest: ExecutionCooldown | undefined;
      for (const failure of failures) {
        if (
          failure.marketSlug !== order.marketSlug ||
          failure.side !== order.side ||
          failure.action !== order.action
        )
          continue;
        const duration = this.cooldownMilliseconds[failure.failureCode] ?? 0;
        if (duration === 0) continue;
        const until = Date.parse(failure.observedAt) + duration;
        if (!Number.isFinite(new Date(until).getTime()))
          throw new RangeError(
            "Execution cooldown timestamp is outside the supported range",
          );
        if (until <= at.getTime()) continue;
        const retryAfter = new Date(until).toISOString();
        if (latest === undefined || retryAfter > latest.retryAfter)
          latest = { failureCode: failure.failureCode, retryAfter };
      }
      return latest;
    });
  }

  public recordFailure(failure: ExecutionFailure): Promise<void> {
    const result = this.queue.then(async () => {
      const parsed = FailureSchema.parse(failure);
      const current = await this.readFailures();
      // Retain the most recent observation of each market/code pair. Separate
      // codes must not cancel a longer cooldown recorded earlier.
      const failures = [parsed, ...current]
        .toSorted(
          (left, right) =>
            Date.parse(right.observedAt) - Date.parse(left.observedAt),
        )
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.marketSlug === entry.marketSlug &&
                candidate.side === entry.side &&
                candidate.action === entry.action &&
                candidate.failureCode === entry.failureCode,
            ) === index,
        )
        .slice(0, MAXIMUM_RECORDS);
      const contents = `${JSON.stringify({ version: 1, exchangeId: this.exchangeId, accountScope: this.accountScope, failures }, null, 2)}\n`;
      if (Buffer.byteLength(contents, "utf8") > MAXIMUM_BYTES)
        throw new Error("Execution-health snapshot exceeds its size limit");
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
