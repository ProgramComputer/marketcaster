import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { redactPotentialSecrets } from "../utilities/redaction.js";

export interface AgentNote {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentNoteContext {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentMemoryContext =
  | {
      readonly mode: "STATELESS";
      readonly priorReasoning: readonly [];
    }
  | {
      readonly mode: "PERSISTENT";
      readonly notes: readonly AgentNoteContext[];
      readonly totalNoteCount: number;
      readonly truncated: boolean;
      readonly maximumNotes: number;
      readonly maximumContextNotes: number;
      readonly maximumNoteCharacters: number;
    };

export type AgentNoteOperation =
  | { readonly action: "LIST"; readonly cursor?: string | undefined }
  | {
      readonly action: "ADD";
      readonly content: string;
      readonly evidenceUrls?: readonly string[];
      readonly basisMarketSlugs?: readonly string[];
    }
  | {
      readonly action: "UPDATE";
      readonly noteId: string;
      readonly content: string;
      readonly evidenceUrls?: readonly string[];
      readonly basisMarketSlugs?: readonly string[];
    }
  | { readonly action: "DELETE"; readonly noteId: string };

export interface AgentNoteOperationResult {
  readonly action: AgentNoteOperation["action"];
  readonly mutatedNoteId?: string;
  readonly notes: readonly AgentNoteContext[];
  readonly totalNoteCount: number;
  readonly truncated: boolean;
  readonly eof: boolean;
  readonly nextCursor?: string;
}

export interface AgentMemory {
  readonly persistent: boolean;
  load(): Promise<AgentMemoryContext>;
  manage(operation: AgentNoteOperation): Promise<AgentNoteOperationResult>;
}

const STATELESS_CONTEXT: AgentMemoryContext = Object.freeze({
  mode: "STATELESS",
  priorReasoning: [] as const,
});

export class StatelessAgentMemory implements AgentMemory {
  public readonly persistent = false as const;

  public load(): Promise<AgentMemoryContext> {
    return Promise.resolve(STATELESS_CONTEXT);
  }

