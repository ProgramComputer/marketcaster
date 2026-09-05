import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { redactPotentialSecrets } from "../utilities/redaction.js";

export const AGENT_BELIEF_TYPES = [
  "EVENT_ANALYSIS",
  "MARKET_STRUCTURE",
  "MARKET_SENTIMENT",
  "RISK_ASSESSMENT",
  "TRADING_STRATEGY",
] as const;

export type AgentBeliefType = (typeof AGENT_BELIEF_TYPES)[number];

export const AGENT_BELIEF_STATUSES = [
  "ACTIVE",
  "INVALIDATED",
  "SUPERSEDED",
] as const;
export type AgentBeliefStatus = (typeof AGENT_BELIEF_STATUSES)[number];

interface EvidenceReferences {
  readonly evidenceUrls?: readonly string[] | undefined;
  readonly basisMarketSlugs?: readonly string[] | undefined;
}

interface BeliefLifecycle {
  /** Omitted status preserves the behavior of existing active beliefs. */
  readonly status?: AgentBeliefStatus | undefined;
  readonly supersedesBeliefId?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  /** A review reminder; does not expire or invalidate the belief. */
  readonly reviewAt?: string | null | undefined;
}

export interface AgentBelief extends EvidenceReferences, BeliefLifecycle {
  readonly id: string;
  readonly type: AgentBeliefType;
  readonly confidence: number;
  readonly content: string;
  readonly marketSlugs: readonly string[];
  readonly evidenceUpdatedAt: string;
  readonly invalidationConditions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentPlan extends EvidenceReferences {
  readonly content: string;
  readonly marketSlugs: readonly string[];
  readonly updatedAt: string;
  readonly reviewAt?: string | null | undefined;
}

export type AgentStateContext =
  | {
      readonly mode: "STATELESS";
      readonly beliefs: readonly [];
      readonly nextCyclePlan: null;
      readonly longTermPlan: null;
    }
  | {
      readonly mode: "PERSISTENT";
      readonly beliefs: readonly AgentBelief[];
      readonly nextCyclePlan: AgentPlan | null;
      readonly longTermPlan: AgentPlan | null;
      readonly totalBeliefCount: number;
      readonly inactiveBeliefCount?: number;
      readonly truncated: boolean;
      readonly maximumBeliefs: number;
      readonly maximumContextBeliefs: number;
      readonly maximumBeliefCharacters: number;
      readonly maximumPlanCharacters: number;
    };

interface NewAgentBelief extends EvidenceReferences, BeliefLifecycle {
  readonly type: AgentBeliefType;
  readonly confidence: number;
  readonly content: string;
  readonly marketSlugs: readonly string[];
  readonly evidenceUpdatedAt: string;
  readonly invalidationConditions: readonly string[];
}

export type AgentStateOperation =
  | { readonly action: "LIST"; readonly cursor?: string | undefined }
  | ({ readonly action: "ADD_BELIEF" } & NewAgentBelief)
  | (EvidenceReferences &
      BeliefLifecycle & {
        readonly action: "UPDATE_BELIEF";
        readonly beliefId: string;
        readonly type?: AgentBeliefType | undefined;
        readonly confidence?: number | undefined;
        readonly content?: string | undefined;
        readonly marketSlugs?: readonly string[] | undefined;
        readonly evidenceUpdatedAt?: string | undefined;
        readonly invalidationConditions?: readonly string[] | undefined;
      })
  | { readonly action: "DELETE_BELIEF"; readonly beliefId: string }
  | {
      readonly action: "SET_NEXT_CYCLE_PLAN";
      readonly content: string;
      readonly marketSlugs: readonly string[];
      readonly evidenceUrls?: readonly string[];
      readonly basisMarketSlugs?: readonly string[];
      readonly reviewAt?: string | null | undefined;
    }
  | {
      readonly action: "SET_LONG_TERM_PLAN";
      readonly content: string;
      readonly marketSlugs: readonly string[];
      readonly evidenceUrls?: readonly string[];
      readonly basisMarketSlugs?: readonly string[];
      readonly reviewAt?: string | null | undefined;
    }
  | { readonly action: "CLEAR_NEXT_CYCLE_PLAN" };

export interface AgentStateOperationResult {
  readonly action: AgentStateOperation["action"];
  readonly mutatedBeliefId?: string;
  readonly beliefs: readonly AgentBelief[];
  readonly nextCyclePlan: AgentPlan | null;
  readonly longTermPlan: AgentPlan | null;
  readonly totalBeliefCount: number;
  readonly truncated: boolean;
  readonly eof: boolean;
  readonly nextCursor?: string;
}

export interface AgentState {
  readonly persistent: boolean;
  load(): Promise<AgentStateContext>;
  manage(
    operation: AgentStateOperation,
    signal?: AbortSignal,
  ): Promise<AgentStateOperationResult>;
}

const STATELESS_CONTEXT: AgentStateContext = Object.freeze({
  mode: "STATELESS",
  beliefs: [] as const,
  nextCyclePlan: null,
  longTermPlan: null,
});

export class StatelessAgentState implements AgentState {
  public readonly persistent = false as const;

