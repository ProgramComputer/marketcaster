import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ExchangeId, RuntimeMode } from "../domain/primitives.js";
import { assertSafeMemoryScope } from "../exchanges/memory-scope.js";
import { writeJsonArtifact } from "./artifact.js";

const SCHEMA_VERSION = 1 as const;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RunJournalStage =
  | "STARTED"
  | "DECIDED"
  | "VALIDATED"
  | "EXECUTING"
  | "RECONCILING"
  | "SUCCESS"
  | "PASS"
  | "AMBIGUOUS"
  | "SAFETY_STOP"
  | "FAILED";

export type TerminalRunJournalStage = Extract<
  RunJournalStage,
  "SUCCESS" | "PASS" | "AMBIGUOUS" | "SAFETY_STOP" | "FAILED"
>;

export type CompletedRunJournalStage = Exclude<
  TerminalRunJournalStage,
  "FAILED"
>;

export interface RunJournalHistoryEntry {
  readonly stage: RunJournalStage;
  readonly recordedAt: string;
  readonly details?: unknown;
}

export interface RunJournalManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly exchangeId: ExchangeId;
  readonly accountScope?: string;
  readonly stage: RunJournalStage;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly history: readonly RunJournalHistoryEntry[];
  readonly artifacts: Readonly<Record<string, string>>;
}

export interface RunArtifactEnvelope<T = unknown> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly cycleId: string;
  readonly accountScope?: string;
  readonly recordedAt: string;
  readonly kind: string;
  readonly data: T;
}

export interface CurrentRunPointer {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly cycleId: string;
  readonly accountScope?: string;
  readonly status: TerminalRunJournalStage;
  readonly completedAt: string;
  readonly runDirectory: string;
  readonly manifest: string;
}

export interface CreateRunJournalInput {
  readonly rootDirectory: string;
  readonly runId: string;
  readonly cycleId: string;
  readonly mode: RuntimeMode;
  readonly exchangeId: ExchangeId;
  readonly accountScope?: string;
  readonly now?: () => Date;
}

export interface RecordArtifactOptions {
  readonly filename?: string;
}

export interface ExecutionJournal {
  allocateOrderAttemptId(attemptSequence?: number): string;
  recordOrderIntent(attemptId: string, value: unknown): Promise<string>;
  recordOrderSubmission(attemptId: string, value: unknown): Promise<string>;
  recordOrderReconciliation(attemptId: string, value: unknown): Promise<string>;
}

const allowedTransitions: Readonly<
  Record<RunJournalStage, ReadonlySet<RunJournalStage>>
