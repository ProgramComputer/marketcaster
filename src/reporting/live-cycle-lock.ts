import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExchangeId } from "../domain/primitives.js";

const SCHEMA_VERSION = 1 as const;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LiveCycleLockOwner {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly exchangeId: ExchangeId;
  readonly token: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly acquiredAt: string;
}

export interface AcquireLiveCycleLockInput {
  readonly rootDirectory: string;
  readonly exchangeId: ExchangeId;
  readonly runId: string;
  readonly cycleId: string;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export type LiveCycleLockErrorCode =
  | "INVALID_IDENTITY"
  | "LOCK_HELD"
  | "LOCK_CORRUPT"
  | "LOCK_MISSING"
  | "NOT_OWNER"
  | "LOCK_IO";

export class LiveCycleLockError extends Error {
  public constructor(
    public readonly code: LiveCycleLockErrorCode,
    message: string,
    public readonly lockPath: string,
    public readonly owner?: LiveCycleLockOwner,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LiveCycleLockError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function safeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseOwner(value: unknown): LiveCycleLockOwner | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !["polymarket-us", "polymarket-international", "kalshi"].includes(
      typeof value.exchangeId === "string" ? value.exchangeId : "",
    ) ||
    typeof value.token !== "string" ||
    !safeSegment(value.token) ||
    typeof value.runId !== "string" ||
    !safeSegment(value.runId) ||
    typeof value.cycleId !== "string" ||
    !safeSegment(value.cycleId) ||
    typeof value.acquiredAt !== "string" ||
    !validTimestamp(value.acquiredAt)
  ) {
    return undefined;
  }
  return value as unknown as LiveCycleLockOwner;
}

function lockPathFor(rootDirectory: string, exchangeId: string): string {
  if (!safeSegment(exchangeId)) {
    throw new LiveCycleLockError(
      "INVALID_IDENTITY",
      "Exchange ID is not a safe lock path segment",
      resolve(process.cwd(), rootDirectory),
    );
  }
  const resolvedRoot = resolve(process.cwd(), rootDirectory);
  const locksDirectory = resolve(resolvedRoot, "locks");
  const lockPath = resolve(locksDirectory, `${exchangeId}.lock`);
  const pathWithinDirectory = relative(locksDirectory, lockPath);
  if (
    pathWithinDirectory.length === 0 ||
    pathWithinDirectory.startsWith("..") ||
    isAbsolute(pathWithinDirectory) ||
    pathWithinDirectory.includes(":")
  ) {
    throw new LiveCycleLockError(
      "INVALID_IDENTITY",
      "Live-cycle lock path escaped the reporting root",
      lockPath,
    );
  }
  return lockPath;
}

async function readOwner(lockPath: string): Promise<LiveCycleLockOwner> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new LiveCycleLockError(
        "LOCK_MISSING",
        "Live-cycle lock disappeared before ownership could be verified",
        lockPath,
        undefined,
        { cause: error },
      );
    }
    throw new LiveCycleLockError(
      "LOCK_CORRUPT",
      "Existing live-cycle lock is corrupt or unreadable",
      lockPath,
      undefined,
      { cause: error },
    );
  }
  const owner = parseOwner(value);
  if (owner === undefined) {
    throw new LiveCycleLockError(
      "LOCK_CORRUPT",
      "Existing live-cycle lock has an invalid owner record",
      lockPath,
    );
  }
  return owner;
}

function sameOwner(
  left: LiveCycleLockOwner,
  right: LiveCycleLockOwner,
): boolean {
  return (
    left.exchangeId === right.exchangeId &&
    left.token === right.token &&
    left.runId === right.runId &&
    left.cycleId === right.cycleId &&
    left.acquiredAt === right.acquiredAt
  );
}

export class LiveCycleLock {
  private releasePromise: Promise<void> | undefined;
  private released = false;