  public load(): Promise<AgentStateContext> {
    return Promise.resolve(STATELESS_CONTEXT);
  }

  public manage(
    _operation: AgentStateOperation,
    _signal?: AbortSignal,
  ): Promise<AgentStateOperationResult> {
    void _operation;
    void _signal;
    return Promise.reject(new Error("Persistent agent state is disabled"));
  }
}

const TimestampSchema = z.iso.datetime({ offset: true });
const BeliefTypeSchema = z.enum(AGENT_BELIEF_TYPES);
const NonEmptyStringSchema = z.string().min(1);
const EvidenceReferenceFields = {
  evidenceUrls: z.array(z.url({ protocol: /^https?$/u })).optional(),
  basisMarketSlugs: z.array(NonEmptyStringSchema).optional(),
};
const BeliefLifecycleFields = {
  status: z.enum(AGENT_BELIEF_STATUSES).optional(),
  supersedesBeliefId: z.uuid().nullable().optional(),
  expiresAt: TimestampSchema.nullable().optional(),
  reviewAt: TimestampSchema.nullable().optional(),
};

const BeliefSchema = z
  .object({
    id: z.uuid(),
    type: BeliefTypeSchema,
    confidence: z.number().int().min(0).max(100),
    content: NonEmptyStringSchema,
    marketSlugs: z.array(NonEmptyStringSchema),
    evidenceUpdatedAt: TimestampSchema,
    invalidationConditions: z.array(NonEmptyStringSchema),
    ...EvidenceReferenceFields,
    ...BeliefLifecycleFields,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

const PlanSchema = z
  .object({
    content: NonEmptyStringSchema,
    marketSlugs: z.array(NonEmptyStringSchema),
    ...EvidenceReferenceFields,
    updatedAt: TimestampSchema,
    reviewAt: TimestampSchema.nullable().optional(),
  })
  .strict();

const SnapshotV1Schema = z
  .object({
    version: z.literal(1),
    beliefs: z.array(BeliefSchema),
    nextCyclePlan: PlanSchema.nullable(),
    longTermPlan: PlanSchema.nullable(),
  })
  .strict();

const SnapshotV2Schema = z
  .object({
    version: z.literal(2),
    beliefs: z.array(BeliefSchema),
    nextCyclePlan: PlanSchema.nullable(),
    longTermPlan: PlanSchema.nullable(),
  })
  .strict();

const SnapshotSchema = z.union([SnapshotV2Schema, SnapshotV1Schema]);

interface AgentStateSnapshot {
  readonly version: 2;
  readonly beliefs: readonly AgentBelief[];
  readonly nextCyclePlan: AgentPlan | null;
  readonly longTermPlan: AgentPlan | null;
}

const OperationSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("LIST"), cursor: z.string().optional() })
    .strict(),
  z
    .object({
      action: z.literal("ADD_BELIEF"),
      type: BeliefTypeSchema,
      confidence: z.number().int().min(0).max(100),
      content: z.string(),
      marketSlugs: z.array(z.string()),
      evidenceUpdatedAt: TimestampSchema,
      invalidationConditions: z.array(z.string()),
      ...EvidenceReferenceFields,
      ...BeliefLifecycleFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("UPDATE_BELIEF"),
      beliefId: z.uuid(),
      type: BeliefTypeSchema.optional(),
      confidence: z.number().int().min(0).max(100).optional(),
      content: z.string().optional(),
      marketSlugs: z.array(z.string()).optional(),
      evidenceUpdatedAt: TimestampSchema.optional(),
      invalidationConditions: z.array(z.string()).optional(),
      ...EvidenceReferenceFields,
      ...BeliefLifecycleFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("DELETE_BELIEF"),
      beliefId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("SET_NEXT_CYCLE_PLAN"),
      content: z.string(),
      marketSlugs: z.array(z.string()),
      ...EvidenceReferenceFields,
      reviewAt: TimestampSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("SET_LONG_TERM_PLAN"),
      content: z.string(),
      marketSlugs: z.array(z.string()),
      ...EvidenceReferenceFields,
      reviewAt: TimestampSchema.nullable().optional(),
    })
    .strict(),
  z.object({ action: z.literal("CLEAR_NEXT_CYCLE_PLAN") }).strict(),
]);