> = {
  STARTED: new Set(["DECIDED", "FAILED"]),
  DECIDED: new Set(["VALIDATED", "FAILED"]),
  VALIDATED: new Set([
    "EXECUTING",
    "RECONCILING",
    "PASS",
    "SAFETY_STOP",
    "FAILED",
  ]),
  EXECUTING: new Set(["RECONCILING", "AMBIGUOUS", "FAILED"]),
  RECONCILING: new Set([
    "SUCCESS",
    "PASS",
    "AMBIGUOUS",
    "SAFETY_STOP",
    "FAILED",
  ]),
  SUCCESS: new Set(),
  PASS: new Set(),
  AMBIGUOUS: new Set(),
  SAFETY_STOP: new Set(),
  FAILED: new Set(),
};

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not a safe journal path segment`);
  }
}

export function decisionTranscriptRoundArtifactKind(round: number): string {
  if (!Number.isSafeInteger(round) || round <= 0) {
    throw new RangeError(
      "Decision transcript round must be a positive integer",
    );
  }
  return `decision-transcript.round-${round.toString().padStart(4, "0")}`;
}

function toPortableRelativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

export function isTerminalRunJournalStage(
  stage: RunJournalStage,
): stage is TerminalRunJournalStage {
  return ["SUCCESS", "PASS", "AMBIGUOUS", "SAFETY_STOP", "FAILED"].includes(
    stage,
  );
}

export class RunJournal implements ExecutionJournal {
  public readonly rootDirectory: string;
  public readonly runDirectory: string;

  private manifest: RunJournalManifest;
  private manifestQueue: Promise<void> = Promise.resolve();
  private orderAttemptSequence = 0;

  private constructor(
    private readonly input: CreateRunJournalInput,
    manifest: RunJournalManifest,
  ) {
    this.rootDirectory = resolve(process.cwd(), input.rootDirectory);
    this.runDirectory = resolve(
      this.rootDirectory,
      "runs",
      input.runId,
      input.cycleId,
    );
    this.manifest = manifest;
  }

  public static async create(
    input: CreateRunJournalInput,
  ): Promise<RunJournal> {
    assertSafeName(input.runId, "runId");
    assertSafeName(input.cycleId, "cycleId");
    const rootDirectory = resolve(process.cwd(), input.rootDirectory);
    const runDirectory = resolve(
      rootDirectory,
      "runs",
      input.runId,
      input.cycleId,
    );
    await mkdir(dirname(runDirectory), { recursive: true });
    await mkdir(runDirectory);

    const recordedAt = (input.now ?? (() => new Date()))().toISOString();
    const accountScope =
      input.accountScope === undefined
        ? undefined
        : assertSafeMemoryScope(input.accountScope);
    const manifest: RunJournalManifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: input.runId,
      cycleId: input.cycleId,
      mode: input.mode,
      exchangeId: input.exchangeId,
      ...(accountScope === undefined ? {} : { accountScope }),
      stage: "STARTED",
      startedAt: recordedAt,
      updatedAt: recordedAt,
      history: [{ stage: "STARTED", recordedAt }],
      artifacts: {},
    };
    const journal = new RunJournal(input, manifest);
    await journal.writeManifest(manifest);
    return journal;
  }

  public get currentManifest(): RunJournalManifest {
    return this.manifest;
  }

  public allocateOrderAttemptId(attemptSequence?: number): string {
    if (isTerminalRunJournalStage(this.manifest.stage)) {
      throw new Error(
        "Cannot allocate an order attempt after journal completion",
      );
    }
    const nextSequence = attemptSequence ?? this.orderAttemptSequence + 1;
    if (
      !Number.isSafeInteger(nextSequence) ||
      nextSequence <= this.orderAttemptSequence
    ) {
      throw new Error("Order attempt sequence must increase monotonically");
    }
    this.orderAttemptSequence = nextSequence;
    return this.orderAttemptSequence.toString().padStart(4, "0");
  }

  public async recordArtifact(
    kind: string,
    value: unknown,
    options: RecordArtifactOptions = {},
  ): Promise<string> {
    assertSafeName(kind, "Artifact kind");
    if (isTerminalRunJournalStage(this.manifest.stage)) {
      throw new Error("Cannot record an artifact after journal completion");
    }
    const filename = options.filename ?? `${kind}.json`;
    const recordedAt = this.now().toISOString();
    const envelope: RunArtifactEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      runId: this.input.runId,
      cycleId: this.input.cycleId,
      ...(this.manifest.accountScope === undefined
        ? {}
        : { accountScope: this.manifest.accountScope }),
      recordedAt,
      kind,
      data: value,
    };
    const path = await writeJsonArtifact(
      this.runDirectory,
      filename,
      envelope,
      { overwrite: false },
    );
    const relativePath = toPortableRelativePath(this.runDirectory, path);
    await this.enqueueManifestUpdate(async () => {
      const nextManifest: RunJournalManifest = {
        ...this.manifest,
        updatedAt: this.now().toISOString(),
        artifacts: {
          ...this.manifest.artifacts,
          [kind]: relativePath,
        },
      };
      await this.writeManifest(nextManifest);
      this.manifest = nextManifest;
    });
    return path;
  }

  public recordOrderIntent(attemptId: string, value: unknown): Promise<string> {
    return this.recordOrderArtifact(attemptId, "intent", value);
  }

  public recordOrderSubmission(
    attemptId: string,
    value: unknown,
  ): Promise<string> {
    return this.recordOrderArtifact(attemptId, "submission", value);
  }

  public recordOrderReconciliation(
    attemptId: string,
    value: unknown,
  ): Promise<string> {
    return this.recordOrderArtifact(attemptId, "reconciliation", value);
  }

  public async transition(
    stage: Exclude<RunJournalStage, TerminalRunJournalStage>,
    details?: unknown,
  ): Promise<void> {
    await this.transitionTo(stage, details);
  }

  public async complete(
    status: CompletedRunJournalStage,
    details?: unknown,
  ): Promise<void> {
    await this.transitionTo(status, details);
    await this.publishCurrentPointer();
  }

  public async fail(failure: unknown, details?: unknown): Promise<void> {
    if (isTerminalRunJournalStage(this.manifest.stage)) {
      await this.publishCurrentPointer();
      return;
    }
    await this.recordArtifact("cycle-error", failure);
    await this.transitionTo("FAILED", details);
    await this.publishCurrentPointer();
  }

  public async markAmbiguous(
    failure: unknown,
    details?: unknown,
  ): Promise<void> {
    if (isTerminalRunJournalStage(this.manifest.stage)) {
      await this.publishCurrentPointer();
      return;
    }
    await this.recordArtifact("cycle-error", failure);
    await this.transitionTo("AMBIGUOUS", details);
    await this.publishCurrentPointer();
  }

  public async publishCurrentPointer(): Promise<string> {
    const manifest = this.manifest;
    if (
      !isTerminalRunJournalStage(manifest.stage) ||
      manifest.completedAt === undefined
    ) {
      throw new Error("Only a terminal journal can become current");
    }
    const pointer: CurrentRunPointer = {
      schemaVersion: SCHEMA_VERSION,
      runId: manifest.runId,
      cycleId: manifest.cycleId,
      ...(manifest.accountScope === undefined
        ? {}
        : { accountScope: manifest.accountScope }),
      status: manifest.stage,
      completedAt: manifest.completedAt,
      runDirectory: toPortableRelativePath(
        this.rootDirectory,
        this.runDirectory,
      ),
      manifest: toPortableRelativePath(
        this.rootDirectory,
        resolve(this.runDirectory, "manifest.json"),
      ),
    };
    return writeJsonArtifact(
      resolve(this.rootDirectory, "current"),
      "index.json",
      pointer,
    );
  }

  private now(): Date {
    return (this.input.now ?? (() => new Date()))();
  }

  private async recordOrderArtifact(
    attemptId: string,
    phase: "intent" | "submission" | "reconciliation",
    value: unknown,
  ): Promise<string> {
    assertSafeName(attemptId, "Order attempt ID");
    return this.recordArtifact(`order.${attemptId}.${phase}`, value, {
      filename: `orders/${attemptId}-${phase}.json`,
    });
  }

  private async transitionTo(
    stage: RunJournalStage,
    details?: unknown,
  ): Promise<void> {
    await this.enqueueManifestUpdate(async () => {
      if (stage === this.manifest.stage) return;
      if (!allowedTransitions[this.manifest.stage].has(stage)) {
        throw new Error(
          `Invalid journal transition from ${this.manifest.stage} to ${stage}`,
        );
      }
      const recordedAt = this.now().toISOString();
      const historyEntry: RunJournalHistoryEntry = {
        stage,
        recordedAt,
        ...(details === undefined ? {} : { details }),
      };
      const nextManifest: RunJournalManifest = {
        ...this.manifest,
        stage,
        updatedAt: recordedAt,
        ...(isTerminalRunJournalStage(stage)
          ? { completedAt: recordedAt }
          : {}),
        history: [...this.manifest.history, historyEntry],
      };
      await this.writeManifest(nextManifest);
      this.manifest = nextManifest;
    });
  }

  private enqueueManifestUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.manifestQueue.then(operation);
    this.manifestQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private writeManifest(manifest: RunJournalManifest): Promise<string> {
    return writeJsonArtifact(this.runDirectory, "manifest.json", manifest);
  }
}

export function createRunJournal(
  input: CreateRunJournalInput,
): Promise<RunJournal> {
  return RunJournal.create(input);
}
