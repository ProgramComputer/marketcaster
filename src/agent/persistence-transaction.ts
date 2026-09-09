import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { canonicalEvidenceUrl } from "./evidence-provenance.js";

const TransactionManifestSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("PREPARED"),
    entries: z.array(
      z
        .object({
          target: z.string().min(1),
          staged: z.string().min(1),
          backup: z.string().min(1),
          hadTarget: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const MigrationMarkerSchema = z
  .object({
    version: z.literal(2),
    migratedAt: z.iso.datetime({ offset: true }),
    quarantined: z.array(z.string()),
  })
  .strict();

type TransactionManifest = z.infer<typeof TransactionManifestSchema>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function rollbackManifest(
  manifestPath: string,
  manifest: TransactionManifest,
): Promise<void> {
  for (const entry of manifest.entries) {
    if (await exists(entry.backup)) {
      if (await exists(entry.target)) await unlink(entry.target);
      await rename(entry.backup, entry.target);
    } else if (!entry.hadTarget && (await exists(entry.target))) {
      await unlink(entry.target);
    }
    if (await exists(entry.staged)) await unlink(entry.staged);
  }
  await unlink(manifestPath).catch(() => undefined);
}

async function recoverInterruptedTransaction(
  manifestPath: string,
): Promise<void> {
  if (!(await exists(manifestPath))) return;
  const parsed = TransactionManifestSchema.safeParse(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new Error("Invalid staged-persistence recovery manifest");
  }
  await rollbackManifest(manifestPath, parsed.data);
}

export interface PersistenceTransactionOptions {
  readonly memoryFilePath: string;
  readonly stateFilePath: string;
  readonly stagingDirectory: string;
  readonly migrationMarkerPath: string;
  readonly manifestPath: string;
  readonly additionalLegacyFilePaths?: readonly string[];
  readonly cycleId: string;
  readonly now?: () => Date;
}

interface TransactionEntry {
  readonly target: string;
  readonly staged: string;
}

/** Durable two-file staging transaction for model-authored notes and state. */
export class PersistenceTransaction {
  public readonly stagedMemoryFilePath: string;
  public readonly stagedStateFilePath: string;
  public readonly legacyQuarantined: boolean;
  readonly #manifestPath: string;
  readonly #cycleId: string;
  readonly #entries: readonly TransactionEntry[];
  #mutated = false;
  #closed = false;

  private constructor(input: {
    readonly stagedMemoryFilePath: string;
    readonly stagedStateFilePath: string;
    readonly legacyQuarantined: boolean;
    readonly manifestPath: string;
    readonly cycleId: string;
    readonly entries: readonly TransactionEntry[];
  }) {
    this.stagedMemoryFilePath = input.stagedMemoryFilePath;
    this.stagedStateFilePath = input.stagedStateFilePath;
    this.legacyQuarantined = input.legacyQuarantined;
    this.#manifestPath = input.manifestPath;
    this.#cycleId = input.cycleId;
    this.#entries = input.entries;
  }

  public static async begin(
    options: PersistenceTransactionOptions,
  ): Promise<PersistenceTransaction> {
    if (!/^[A-Za-z0-9._-]+$/u.test(options.cycleId)) {
      throw new TypeError("Persistence transaction cycleId is not path-safe");
    }
    const memoryFilePath = resolve(options.memoryFilePath);
    const stateFilePath = resolve(options.stateFilePath);
    const stagingDirectory = resolve(options.stagingDirectory);
    const migrationMarkerPath = resolve(options.migrationMarkerPath);
    const manifestPath = resolve(options.manifestPath);
    await recoverInterruptedTransaction(manifestPath);

    let legacyQuarantined = false;
    if (await exists(migrationMarkerPath)) {
      const marker = MigrationMarkerSchema.safeParse(
        JSON.parse(await readFile(migrationMarkerPath, "utf8")) as unknown,
      );
      if (!marker.success) {
        throw new Error("Invalid evidence-provenance migration marker");
      }
    } else {
      legacyQuarantined = true;
      const migratedAt = (options.now ?? (() => new Date()))();
      const timestamp = migratedAt.toISOString().replaceAll(":", "-");
      const quarantined: string[] = [];
      const legacyPaths = [
        memoryFilePath,
        stateFilePath,
        ...(options.additionalLegacyFilePaths ?? []).map((path) =>
          resolve(path),
        ),
      ];
      for (const path of new Set(legacyPaths)) {
        if (!(await exists(path))) continue;
        const quarantine = `${path}.${timestamp}.${options.cycleId}.legacy-v1.quarantine`;
        await rename(path, quarantine);
        quarantined.push(quarantine);
      }
      await writeJsonAtomic(migrationMarkerPath, {
        version: 2,
        migratedAt: migratedAt.toISOString(),
        quarantined,
      });
    }

    await mkdir(stagingDirectory, { recursive: true });
    const stagedMemoryFilePath = resolve(
      stagingDirectory,
      `${options.cycleId}.notes.jsonl`,
    );
    const stagedStateFilePath = resolve(
      stagingDirectory,
      `${options.cycleId}.state.json`,
    );
    const entries: readonly TransactionEntry[] = [
      { target: memoryFilePath, staged: stagedMemoryFilePath },
      { target: stateFilePath, staged: stagedStateFilePath },
    ];
    for (const entry of entries) {
      if (await exists(entry.staged)) await unlink(entry.staged);
      if (await exists(entry.target))
        await copyFile(entry.target, entry.staged);
    }
    return new PersistenceTransaction({
      stagedMemoryFilePath,
      stagedStateFilePath,
      legacyQuarantined,
      manifestPath,
      cycleId: options.cycleId,
      entries,
    });
  }

  public markMutated(): void {
    if (this.#closed) throw new Error("Persistence transaction is closed");
    this.#mutated = true;
  }

  public async commit(): Promise<void> {
    if (this.#closed) throw new Error("Persistence transaction is closed");
    if (!this.#mutated) {
      await this.discard();
      return;
    }
    const manifest: TransactionManifest = {
      version: 1,
      status: "PREPARED",
      entries: await Promise.all(
        this.#entries.map(async (entry, index) => ({
          ...entry,
          backup: `${entry.target}.${this.#cycleId}.${index}.transaction-backup`,
          hadTarget: await exists(entry.target),
        })),
      ),
    };
    await writeJsonAtomic(this.#manifestPath, manifest);
    try {
      for (const entry of manifest.entries) {
        await mkdir(dirname(entry.target), { recursive: true });
        if (entry.hadTarget) await rename(entry.target, entry.backup);
        if (await exists(entry.staged))
          await rename(entry.staged, entry.target);
      }
      // Removing the manifest is the commit point. Backups must remain intact
      // until then so recovery can never restore only part of the pair.
      await unlink(this.#manifestPath);
      for (const entry of manifest.entries) {
        await unlink(entry.backup).catch(() => undefined);
      }
      this.#closed = true;
    } catch (error) {
      await rollbackManifest(this.#manifestPath, manifest);
      this.#closed = true;
      throw error;
    }
  }

  public async discard(): Promise<void> {
    if (this.#closed) return;
    for (const entry of this.#entries) {
      await unlink(entry.staged).catch(() => undefined);
    }
    this.#closed = true;
  }
}

export type StagedMutationKind = "NOTE" | "BELIEF" | "PLAN" | "DESTRUCTIVE";

export interface StagedMutationReference {
  readonly kind: StagedMutationKind;
  readonly action: string;
  /** Stable identity of the final persisted object this mutation changes. */
  readonly identity?: string;
  readonly evidenceUrls: readonly string[];
  readonly basisMarketSlugs: readonly string[];
}

export interface MutationProvenanceIssue {
  readonly action: string;
  readonly code: "UNOBSERVED_EVIDENCE" | "UNINSPECTED_MARKET" | "MISSING_BASIS";
  readonly field: "evidenceUrls" | "basisMarketSlugs" | "provenance";
  readonly references?: readonly string[];
  readonly message: string;
}

export interface MutationProvenanceReport {
  readonly valid: boolean;
  readonly mutationCount: number;
  readonly issues: readonly MutationProvenanceIssue[];
}

export interface MutationProvenanceContext {
  readonly observedCurrentUrls: ReadonlySet<string>;
  readonly currentCycleMarketBasisSlugs: ReadonlySet<string>;
}

/** Runs against the effective normalized object, before any persistence write. */
export type StagedMutationValidator = (
  reference: StagedMutationReference,
) => void;

export function validateMutationProvenance(
  mutation: StagedMutationReference,
  input: MutationProvenanceContext,
): readonly MutationProvenanceIssue[] {
  if (mutation.kind === "DESTRUCTIVE") return [];
  const issues: MutationProvenanceIssue[] = [];
  const unknownEvidence = mutation.evidenceUrls.filter((url) => {
    try {
      return !input.observedCurrentUrls.has(canonicalEvidenceUrl(url));
    } catch {
      return true;
    }
  });
  const unknownMarkets = mutation.basisMarketSlugs.filter(
    (slug) => !input.currentCycleMarketBasisSlugs.has(slug),
  );
  if (unknownEvidence.length > 0) {
    issues.push({
      action: mutation.action,
      code: "UNOBSERVED_EVIDENCE",
      field: "evidenceUrls",
      references: unknownEvidence,
      message:
        "Use evidence URLs observed during this cycle; replace or remove unobserved references.",
    });
  }
  if (unknownMarkets.length > 0) {
    issues.push({
      action: mutation.action,
      code: "UNINSPECTED_MARKET",
      field: "basisMarketSlugs",
      references: unknownMarkets,
      message:
        "Inspect the referenced markets first, or use a preloaded held market as the explicit basis.",
    });
  }
  if (
    mutation.evidenceUrls.length === unknownEvidence.length &&
    mutation.basisMarketSlugs.length === unknownMarkets.length
  ) {
    issues.push({
      action: mutation.action,
      code: "MISSING_BASIS",
      field: "provenance",
      message:
        "Supply at least one current-cycle evidence URL in evidenceUrls or an inspected/preloaded held market in basisMarketSlugs; marketSlugs alone is not provenance.",
    });
  }
  return issues;
}

export class MutationProvenanceError extends Error {
  public constructor(
    public readonly issues: readonly MutationProvenanceIssue[],
  ) {
    super(
      "Memory change was not staged. Correct its provenance and retry within the remaining tool budget.",
    );
    this.name = "MutationProvenanceError";
  }
}

export class StagedMutationLedger {
  readonly #mutations: StagedMutationReference[] = [];

  public record(reference: StagedMutationReference): void {
    const normalized = {
      ...reference,
      evidenceUrls: [...new Set(reference.evidenceUrls)],
      basisMarketSlugs: [...new Set(reference.basisMarketSlugs)],
    };
    const existingIndex =
      reference.identity === undefined
        ? -1
        : this.#mutations.findIndex(
            (mutation) => mutation.identity === reference.identity,
          );
    if (existingIndex < 0) {
      this.#mutations.push(normalized);
    } else {
      // The staged files already contain the latest mutation. Provenance must
      // review that same effective state, rather than permanently rejecting a
      // draft that the model subsequently repaired in this transaction.
      this.#mutations[existingIndex] = normalized;
    }
  }

  public validate(input: MutationProvenanceContext): MutationProvenanceReport {
    const issues = this.#mutations.flatMap((mutation) =>
      validateMutationProvenance(mutation, input),
    );
    return {
      valid: issues.length === 0,
      mutationCount: this.#mutations.length,
      issues,
    };
  }
}