  public constructor(
    public readonly path: string,
    public readonly owner: LiveCycleLockOwner,
  ) {}

  public async release(): Promise<void> {
    if (this.released) return;
    this.releasePromise ??= this.releaseOnce();
    try {
      await this.releasePromise;
    } catch (error) {
      this.releasePromise = undefined;
      throw error;
    }
  }

  private async releaseOnce(): Promise<void> {
    const currentOwner = await readOwner(this.path);
    if (!sameOwner(currentOwner, this.owner)) {
      throw new LiveCycleLockError(
        "NOT_OWNER",
        "Live-cycle lock owner changed; refusing to remove it",
        this.path,
        currentOwner,
      );
    }
    try {
      await unlink(this.path);
    } catch (error) {
      const code: LiveCycleLockErrorCode = isErrnoCode(error, "ENOENT")
        ? "LOCK_MISSING"
        : "LOCK_IO";
      throw new LiveCycleLockError(
        code,
        "Could not release the owned live-cycle lock",
        this.path,
        currentOwner,
        { cause: error },
      );
    }
    this.released = true;
  }
}

export async function acquireLiveCycleLock(
  input: AcquireLiveCycleLockInput,
): Promise<LiveCycleLock> {
  const lockPath = lockPathFor(input.rootDirectory, input.exchangeId);
  if (!safeSegment(input.runId) || !safeSegment(input.cycleId)) {
    throw new LiveCycleLockError(
      "INVALID_IDENTITY",
      "Run and cycle IDs must be safe lock-owner values",
      lockPath,
    );
  }
  const token = (input.tokenFactory ?? randomUUID)();
  if (!safeSegment(token)) {
    throw new LiveCycleLockError(
      "INVALID_IDENTITY",
      "Generated lock token is invalid",
      lockPath,
    );
  }
  const acquiredAt = (input.now ?? (() => new Date()))().toISOString();
  if (!validTimestamp(acquiredAt)) {
    throw new LiveCycleLockError(
      "INVALID_IDENTITY",
      "Lock acquisition timestamp is invalid",
      lockPath,
    );
  }
  const owner: LiveCycleLockOwner = {
    schemaVersion: SCHEMA_VERSION,
    exchangeId: input.exchangeId,
    token,
    runId: input.runId,
    cycleId: input.cycleId,
    acquiredAt,
  };
  const locksDirectory = resolve(lockPath, "..");
  try {
    await mkdir(locksDirectory, { recursive: true });
    const status = await lstat(locksDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Lock directory is not a physical directory");
    }
  } catch (error) {
    throw new LiveCycleLockError(
      "LOCK_IO",
      "Could not prepare the live-cycle lock directory",
      lockPath,
      undefined,
      { cause: error },
    );
  }

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      try {
        const existingOwner = await readOwner(lockPath);
        throw new LiveCycleLockError(
          "LOCK_HELD",
          `A live cycle already holds the ${input.exchangeId} lock`,
          lockPath,
          existingOwner,
        );
      } catch (ownerError) {
        if (ownerError instanceof LiveCycleLockError) throw ownerError;
        throw new LiveCycleLockError(
          "LOCK_CORRUPT",
          "Existing live-cycle lock could not be verified",
          lockPath,
          undefined,
          { cause: ownerError },
        );
      }
    }
    throw new LiveCycleLockError(
      "LOCK_IO",
      "Could not atomically acquire the live-cycle lock",
      lockPath,
      undefined,
      { cause: error },
    );
  }

  try {
    await handle.writeFile(`${JSON.stringify(owner, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Deliberately retain an incomplete lock. Its existence fails closed and
    // requires explicit operator review rather than an unsafe stale-lock guess.
    throw new LiveCycleLockError(
      "LOCK_IO",
      "The live-cycle lock was created but its owner record was not durable",
      lockPath,
      undefined,
      { cause: error },
    );
  }
  return new LiveCycleLock(lockPath, owner);
}
