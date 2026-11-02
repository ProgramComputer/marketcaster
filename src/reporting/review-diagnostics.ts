import { Decimal } from "decimal.js";
import { redactPotentialSecrets } from "../utilities/redaction.js";

export type ReviewDiagnosticKind =
  "execution-diagnostics" | "history-attribution" | "evidence-receipts";

export type ReviewJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReviewJsonValue[]
  | { readonly [key: string]: ReviewJsonValue };

export interface ReviewDiagnosticsOptions {
  /** Known credentials, supplied explicitly; this module never reads the environment. */
  readonly secretValues?: readonly string[];
  readonly maximumEventsPerArtifact?: number;
  /** Compact JSON size limit, with a minimum of 256 characters. */
  readonly maximumArtifactCharacters?: number;
  readonly maximumStringCharacters?: number;
}

export interface ReviewDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly events: readonly ReviewJsonValue[];
  readonly omittedEvents: number;
  readonly truncatedValues: number;
  readonly sanitizationFailures: number;
}

export interface ReviewDiagnostics {
  append(kind: ReviewDiagnosticKind, event: unknown): void;
  snapshot(kind: ReviewDiagnosticKind): ReviewDiagnosticsSnapshot;
  /**
   * Writes independent review artifacts. The sink must not update the mandatory
   * execution journal or its manifest queue; use a separate artifact writer.
   * Rejections are swallowed, and other categories are still attempted.
   */
  flush(
    writeArtifact: (
      kind: ReviewDiagnosticKind,
      value: ReviewDiagnosticsSnapshot,
    ) => Promise<unknown>,
  ): Promise<void>;
}

const KINDS: readonly ReviewDiagnosticKind[] = [
  "execution-diagnostics",
  "history-attribution",
  "evidence-receipts",
];
const SECRET_FIELD =
  /authorization|cookie|api[-_]?key|secret|token|password|private[-_]?key|credential|encrypted[-_]?content|^(?:env|environment|headers)$/iu;
const TRUNCATED = "[TRUNCATED]";
const MAXIMUM_NODES = 2_048;
const MAXIMUM_DEPTH = 8;
const MAXIMUM_MEMBERS = 64;

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

/** Read data properties only. Review never executes getters or toJSON hooks. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? (descriptor.value as unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

function textField(value: unknown, key: string): string | null {
  const result = field(value, key);
  return typeof result === "string" ? result : null;
}

function cleanText(value: string, secretValues: readonly string[]): string {
  let result = redactPotentialSecrets(value);
  for (const secret of secretValues) {
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  // URLs can carry credentials even when their containing field is innocuous.
  return result
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|token|secret|password|signature)=)[^&#\s]*/giu,
      "$1[REDACTED]",
    );
}

function sanitize(
  value: unknown,
  secretValues: readonly string[],
  maximumStringCharacters: number,
  maximumCharacters: number,
): { value: ReviewJsonValue; truncatedValues: number } {
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  let truncatedValues = 0;
  const truncated = (): string => {
    truncatedValues += 1;
    return TRUNCATED;
  };
  const visit = (current: unknown, depth: number): ReviewJsonValue => {
    nodes += 1;
    if (
      nodes > MAXIMUM_NODES ||
      depth > MAXIMUM_DEPTH ||
      characters >= maximumCharacters
    ) {
      return truncated();
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : "[NON_FINITE_NUMBER]";
    }
    if (typeof current === "string") {
      const redacted = cleanText(current, secretValues);
      const allowed = Math.max(
        0,
        Math.min(maximumStringCharacters, maximumCharacters - characters),
      );
      const result = redacted.slice(0, allowed);
      characters += result.length;
      return result.length === redacted.length
        ? result
        : `${result}${truncated()}`;
    }
    if (typeof current === "bigint") return visit(String(current), depth);
    if (typeof current !== "object") return `[${typeof current}]`;
    if (ancestors.has(current)) return "[CIRCULAR]";
    if (current instanceof Date) {
      return Number.isFinite(current.getTime())
        ? current.toISOString()
        : "[INVALID_DATE]";
    }
    if (current instanceof Decimal) return visit(current.toFixed(), depth);
    if (current instanceof Error) {
      return visit({ name: current.name, message: current.message }, depth + 1);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const length = Math.min(current.length, MAXIMUM_MEMBERS);
        const result: ReviewJsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          result.push(visit(field(current, String(index)), depth + 1));
        }
        if (current.length > length) result.push(truncated());
        return result;
      }
      const result: Record<string, ReviewJsonValue> = Object.create(
        null,
      ) as Record<string, ReviewJsonValue>;
      const keys = Object.keys(current);
      for (const key of keys.slice(0, MAXIMUM_MEMBERS)) {
        const safeKey = cleanText(key, secretValues).slice(0, 128);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        result[safeKey] = SECRET_FIELD.test(key)
          ? "[REDACTED]"
          : descriptor !== undefined && "value" in descriptor
            ? visit(descriptor.value as unknown, depth + 1)
            : "[ACCESSOR_OMITTED]";
      }
      if (keys.length > MAXIMUM_MEMBERS) result.__truncated__ = truncated();
      return result;
    } finally {
      ancestors.delete(current);
    }
  };
  return { value: visit(value, 0), truncatedValues };
}