type ParsedOperation = z.infer<typeof OperationSchema>;

interface SnapshotRead {
  readonly snapshot: AgentStateSnapshot;
  readonly exists: boolean;
  readonly normalized: boolean;
}

export interface FileAgentStateOptions {
  readonly filePath: string;
  readonly maximumBeliefs?: number;
  readonly maximumContextBeliefs?: number;
  readonly maximumBeliefCharacters?: number;
  readonly maximumPlanCharacters?: number;
  readonly maximumMarketSlugs?: number;
  readonly maximumMarketSlugCharacters?: number;
  readonly maximumInvalidationConditions?: number;
  readonly maximumInvalidationConditionCharacters?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function emptySnapshot(): AgentStateSnapshot {
  return {
    version: 2,
    beliefs: [],
    nextCyclePlan: null,
    longTermPlan: null,
  };
}

export class FileAgentState implements AgentState {
  public readonly persistent = true as const;
  private readonly filePath: string;
  private readonly maximumBeliefs: number;
  private readonly maximumContextBeliefs: number;
  private readonly maximumBeliefCharacters: number;
  private readonly maximumPlanCharacters: number;
  private readonly maximumMarketSlugs: number;
  private readonly maximumMarketSlugCharacters: number;
  private readonly maximumInvalidationConditions: number;
  private readonly maximumInvalidationConditionCharacters: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(options: FileAgentStateOptions) {
    this.filePath = resolve(options.filePath);
    this.maximumBeliefs = positiveInteger(
      options.maximumBeliefs ?? 100,
      "maximumBeliefs",
    );
    this.maximumContextBeliefs = positiveInteger(
      options.maximumContextBeliefs ?? 40,
      "maximumContextBeliefs",
    );
    if (this.maximumContextBeliefs > this.maximumBeliefs) {
      throw new RangeError(
        "maximumContextBeliefs cannot exceed maximumBeliefs",
      );
    }
    this.maximumBeliefCharacters = positiveInteger(
      options.maximumBeliefCharacters ?? 2_000,
      "maximumBeliefCharacters",
    );
    this.maximumPlanCharacters = positiveInteger(
      options.maximumPlanCharacters ?? 4_000,
      "maximumPlanCharacters",
    );
    this.maximumMarketSlugs = positiveInteger(
      options.maximumMarketSlugs ?? 25,
      "maximumMarketSlugs",
    );
    this.maximumMarketSlugCharacters = positiveInteger(
      options.maximumMarketSlugCharacters ?? 300,
      "maximumMarketSlugCharacters",
    );
    this.maximumInvalidationConditions = positiveInteger(
      options.maximumInvalidationConditions ?? 10,
      "maximumInvalidationConditions",
    );
    this.maximumInvalidationConditionCharacters = positiveInteger(
      options.maximumInvalidationConditionCharacters ?? 500,
      "maximumInvalidationConditionCharacters",
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private normalizeText(value: string, label: string, maximum: number): string {
    const sanitized = redactPotentialSecrets(
      Array.from(value, (character) => {
        const code = character.codePointAt(0) ?? 0;
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127
          ? " "
          : character;
      }).join(""),
    ).trim();
    const length = Array.from(sanitized).length;
    if (length === 0 || length > maximum) {
      throw new RangeError(`${label} must contain 1 to ${maximum} characters`);
    }
    return sanitized;
  }

  private normalizeList(
    values: readonly string[],
    label: string,
    maximumItems: number,
    maximumCharacters: number,
  ): string[] {
    if (values.length > maximumItems) {
      throw new RangeError(
        `${label} cannot contain more than ${maximumItems} items`,
      );
    }
    return [
      ...new Set(
        values.map((value) =>
          this.normalizeText(value, `${label} item`, maximumCharacters),
        ),
      ),
    ];
  }

  private canonicalTimestamp(value: string): string {
    return new Date(value).toISOString();
  }

  private timestamp(): string {
    const value = this.now();
    if (Number.isNaN(value.getTime())) {
      throw new Error("Agent-state timestamp is invalid");
    }
    return value.toISOString();
  }

  private normalizeReferences(value: EvidenceReferences): EvidenceReferences {
    return {
      ...(value.evidenceUrls === undefined
        ? {}
        : {
            evidenceUrls: this.normalizeList(
              value.evidenceUrls,
              "Evidence URLs",
              100,
              8_192,
            ),
          }),
      ...(value.basisMarketSlugs === undefined
        ? {}
        : {
            basisMarketSlugs: this.normalizeList(
              value.basisMarketSlugs,
              "Basis marketSlugs",
              this.maximumMarketSlugs,
              this.maximumMarketSlugCharacters,
            ),
          }),
    };
  }

  private normalizeLifecycle(value: BeliefLifecycle): BeliefLifecycle {
    return {
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.supersedesBeliefId === undefined
        ? {}
        : { supersedesBeliefId: value.supersedesBeliefId }),
      ...(value.expiresAt === undefined
        ? {}
        : {
            expiresAt:
              value.expiresAt === null
                ? null
                : this.canonicalTimestamp(value.expiresAt),
          }),
      ...(value.reviewAt === undefined
        ? {}
        : {
            reviewAt:
              value.reviewAt === null
                ? null
                : this.canonicalTimestamp(value.reviewAt),
          }),
    };
  }

  private normalizeBelief(belief: AgentBelief): AgentBelief {
    const createdAt = this.canonicalTimestamp(belief.createdAt);
    const updatedAt = this.canonicalTimestamp(belief.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error("Agent belief updatedAt precedes createdAt");
    }
    return {
      id: belief.id,
      type: belief.type,
      confidence: belief.confidence,
      content: this.normalizeText(
        belief.content,
        "Belief content",
        this.maximumBeliefCharacters,
      ),
      marketSlugs: this.normalizeList(
        belief.marketSlugs,
        "Belief marketSlugs",
        this.maximumMarketSlugs,
        this.maximumMarketSlugCharacters,
      ),
      evidenceUpdatedAt: this.canonicalTimestamp(belief.evidenceUpdatedAt),
      invalidationConditions: this.normalizeList(
        belief.invalidationConditions,
        "Belief invalidationConditions",
        this.maximumInvalidationConditions,
        this.maximumInvalidationConditionCharacters,
      ),
      ...this.normalizeReferences(belief),
      ...this.normalizeLifecycle(belief),
      createdAt,
      updatedAt,
    };
  }

  private normalizePlan(plan: AgentPlan | null): AgentPlan | null {
    if (plan === null) return null;
    return {
      content: this.normalizeText(
        plan.content,
        "Plan content",
        this.maximumPlanCharacters,
      ),
      marketSlugs: this.normalizeList(
        plan.marketSlugs,
        "Plan marketSlugs",
        this.maximumMarketSlugs,
        this.maximumMarketSlugCharacters,
      ),
      updatedAt: this.canonicalTimestamp(plan.updatedAt),
      ...this.normalizeReferences(plan),
      ...(plan.reviewAt === undefined
        ? {}
        : {
            reviewAt:
              plan.reviewAt === null
                ? null
                : this.canonicalTimestamp(plan.reviewAt),
          }),
    };
  }

  private normalizeSnapshot(snapshot: AgentStateSnapshot): AgentStateSnapshot {
    if (snapshot.beliefs.length > this.maximumBeliefs) {
      throw new RangeError(
        `Persisted agent state exceeds the maximum ${this.maximumBeliefs} beliefs`,
      );
    }
    const ids = new Set<string>();
    const beliefs = snapshot.beliefs.map((belief) => {
      if (ids.has(belief.id)) {
        throw new Error(`Duplicate agent-belief ID ${belief.id}`);
      }
      ids.add(belief.id);
      return this.normalizeBelief(belief);
    });
    const byId = new Map(beliefs.map((belief) => [belief.id, belief]));
    for (const belief of beliefs) {
      const visited = new Set([belief.id]);
      let supersededId = belief.supersedesBeliefId;
      while (supersededId != null) {
        if (visited.has(supersededId))
          throw new Error("Belief supersession contains a cycle");
        visited.add(supersededId);
        supersededId = byId.get(supersededId)?.supersedesBeliefId;
      }
    }
    return {
      version: 2,
      beliefs,
      nextCyclePlan: this.normalizePlan(snapshot.nextCyclePlan),
      longTermPlan: this.normalizePlan(snapshot.longTermPlan),
    };
  }

  private async readSnapshot(): Promise<SnapshotRead> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { snapshot: emptySnapshot(), exists: false, normalized: false };
      }
      throw error;
    }
    let rawSnapshot: unknown;
    try {
      rawSnapshot = JSON.parse(source) as unknown;
    } catch {
      throw new Error("Invalid agent-state snapshot JSON");
    }
    const parsed = SnapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) {
      throw new Error("Invalid agent-state snapshot");
    }
    // Version 2 changed plan semantics. Preserve evidence-based beliefs from
    // v1, but discard planning directives that are not compatible with the
    // current state schema.
    const migrated =
      parsed.data.version === 1
        ? {
            version: 2 as const,
            beliefs: parsed.data.beliefs,
            nextCyclePlan: null,
            longTermPlan: null,
          }
        : parsed.data;
    const snapshot = this.normalizeSnapshot(migrated);
    return {
      snapshot,
      exists: true,
      normalized:
        parsed.data.version === 1 ||
        JSON.stringify(snapshot) !== JSON.stringify(parsed.data),
    };
  }

  private async writeSnapshot(
    snapshot: AgentStateSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      signal?.throwIfAborted();
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private sortedBeliefs(snapshot: AgentStateSnapshot): readonly AgentBelief[] {
    return snapshot.beliefs.toSorted((left, right) => {
      const updatedDifference =
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedDifference !== 0) return updatedDifference;
      return left.id.localeCompare(right.id);
    });
  }

  private context(snapshot: AgentStateSnapshot): AgentStateContext {
    // Keep corrections and expired entries in LIST/storage for auditability.
    // Expiring a correction never revives the belief it replaced.
    const supersededIds = new Set(
      snapshot.beliefs.flatMap((belief) =>
        belief.supersedesBeliefId == null ? [] : [belief.supersedesBeliefId],
      ),
    );
    const now = Date.parse(this.timestamp());
    const activeBeliefs = this.sortedBeliefs(snapshot).filter(
      (belief) =>
        (belief.status === undefined || belief.status === "ACTIVE") &&
        !supersededIds.has(belief.id) &&
        (belief.expiresAt == null || Date.parse(belief.expiresAt) > now),
    );
    const beliefs = activeBeliefs.slice(0, this.maximumContextBeliefs);
    return {
      mode: "PERSISTENT",
      beliefs,
      nextCyclePlan: snapshot.nextCyclePlan,
      longTermPlan: snapshot.longTermPlan,
      totalBeliefCount: snapshot.beliefs.length,
      inactiveBeliefCount: snapshot.beliefs.length - activeBeliefs.length,
      truncated: beliefs.length < snapshot.beliefs.length,
      maximumBeliefs: this.maximumBeliefs,
      maximumContextBeliefs: this.maximumContextBeliefs,
      maximumBeliefCharacters: this.maximumBeliefCharacters,
      maximumPlanCharacters: this.maximumPlanCharacters,
    };
  }

  private operationResult(
    action: AgentStateOperation["action"],
    snapshot: AgentStateSnapshot,
    offset = 0,
    mutatedBeliefId?: string,
  ): AgentStateOperationResult {
    const allBeliefs = this.sortedBeliefs(snapshot);
    const beliefs = allBeliefs.slice(
      offset,
      offset + this.maximumContextBeliefs,
    );
    const nextOffset = offset + beliefs.length;
    const eof = nextOffset >= allBeliefs.length;
    return {
      action,
      ...(mutatedBeliefId === undefined ? {} : { mutatedBeliefId }),
      beliefs,
      nextCyclePlan: snapshot.nextCyclePlan,
      longTermPlan: snapshot.longTermPlan,
      totalBeliefCount: allBeliefs.length,
      truncated: beliefs.length < allBeliefs.length,
      eof,
      ...(eof ? {} : { nextCursor: String(nextOffset) }),
    };
  }

  private parseOffset(cursor: string | undefined): number {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(
        "Agent-state cursor must be a non-negative integer offset",
      );
    }
    return offset;
  }

  private validateUpdate(
    operation: Extract<ParsedOperation, { action: "UPDATE_BELIEF" }>,
  ): void {
    const updateFields: readonly (keyof typeof operation)[] = [
      "type",
      "confidence",
      "content",
      "marketSlugs",
      "evidenceUpdatedAt",
      "invalidationConditions",
      "evidenceUrls",
      "basisMarketSlugs",
      "status",
      "supersedesBeliefId",
      "expiresAt",
      "reviewAt",
    ];
    if (!updateFields.some((field) => operation[field] !== undefined)) {
      throw new Error("UPDATE_BELIEF requires at least one changed field");
    }
  }

  private newBelief(
    operation: Extract<ParsedOperation, { action: "ADD_BELIEF" }>,
    snapshot: AgentStateSnapshot,
  ): AgentBelief {
    if (snapshot.beliefs.length >= this.maximumBeliefs) {
      throw new RangeError(
        `Agent state already contains the maximum ${this.maximumBeliefs} beliefs`,
      );
    }
    const idResult = z.uuid().safeParse(this.idFactory());
    if (!idResult.success) {
      throw new Error("Agent-state ID factory returned an invalid UUID");
    }
    if (snapshot.beliefs.some((belief) => belief.id === idResult.data)) {
      throw new Error(`Agent-belief ID ${idResult.data} already exists`);
    }
    const recordedAt = this.timestamp();
    return this.normalizeBelief({
      id: idResult.data,
      type: operation.type,
      confidence: operation.confidence,
      content: operation.content,
      marketSlugs: operation.marketSlugs,
      evidenceUpdatedAt: operation.evidenceUpdatedAt,
      invalidationConditions: operation.invalidationConditions,
      ...this.normalizeReferences(operation),
      ...this.normalizeLifecycle(operation),
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
  }

  private updatedBelief(
    operation: Extract<ParsedOperation, { action: "UPDATE_BELIEF" }>,
    belief: AgentBelief,
  ): AgentBelief {
    this.validateUpdate(operation);
    return this.normalizeBelief({
      ...belief,
      ...(operation.type === undefined ? {} : { type: operation.type }),
      ...(operation.confidence === undefined
        ? {}
        : { confidence: operation.confidence }),
      ...(operation.content === undefined
        ? {}
        : { content: operation.content }),
      ...(operation.marketSlugs === undefined
        ? {}
        : { marketSlugs: operation.marketSlugs }),
      ...(operation.evidenceUpdatedAt === undefined
        ? {}
        : { evidenceUpdatedAt: operation.evidenceUpdatedAt }),
      ...(operation.invalidationConditions === undefined
        ? {}
        : { invalidationConditions: operation.invalidationConditions }),
      ...this.normalizeReferences(operation),
      ...this.normalizeLifecycle(operation),
      updatedAt: this.timestamp(),
    });
  }

  private newPlan(
    operation: Extract<
      ParsedOperation,
      { action: "SET_NEXT_CYCLE_PLAN" | "SET_LONG_TERM_PLAN" }
    >,
  ): AgentPlan {
    const plan = this.normalizePlan({
      content: operation.content,
      marketSlugs: operation.marketSlugs,
      ...this.normalizeReferences(operation),
      ...(operation.reviewAt === undefined
        ? {}
        : { reviewAt: operation.reviewAt }),
      updatedAt: this.timestamp(),
    });
    if (plan === null) throw new Error("Agent plan normalization failed");
    return plan;
  }

  public load(): Promise<AgentStateContext> {
    const result = this.mutationQueue.then(async () => {
      const read = await this.readSnapshot();
      if (read.exists && read.normalized) {
        await this.writeSnapshot(read.snapshot);
      }
      return this.context(read.snapshot);
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public manage(
    operation: AgentStateOperation,
    signal?: AbortSignal,
  ): Promise<AgentStateOperationResult> {
    const result = this.mutationQueue.then(async () => {
      signal?.throwIfAborted();
      const parsed = OperationSchema.parse(operation);
      const read = await this.readSnapshot();
      if (parsed.action === "LIST") {
        if (read.exists && read.normalized) {
          await this.writeSnapshot(read.snapshot, signal);
        }
        return this.operationResult(
          parsed.action,
          read.snapshot,
          this.parseOffset(parsed.cursor),
        );
      }

      let snapshot: AgentStateSnapshot;
      let mutatedBeliefId: string | undefined;
      if (
        (parsed.action === "ADD_BELIEF" || parsed.action === "UPDATE_BELIEF") &&
        parsed.supersedesBeliefId != null &&
        !read.snapshot.beliefs.some(
          (belief) => belief.id === parsed.supersedesBeliefId,
        )
      ) {
        throw new Error("Superseded belief does not exist");
      }
      if (parsed.action === "ADD_BELIEF") {
        const belief = this.newBelief(parsed, read.snapshot);
        mutatedBeliefId = belief.id;
        snapshot = {
          ...read.snapshot,
          beliefs: [...read.snapshot.beliefs, belief],
        };
      } else if (parsed.action === "UPDATE_BELIEF") {
        this.validateUpdate(parsed);
        mutatedBeliefId = parsed.beliefId;
        const index = read.snapshot.beliefs.findIndex(
          (belief) => belief.id === parsed.beliefId,
        );
        if (index < 0) {
          throw new Error(`Agent belief ${parsed.beliefId} does not exist`);
        }
        snapshot = {
          ...read.snapshot,
          beliefs: read.snapshot.beliefs.map((belief, beliefIndex) =>
            beliefIndex === index ? this.updatedBelief(parsed, belief) : belief,
          ),
        };
      } else if (parsed.action === "DELETE_BELIEF") {
        mutatedBeliefId = parsed.beliefId;
        if (
          !read.snapshot.beliefs.some((belief) => belief.id === parsed.beliefId)
        ) {
          throw new Error(`Agent belief ${parsed.beliefId} does not exist`);
        }
        snapshot = {
          ...read.snapshot,
          beliefs: read.snapshot.beliefs.filter(
            (belief) => belief.id !== parsed.beliefId,
          ),
        };
      } else if (parsed.action === "SET_NEXT_CYCLE_PLAN") {
        snapshot = {
          ...read.snapshot,
          nextCyclePlan: this.newPlan(parsed),
        };
      } else if (parsed.action === "SET_LONG_TERM_PLAN") {
        snapshot = {
          ...read.snapshot,
          longTermPlan: this.newPlan(parsed),
        };
      } else {
        snapshot = { ...read.snapshot, nextCyclePlan: null };
      }
      // Supersession is an explicit mutation of the prior belief. Deleting or
      // expiring the correction must not silently revive a replaced thesis.
      if (
        (parsed.action === "ADD_BELIEF" || parsed.action === "UPDATE_BELIEF") &&
        parsed.supersedesBeliefId != null
      ) {
        snapshot = {
          ...snapshot,
          beliefs: snapshot.beliefs.map((belief) =>
            belief.id === parsed.supersedesBeliefId
              ? { ...belief, status: "SUPERSEDED", updatedAt: this.timestamp() }
              : belief,
          ),
        };
      }
      const normalized = this.normalizeSnapshot(snapshot);
      await this.writeSnapshot(normalized, signal);
      return this.operationResult(
        parsed.action,
        normalized,
        0,
        mutatedBeliefId,
      );
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function statelessAgentStateContext(): AgentStateContext {
  return STATELESS_CONTEXT;
}