  public manage(
    _operation: AgentNoteOperation,
  ): Promise<AgentNoteOperationResult> {
    void _operation;
    return Promise.reject(new Error("Persistent agent notes are disabled"));
  }
}

const NoteEventSchema = z.discriminatedUnion("action", [
  z
    .object({
      version: z.literal(1),
      action: z.literal("ADD"),
      id: z.uuid(),
      content: z.string().min(1),
      recordedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      action: z.literal("UPDATE"),
      id: z.uuid(),
      content: z.string().min(1),
      recordedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      action: z.literal("DELETE"),
      id: z.uuid(),
      recordedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);

type NoteEvent = z.infer<typeof NoteEventSchema>;

interface NoteEventLog {
  readonly events: readonly NoteEvent[];
  readonly tornTail: boolean;
  readonly normalizedContent: boolean;
  readonly missingTerminalNewline: boolean;
}

export interface FileAgentMemoryOptions {
  readonly filePath: string;
  readonly maximumNotes?: number;
  readonly maximumNoteCharacters?: number;
  readonly maximumContextNotes?: number;
  readonly maximumPersistedEvents?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function contextNote(note: AgentNote): AgentNoteContext {
  return {
    id: note.id,
    content: note.content,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export class FileAgentMemory implements AgentMemory {
  public readonly persistent = true as const;
  private readonly filePath: string;
  private readonly maximumNotes: number;
  private readonly maximumNoteCharacters: number;
  private readonly maximumContextNotes: number;
  private readonly maximumPersistedEvents: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(options: FileAgentMemoryOptions) {
    this.filePath = resolve(options.filePath);
    this.maximumNotes = positiveInteger(
      options.maximumNotes ?? 50,
      "maximumNotes",
    );
    this.maximumNoteCharacters = positiveInteger(
      options.maximumNoteCharacters ?? 1_200,
      "maximumNoteCharacters",
    );
    this.maximumContextNotes = positiveInteger(
      options.maximumContextNotes ?? this.maximumNotes,
      "maximumContextNotes",
    );
    if (this.maximumContextNotes > this.maximumNotes) {
      throw new RangeError("maximumContextNotes cannot exceed maximumNotes");
    }
    const minimumCompactedEvents = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.maximumNotes * 2,
    );
    this.maximumPersistedEvents = positiveInteger(
      options.maximumPersistedEvents ??
        Math.max(100, Math.min(Number.MAX_SAFE_INTEGER, this.maximumNotes * 4)),
      "maximumPersistedEvents",
    );
    if (this.maximumPersistedEvents < minimumCompactedEvents) {
      throw new RangeError(
        "maximumPersistedEvents must hold a compacted form of every note",
      );
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private normalizeContent(content: string): string {
    const sanitized = redactPotentialSecrets(
      Array.from(content, (character) => {
        const code = character.codePointAt(0) ?? 0;
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127
          ? " "
          : character;
      }).join(""),
    ).trim();
    const length = Array.from(sanitized).length;
    if (length === 0 || length > this.maximumNoteCharacters) {
      throw new RangeError(
        `Note content must contain 1 to ${this.maximumNoteCharacters} characters`,
      );
    }
    return sanitized;
  }

  private timestamp(): Date {
    const value = this.now();
    if (Number.isNaN(value.getTime())) {
      throw new Error("Agent-note timestamp is invalid");
    }
    return value;
  }

  private async eventLog(): Promise<NoteEventLog> {
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
        return {
          events: [],
          tornTail: false,
          normalizedContent: false,
          missingTerminalNewline: false,
        };
      }
      throw error;
    }
    const sourceEndsWithNewline = /\r?\n$/u.test(source);
    const nonEmptyLines = source
      .split(/\r?\n/u)
      .map((line, sourceIndex) => ({ line, sourceIndex }))
      .filter(({ line }) => line.trim().length > 0);
    const events: NoteEvent[] = [];
    let normalizedContent = false;
    for (const [index, { line, sourceIndex }] of nonEmptyLines.entries()) {
      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(line) as unknown;
      } catch (error) {
        const isTornTail =
          !sourceEndsWithNewline && index === nonEmptyLines.length - 1;
        if (isTornTail) {
          return {
            events,
            tornTail: true,
            normalizedContent,
            missingTerminalNewline: true,
          };
        }
        throw new Error(`Invalid agent-note event on line ${sourceIndex + 1}`, {
          cause: error,
        });
      }
      try {
        const event = NoteEventSchema.parse(rawEvent);
        if (event.action === "DELETE") {
          events.push(event);
        } else {
          const content = this.normalizeContent(event.content);
          normalizedContent ||= content !== event.content;
          events.push({ ...event, content });
        }
      } catch (error) {
        throw new Error(`Invalid agent-note event on line ${sourceIndex + 1}`, {
          cause: error,
        });
      }
    }
    return {
      events,
      tornTail: false,
      normalizedContent,
      missingTerminalNewline: source.length > 0 && !sourceEndsWithNewline,
    };
  }

  private notes(events: readonly NoteEvent[]): readonly AgentNote[] {
    const notes = new Map<string, AgentNote>();
    for (const event of events) {
      const recordedAt = new Date(event.recordedAt);
      if (event.action === "ADD") {
        if (notes.has(event.id)) {
          throw new Error(`Duplicate agent-note ID ${event.id}`);
        }
        notes.set(event.id, {
          id: event.id,
          content: event.content,
          createdAt: recordedAt,
          updatedAt: recordedAt,
        });
      } else if (event.action === "UPDATE") {
        const prior = notes.get(event.id);
        if (prior === undefined) {
          throw new Error(
            `Agent-note update references missing ID ${event.id}`,
          );
        }
        notes.set(event.id, {
          ...prior,
          content: event.content,
          updatedAt: recordedAt,
        });
      } else {
        if (!notes.delete(event.id)) {
          throw new Error(
            `Agent-note deletion references missing ID ${event.id}`,
          );
        }
      }
    }
    if (notes.size > this.maximumNotes) {
      throw new RangeError(
        `Persisted agent memory exceeds the maximum ${this.maximumNotes} notes`,
      );
    }
    return [...notes.values()].toSorted(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  }

  private async append(event: NoteEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  private compactEvents(notes: readonly AgentNote[]): readonly NoteEvent[] {
    return notes.flatMap((note): readonly NoteEvent[] => {
      const add = NoteEventSchema.parse({
        version: 1,
        action: "ADD",
        id: note.id,
        content: note.content,
        recordedAt: note.createdAt.toISOString(),
      });
      if (note.updatedAt.getTime() === note.createdAt.getTime()) return [add];
      return [
        add,
        NoteEventSchema.parse({
          version: 1,
          action: "UPDATE",
          id: note.id,
          content: note.content,
          recordedAt: note.updatedAt.toISOString(),
        }),
      ];
    });
  }

  private async rewrite(events: readonly NoteEvent[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const source =
      events.length === 0
        ? ""
        : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    try {
      await writeFile(temporaryPath, source, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private shouldCompact(log: NoteEventLog): boolean {
    return (
      log.tornTail ||
      log.normalizedContent ||
      log.missingTerminalNewline ||
      log.events.length > this.maximumPersistedEvents
    );
  }

  private context(notes: readonly AgentNote[]): AgentMemoryContext {
    const visibleNotes = notes.slice(0, this.maximumContextNotes);
    return {
      mode: "PERSISTENT",
      notes: visibleNotes.map(contextNote),
      totalNoteCount: notes.length,
      truncated: visibleNotes.length < notes.length,
      maximumNotes: this.maximumNotes,
      maximumContextNotes: this.maximumContextNotes,
      maximumNoteCharacters: this.maximumNoteCharacters,
    };
  }

  public async load(): Promise<AgentMemoryContext> {
    const result = this.mutationQueue.then(async () => {
      const log = await this.eventLog();
      const notes = this.notes(log.events);
      if (this.shouldCompact(log)) {
        await this.rewrite(this.compactEvents(notes));
      }
      return this.context(notes);
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public manage(
    operation: AgentNoteOperation,
  ): Promise<AgentNoteOperationResult> {
    const result = this.mutationQueue.then(async () => {
      const log = await this.eventLog();
      const notes = this.notes(log.events);
      if (operation.action === "LIST") {
        const offset =
          operation.cursor === undefined ? 0 : Number(operation.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new RangeError(
            "Agent-note cursor must be a non-negative integer offset",
          );
        }
        if (this.shouldCompact(log)) {
          await this.rewrite(this.compactEvents(notes));
        }
        return this.operationResult(operation.action, notes, offset);
      }
      const recordedAt = this.timestamp();
      let event: NoteEvent;
      if (operation.action === "ADD") {
        if (notes.length >= this.maximumNotes) {
          throw new RangeError(
            `Agent memory already contains the maximum ${this.maximumNotes} notes`,
          );
        }
        const id = this.idFactory();
        event = NoteEventSchema.parse({
          version: 1,
          action: "ADD",
          id,
          content: this.normalizeContent(operation.content),
          recordedAt: recordedAt.toISOString(),
        });
      } else if (operation.action === "UPDATE") {
        if (!notes.some((note) => note.id === operation.noteId)) {
          throw new Error(`Agent note ${operation.noteId} does not exist`);
        }
        event = NoteEventSchema.parse({
          version: 1,
          action: "UPDATE",
          id: operation.noteId,
          content: this.normalizeContent(operation.content),
          recordedAt: recordedAt.toISOString(),
        });
      } else {
        if (!notes.some((note) => note.id === operation.noteId)) {
          throw new Error(`Agent note ${operation.noteId} does not exist`);
        }
        event = NoteEventSchema.parse({
          version: 1,
          action: "DELETE",
          id: operation.noteId,
          recordedAt: recordedAt.toISOString(),
        });
      }
      const nextEvents = [...log.events, event];
      const nextNotes = this.notes(nextEvents);
      if (
        this.shouldCompact(log) ||
        nextEvents.length > this.maximumPersistedEvents
      ) {
        await this.rewrite(this.compactEvents(nextNotes));
      } else {
        await this.append(event);
      }
      return this.operationResult(operation.action, nextNotes, 0, event.id);
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private operationResult(
    action: AgentNoteOperation["action"],
    notes: readonly AgentNote[],
    offset = 0,
    mutatedNoteId?: string,
  ): AgentNoteOperationResult {
    const visibleNotes = notes.slice(offset, offset + this.maximumContextNotes);
    const nextOffset = offset + visibleNotes.length;
    const eof = nextOffset >= notes.length;
    return {
      action,
      ...(mutatedNoteId === undefined ? {} : { mutatedNoteId }),
      notes: visibleNotes.map(contextNote),
      totalNoteCount: notes.length,
      truncated: visibleNotes.length < notes.length,
      eof,
      ...(eof ? {} : { nextCursor: String(nextOffset) }),
    };
  }
}

export function statelessMemoryContext(): AgentMemoryContext {
  return STATELESS_CONTEXT;
}