/** Optional diagnostics cannot authorize an order or fail a trading cycle. */
export function createReviewDiagnostics(
  options: ReviewDiagnosticsOptions = {},
): ReviewDiagnostics {
  const maximumEvents = boundedOption(
    options.maximumEventsPerArtifact,
    256,
    1_024,
  );
  const maximumCharacters = Math.max(
    256,
    boundedOption(options.maximumArtifactCharacters, 262_144, 1_048_576),
  );
  const maximumString = boundedOption(
    options.maximumStringCharacters,
    8_192,
    65_536,
  );
  const secrets = [...(options.secretValues ?? [])].filter(
    (value) => value.length > 0,
  );
  const state = new Map(
    KINDS.map((kind) => [
      kind,
      {
        events: [] as ReviewJsonValue[],
        characters: 0,
        omittedEvents: 0,
        truncatedValues: 0,
        sanitizationFailures: 0,
      },
    ]),
  );
  const snapshot = (kind: ReviewDiagnosticKind): ReviewDiagnosticsSnapshot => {
    const bucket = state.get(kind);
    return {
      schemaVersion: 1,
      // Return detached JSON data so a sink cannot mutate future snapshots.
      events: JSON.parse(
        JSON.stringify(bucket?.events ?? []),
      ) as ReviewJsonValue[],
      omittedEvents: bucket?.omittedEvents ?? 0,
      truncatedValues: bucket?.truncatedValues ?? 0,
      sanitizationFailures: bucket?.sanitizationFailures ?? 0,
    };
  };
  return {
    append(kind, event) {
      const bucket = state.get(kind);
      if (bucket === undefined) return;
      try {
        if (bucket.events.length >= maximumEvents) {
          bucket.omittedEvents += 1;
          return;
        }
        const clean = sanitize(
          event,
          secrets,
          maximumString,
          maximumCharacters,
        );
        const serialized = JSON.stringify(clean.value);
        // Account for JSON escaping, keys, punctuation and separators too.
        if (
          bucket.characters + serialized.length + 1 >
          maximumCharacters - 192
        ) {
          bucket.omittedEvents += 1;
          return;
        }
        bucket.events.push(clean.value);
        bucket.characters += serialized.length + 1;
        bucket.truncatedValues += clean.truncatedValues;
      } catch {
        bucket.sanitizationFailures += 1;
      }
    },
    snapshot,
    async flush(writeArtifact) {
      for (const kind of KINDS) {
        try {
          await writeArtifact(kind, snapshot(kind));
        } catch {
          // Review persistence is isolated from mandatory execution persistence.
        }
      }
    },
  };
}

export interface EvidenceReceipt {
  readonly kind:
    "READ_EVIDENCE_SOURCE" | "PROVIDER_RESULT" | "RECEIPTS_TRUNCATED";
  readonly round: number | null;
  readonly callId: string | null;
  readonly url: string | null;
  readonly finalUrl: string | null;
  readonly title: string | null;
  readonly textStatus: "READABLE" | "OPAQUE" | "UNKNOWN";
  readonly opaquePayloadPresent: boolean;
  readonly text: string | null;
  readonly structured: {
    readonly retrieval: ReviewJsonValue;
    readonly sourceIssueTime: ReviewJsonValue;
    readonly sourcePublicationTime: ReviewJsonValue;
    readonly sourceValidPeriod: ReviewJsonValue;
    readonly location: ReviewJsonValue;
    readonly role: ReviewJsonValue;
    readonly sourceTimestamps: ReviewJsonValue;
    readonly textCoverage: ReviewJsonValue;
    readonly textRanges: ReviewJsonValue;
    readonly sourceTextSha256: ReviewJsonValue;
    readonly sourceReportedTruncated: ReviewJsonValue;
    readonly reusedSnapshot: ReviewJsonValue;
  };
  readonly truncatedValues: number;
}

/**
 * Receipts describe existing readable source data, never model conclusions.
 * Null means unavailable as a structured field. Dates, locations and roles are
 * not inferred from prose, URL coordinates, nearby observations, or page age.
 * Opaque provider payloads are marked and discarded, never decrypted.
 */
