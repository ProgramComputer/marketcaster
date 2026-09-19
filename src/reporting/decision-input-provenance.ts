import { createHash } from "node:crypto";
import type { AgentConfig } from "../config/schema.js";
import type { DecisionPrompt } from "../agent/prompt-builder.js";
import type { DecisionLimits } from "../llm/decision-provider.js";
import type { StrategyPolicy } from "../strategy/policy.js";
import { redactPotentialSecrets } from "../utilities/redaction.js";

const SECRET_NAMES = [
  "POLYMARKET_KEY_ID",
  "POLYMARKET_SECRET_KEY",
  "KALSHI_API_KEY_ID",
  "KALSHI_PRIVATE_KEY",
  "LLM_API_KEY",
] as const;
const SECRET_KEY =
  /^(?:.*[_-])?(?:api[_-]?key(?:[_-]?id)?|secret(?:[_-]?key)?|private[_-]?key|password|passwd|authorization|credential(?:s)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|signature)$/iu;
const REDACTED = "[REDACTED]";

export interface ProvenanceIdentity {
  readonly productionSha: string | null;
  readonly engineSha: string | null;
  /** Redaction inputs only. Never serialize this identity object directly. */
  readonly secretValues: readonly string[];
}

/** Select known credential fields; never copy an environment into an artifact. */
export function provenanceIdentityFromEnvironment(
  environment: Readonly<Record<string, unknown>>,
): ProvenanceIdentity {
  const sha = (value: unknown): string | null =>
    typeof value === "string" && /^[a-f0-9]{40}$/iu.test(value) ? value : null;
  const secretValues = SECRET_NAMES.flatMap((name) => {
    const value = environment[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
  // A custom provider endpoint can itself contain configured credentials.
  if (typeof environment.LLM_BASE_URL === "string") {
    try {
      const url = new URL(environment.LLM_BASE_URL);
      for (const value of [url.username, url.password]) {
        if (value.length > 0) secretValues.push(decodeURIComponent(value));
      }
      for (const [key, value] of url.searchParams) {
        if (
          value.length > 0 &&
          (SECRET_KEY.test(key) || /^(?:key|sig|auth)$/iu.test(key))
        ) {
          secretValues.push(value);
        }
      }
    } catch {
      // Runtime configuration validates URLs separately; never expose their text.
    }
  }
  return {
    productionSha: sha(environment.MARKETCASTER_DEPLOYMENT_SHA),
    engineSha: sha(environment.MARKETCASTER_ENGINE_SHA),
    secretValues,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactText(value: string, secretValues: readonly string[]): string {
  // Tool results and context fields can contain another serialized JSON value.
  // Apply the same key policy at every layer, preserving original formatting
  // when no redaction is needed (including clean, JSON-encoded strings).
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") {
      const redacted = redactText(parsed, secretValues);
      if (redacted !== parsed) return JSON.stringify(redacted);
    } else if (parsed !== null && typeof parsed === "object") {
      const snapshot = redactedProvenanceSnapshot(parsed, secretValues);
      if (snapshot.redacted) return snapshot.json;
    }
  } catch {
    // Free-form prose is handled below without interpreting it as JSON.
  }
  let redacted = value;
  for (const secret of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (secret.length === 0) continue;
    redacted = redacted.replaceAll(secret, REDACTED);
    redacted = redacted.replaceAll(encodeURIComponent(secret), REDACTED);
    redacted = redacted.replaceAll(
      JSON.stringify(secret).slice(1, -1),
      REDACTED,
    );
  }
  redacted = redactPotentialSecrets(redacted);
  // Covers credentials embedded in prose, serialized JSON, and source URLs.
  redacted = redacted.replace(
    /((["']?)([A-Za-z_][A-Za-z0-9_-]*)\2\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gu,
    (match: string, prefix: string, _quote: string, key: string) =>
      SECRET_KEY.test(key) ? `${prefix}${REDACTED}` : match,
  );
  return redacted.replace(/https?:\/\/[^\s<>"']+/giu, (value) => {
    try {
      const url = new URL(value);
      let changed = false;
      if (url.username !== "" || url.password !== "") {
        url.username = "";
        url.password = "";
        changed = true;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (
          SECRET_KEY.test(key) ||
          /^(?:key|sig|auth)$/iu.test(key) ||
          secretValues.some(
            (secret) =>
              secret.length > 0 &&
              url.searchParams
                .getAll(key)
                .some((value) => value.includes(secret)),
          )
        ) {
          url.searchParams.set(key, REDACTED);
          changed = true;
        }
      }
      return changed ? url.toString() : value;
    } catch {
      return value;
    }
  });
}

/** Hashes always identify the persisted, redacted JSON, never unredacted bytes. */
export function redactedProvenanceSnapshot(
  value: unknown,
  secretValues: readonly string[] = [],
): {
  readonly json: string;
  readonly sha256: string;
  readonly redacted: boolean;
} {
  let changed = false;
  const json: unknown = JSON.stringify(value, (key, item: unknown) => {
    if (SECRET_KEY.test(key)) {
      changed = true;
      return REDACTED;
    }
    if (typeof item === "string") {
      const redacted = redactText(item, secretValues);
      changed ||= redacted !== item;
      return redacted;
    }
    if (typeof item === "function") {
      return {
        kind: "FUNCTION_IDENTITY_ONLY",
        name: item.name,
        sourceSha256: sha256(String(item)),
        closureCaptured: false,
      };
    }
    return item;
  });
  if (typeof json !== "string")
    throw new TypeError("Provenance must be JSON data");
  return { json, sha256: sha256(json), redacted: changed };
}

/** Policy hooks are fingerprinted, never invoked or rebound by provenance. */
function selectedPolicyFields<T extends object>(
  value: T,
  keys: readonly (keyof T)[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function runtimeInputProvenance(input: {
  readonly identity: ProvenanceIdentity;
  readonly provider: string;
  readonly model: string;
  readonly catalogModel?: string;
  readonly config: AgentConfig;
  readonly strategy: StrategyPolicy;
}): unknown {
  const { identity, config } = input;
  return {
    schemaVersion: 1,
    classification: "PRIVATE_RUNTIME",
    productionSha: identity.productionSha,
    engineSha: identity.engineSha,
    provider: redactText(input.provider, identity.secretValues),
    model: redactText(input.model, identity.secretValues),
    ...(input.catalogModel === undefined
      ? {}
      : {
          catalogModel: redactText(input.catalogModel, identity.secretValues),
        }),
    effectiveConfiguration: redactedProvenanceSnapshot(
      {
        // Explicit schema sections: environment and transport credentials excluded.
        config: {
          cycle: config.cycle,
          marketSelection: config.marketSelection,
          agent: config.agent,
          risk: config.risk,
          exchange: config.exchange,
          reporting: config.reporting,
        },
        strategy: {
          apiVersion: input.strategy.apiVersion,
          selection: selectedPolicyFields(input.strategy.selection, [
            "depthPriceBand",
            "buildFamilyScout",
            "shouldFetchFamilyBook",
            "allowWebSearch",
            "shouldEnforceRequiredResearch",
            "buildCriticalLearning",
            "buildOpportunityBoard",
            "buildEnrichedOpportunityBoard",
            "selectRequiredMarketSlugs",
            "experimentDefinition",
          ]),
          forecast:
            input.strategy.forecast === undefined
              ? undefined
              : selectedPolicyFields(input.strategy.forecast, [
                  "forecastTolerance",
                  "systemLiveEvidenceSources",
                  "liveEvidenceLinePreview",
                  "refreshForecasts",
                ]),
          selectMemoryContext: input.strategy.selectMemoryContext,
          resolutionReview:
            input.strategy.resolutionReview === undefined
              ? undefined
              : selectedPolicyFields(input.strategy.resolutionReview, [
                  "selectMarketSlugs",
                  "reviewTarget",
                ]),
          allocation: input.strategy.allocation,
          passAuditMinimumEdge: input.strategy.passAuditMinimumEdge,
          reconciliationTolerance: input.strategy.reconciliationTolerance,
          executionCooldownMilliseconds:
            input.strategy.executionCooldownMilliseconds,
        },
      },
      identity.secretValues,
    ),
  };
}

export function renderedInputProvenance(
  prompt: DecisionPrompt,
  secretValues: readonly string[],
): unknown {
  return {
    schemaVersion: 1,
    classification: "PRIVATE_RUNTIME",
    prompt: redactedProvenanceSnapshot(prompt, secretValues),
  };
}

export interface DecisionRequestProvenance {
  readonly schemaVersion: 1;
  readonly classification: "PRIVATE_RUNTIME";
  readonly phase: "PREPARED_BEFORE_SEND";
  readonly round: number;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly request: {
    readonly sha256: string;
    readonly redacted: boolean;
    /** Exact serialized redacted initial payload; later rounds retain identity. */
    readonly initialBodyJson?: string;
  };
  readonly tools: ReturnType<typeof redactedProvenanceSnapshot>;
  readonly settings: ReturnType<typeof redactedProvenanceSnapshot>;
  readonly limits: DecisionLimits;
}

export function decisionRequestProvenance(input: {
  readonly round: number;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly limits: DecisionLimits;
  readonly secretValues: readonly string[];
}): DecisionRequestProvenance {
  const snapshot = redactedProvenanceSnapshot(input.body, input.secretValues);
  const settings = Object.fromEntries(
    Object.entries(input.body).filter(
      ([key]) =>
        !["system", "instructions", "messages", "input", "tools"].includes(key),
    ),
  );
  return {
    schemaVersion: 1,
    classification: "PRIVATE_RUNTIME",
    phase: "PREPARED_BEFORE_SEND",
    round: input.round,
    provider: redactText(input.provider, input.secretValues),
    model: redactText(input.model, input.secretValues),
    endpoint: redactText(input.endpoint, input.secretValues),
    request: {
      sha256: snapshot.sha256,
      redacted: snapshot.redacted,
      ...(input.round === 1 ? { initialBodyJson: snapshot.json } : {}),
    },
    tools: redactedProvenanceSnapshot(
      input.body.tools ?? [],
      input.secretValues,
    ),
    settings: redactedProvenanceSnapshot(settings, input.secretValues),
    limits: input.limits,
  };
}