export function deriveEvidenceReceipts(
  transcript: unknown,
): readonly EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [];
  let scanned = 0;
  let scanTruncated = false;
  const seen = new Set<object>();
  const add = (
    source: unknown,
    kind: EvidenceReceipt["kind"],
    round: number | null,
    callId: string | null,
    fallbackUrl: string | null = null,
  ): void => {
    if (receipts.length >= 256) {
      scanTruncated = true;
      return;
    }
    const readable =
      textField(source, "text") ??
      textField(source, "cited_text") ??
      textField(source, "snippet") ??
      textField(source, "content");
    const opaque = field(source, "encrypted_content") !== undefined;
    let structuredTruncatedValues = 0;
    const structuredValue = (keys: readonly string[]): ReviewJsonValue => {
      for (const key of keys) {
        const value = field(source, key);
        if (value !== undefined) {
          const clean = sanitize(value, [], 8_192, 32_768);
          structuredTruncatedValues += clean.truncatedValues;
          return clean.value;
        }
      }
      return null;
    };
    const clean = sanitize(
      {
        url: textField(source, "url") ?? fallbackUrl,
        finalUrl: textField(source, "finalUrl"),
        title: textField(source, "title"),
        callId,
        text: readable,
      },
      [],
      8_192,
      32_768,
    );
    const cleanField = (key: string): string | null =>
      textField(clean.value, key);
    receipts.push({
      kind,
      round,
      callId: cleanField("callId"),
      url: cleanField("url"),
      finalUrl: cleanField("finalUrl"),
      title: cleanField("title"),
      textStatus:
        readable !== null ? "READABLE" : opaque ? "OPAQUE" : "UNKNOWN",
      opaquePayloadPresent: opaque,
      text: cleanField("text"),
      structured: {
        retrieval: structuredValue(["retrieval"]),
        sourceIssueTime: structuredValue(["sourceIssueTime", "issuedAt"]),
        sourcePublicationTime: structuredValue(["published_at", "publishedAt"]),
        sourceValidPeriod: structuredValue([
          "sourceValidPeriod",
          "validPeriod",
        ]),
        location: structuredValue(["location"]),
        role: structuredValue(["role"]),
        sourceTimestamps: structuredValue(["sourceTimestamps"]),
        textCoverage: structuredValue(["textCoverage"]),
        textRanges: structuredValue(["textRanges"]),
        sourceTextSha256: structuredValue(["sourceTextSha256"]),
        sourceReportedTruncated: structuredValue(["truncated"]),
        reusedSnapshot: structuredValue(["reusedSnapshot"]),
      },
      truncatedValues: clean.truncatedValues + structuredTruncatedValues,
    });
  };
  const walk = (value: unknown, round: number | null, depth: number): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    if (++scanned > 8_192 || depth > 16 || receipts.length >= 256) {
      scanTruncated = true;
      return;
    }
    seen.add(value);
    const roundValue = field(value, "round");
    if (typeof roundValue === "number" && Number.isSafeInteger(roundValue))
      round = roundValue;
    const results = field(value, "toolResults");
    if (Array.isArray(results)) {
      for (const result of results.slice(0, 64)) {
        if (textField(result, "name") !== "read_evidence_source") continue;
        const content = field(field(result, "result"), "content");
        const callId = textField(result, "callId");
        const calls = field(value, "toolCalls");
        const call: unknown = Array.isArray(calls)
          ? calls
              .slice(0, 64)
              .find(
                (candidate: unknown) =>
                  textField(candidate, "callId") === callId,
              )
          : undefined;
        add(
          content,
          "READ_EVIDENCE_SOURCE",
          round,
          callId,
          textField(field(call, "input"), "url"),
        );
      }
      if (results.length > 64) scanTruncated = true;
    }
    const type = textField(value, "type");
    if (
      type === "web_search_result" ||
      type === "web_search_result_location" ||
      type === "url_citation"
    ) {
      add(value, "PROVIDER_RESULT", round, null);
    }
    // Traverse source-shaped data only; text and encrypted payloads are scalars.
    const keys = Object.keys(value).slice(0, 128);
    if (Object.keys(value).length > keys.length) scanTruncated = true;
    for (const key of keys) walk(field(value, key), round, depth + 1);
  };
  try {
    walk(transcript, null, 0);
  } catch {
    scanTruncated = true;
  }
  if (scanTruncated) {
    receipts.push({
      kind: "RECEIPTS_TRUNCATED",
      round: null,
      callId: null,
      url: null,
      finalUrl: null,
      title: null,
      textStatus: "UNKNOWN",
      opaquePayloadPresent: false,
      text: null,
      structured: {
        retrieval: null,
        sourceIssueTime: null,
        sourcePublicationTime: null,
        sourceValidPeriod: null,
        location: null,
        role: null,
        sourceTimestamps: null,
        textCoverage: null,
        textRanges: null,
        sourceTextSha256: null,
        sourceReportedTruncated: null,
        reusedSnapshot: null,
      },
      truncatedValues: 1,
    });
  }
  return receipts;
}
