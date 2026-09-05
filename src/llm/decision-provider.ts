import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import type { AgentDecision } from "../agent/decision-schema.js";
import type { DecisionPrompt } from "../agent/prompt-builder.js";
import type {
  DecisionResearchTools,
  ToolExecutionResult,
} from "./research-tools.js";

export interface DecisionLimits {
  readonly maximumRounds: number;
  readonly maximumMarketDiscoveryRequests: number;
  readonly maximumWebSearches: number;
  readonly maximumProviderWebSearchesPerResponse: number;
  readonly maximumEvidenceSourceReadRequests: number;
  readonly maximumMarketDetailRequests: number;
  readonly maximumMarketAnalysisRequests: number;
  readonly maximumTradePreviewRequests: number;
  readonly maximumNoteOperations: number;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputTokens: number;
}

export const HARD_MAXIMUM_DECISION_LIMITS: DecisionLimits = Object.freeze({
  maximumRounds: 40,
  maximumMarketDiscoveryRequests: 20,
  maximumWebSearches: 25,
  maximumProviderWebSearchesPerResponse: 2,
  maximumEvidenceSourceReadRequests: 16,
  maximumMarketDetailRequests: 25,
  maximumMarketAnalysisRequests: 20,
  maximumTradePreviewRequests: 12,
  maximumNoteOperations: 20,
  timeoutMilliseconds: 1_500_000,
  maximumOutputTokens: 32_768,
});

export const DEFAULT_DECISION_LIMITS: DecisionLimits = Object.freeze({
  maximumRounds: 40,
  maximumMarketDiscoveryRequests: 10,
  maximumWebSearches: 25,
  maximumProviderWebSearchesPerResponse: 2,
  maximumEvidenceSourceReadRequests: 4,
  maximumMarketDetailRequests: 15,
  maximumMarketAnalysisRequests: 10,
  maximumTradePreviewRequests: 6,
  maximumNoteOperations: 10,
  timeoutMilliseconds: 1_500_000,
  maximumOutputTokens: 8192,
});

const PartialDecisionLimitsSchema = z
  .object({
    maximumRounds: z.number().int().positive().optional(),
    maximumMarketDiscoveryRequests: z.number().int().nonnegative().optional(),
    maximumWebSearches: z.number().int().nonnegative().optional(),
    maximumProviderWebSearchesPerResponse: z
      .number()
      .int()
      .positive()
      .optional(),
    maximumEvidenceSourceReadRequests: z
      .number()
      .int()
      .nonnegative()
      .optional(),
    maximumMarketDetailRequests: z.number().int().nonnegative().optional(),
    maximumMarketAnalysisRequests: z.number().int().nonnegative().optional(),
    maximumTradePreviewRequests: z.number().int().nonnegative().optional(),
    maximumNoteOperations: z.number().int().nonnegative().optional(),
    timeoutMilliseconds: z.number().int().positive().optional(),
    maximumOutputTokens: z.number().int().positive().optional(),
  })
  .strict();

export interface AgentInput {
  readonly prompt: DecisionPrompt;
  readonly researchTools: DecisionResearchTools;
  readonly limits?: Partial<DecisionLimits>;
  readonly signal?: AbortSignal;
  readonly reviewTerminalDecision?: (
    decision: AgentDecision,
    signal: AbortSignal,
  ) => Promise<TerminalDecisionReview>;
  readonly recordTranscriptRound?: (
    round: DecisionTranscriptRound,
  ) => void | Promise<void>;
}

export interface TerminalDecisionRejectedProposal {
  readonly proposalIndex: number;
  readonly marketSlug: string;
  readonly side: string;
  readonly action: string;
  readonly code: string;
  readonly reason: string;
  readonly repairable: boolean;
}

export interface TerminalDecisionRepairFeedback {
  readonly acceptedProposalIndexes: readonly number[];
  readonly rejectedProposals: readonly TerminalDecisionRejectedProposal[];
  readonly instructions: readonly string[];
}

export type TerminalDecisionReview =
  | { readonly repair: false }
  | {
      readonly repair: true;
      readonly feedback: TerminalDecisionRepairFeedback;
    };

export const MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS = 8;
export const MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS = 3;

export interface DecisionToolCallTranscript {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface DecisionToolResultTranscript {
  readonly callId: string;
  readonly name: string;
  readonly result:
    | {
        readonly kind: "TOOL_RESULT";
        readonly content: unknown;
        readonly isError: boolean;
      }
    | { readonly kind: "DECISION" };
}

export interface DecisionTranscriptRound {
  readonly round: number;
  readonly modelId?: string;
  readonly response: unknown;
  readonly toolCalls: readonly DecisionToolCallTranscript[];
  readonly toolResults: readonly DecisionToolResultTranscript[];
  readonly providerWebSearchCount: number;
  readonly providerRequestAttempts?: number;
  readonly tokenUsage?: DecisionProviderTokenUsage;
  readonly promptCacheKey?: string;
  readonly diagnosticsPreviousMessageId?: string | null;
  readonly cacheDiagnostic?: DecisionCacheDiagnostic;
}

/** Provider-neutral preservation of Anthropic's raw cache-diagnostic state. */
export interface DecisionCacheDiagnostic {
  readonly state:
    | "NOT_RETURNED"
    | "DIAGNOSTICS_NULL"
    | "CACHE_MISS_REASON_OMITTED"
    | "CACHE_MISS_REASON_NULL"
    | "CACHE_MISS";
  readonly reasonType?: string;
  readonly missedInputTokens?: number;
}

export interface DecisionProviderTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheCreation5mInputTokens?: number;
  readonly cacheCreation1hInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface DecisionProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly catalogModelId?: string;

  decide(input: AgentInput): Promise<AgentDecision>;
}

export type DecisionProviderErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "INVALID_RESPONSE"
  | "INVALID_DECISION"
  | "TOOL_LIMIT"
  | "ROUND_LIMIT";

export class DecisionProviderError extends Error {
  public constructor(
    message: string,
    public readonly code: DecisionProviderErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DecisionProviderError";
  }
}

export type FetchImplementation = typeof fetch;

const MAXIMUM_PROVIDER_REQUEST_RETRIES = 2;
const INITIAL_PROVIDER_RETRY_DELAY_MILLISECONDS = 500;
const MAXIMUM_PROVIDER_RETRY_DELAY_MILLISECONDS = 30_000;

export interface ProviderFetchResult {
  readonly response: Response;
  readonly attempts: number;
}

function retryableProviderStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value.length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function boundedRetryDelay(
  response: Response | undefined,
  retry: number,
): number {
  const requested =
    response === undefined ? undefined : retryAfterMilliseconds(response);
  const exponential =
    INITIAL_PROVIDER_RETRY_DELAY_MILLISECONDS * 2 ** (retry - 1);
  return Math.min(
    requested ?? exponential,
    MAXIMUM_PROVIDER_RETRY_DELAY_MILLISECONDS,
  );
}

function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  const abortError = (): Error =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error("Provider retry wait was aborted", { cause: signal.reason });
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function transportErrorDescription(error: unknown): string {
  if (!(error instanceof Error)) return "unknown transport error";
  const cause = error.cause;
  if (cause === undefined || cause === null || typeof cause !== "object") {
    return error.message;
  }
  const causeRecord = cause as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  const code =
    typeof causeRecord.code === "string" ? causeRecord.code.trim() : "";
  const message =
    typeof causeRecord.message === "string" ? causeRecord.message.trim() : "";
  const detail = [code, message].filter((value) => value.length > 0).join(": ");
  return detail.length === 0 ? error.message : `${error.message} (${detail})`;
}

/**
 * Gives direct provider integrations the bounded transient-failure behavior
 * normally supplied by official SDKs. Requests are decision-only: no exchange
 * mutation occurs until a completed plan passes the later deterministic guard.
 */
export async function fetchProviderResponse(input: {
  readonly providerName: string;
  readonly fetchImplementation: FetchImplementation;
  readonly url: string;
  readonly init: RequestInit & { readonly signal: AbortSignal };
}): Promise<ProviderFetchResult> {
  const maximumAttempts = MAXIMUM_PROVIDER_REQUEST_RETRIES + 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await input.fetchImplementation(input.url, input.init);
      if (
        attempt === maximumAttempts ||
        !retryableProviderStatus(response.status)
      ) {
        return { response, attempts: attempt };
      }
      await response.body?.cancel().catch(() => undefined);
      await waitForRetry(
        boundedRetryDelay(response, attempt),
        input.init.signal,
      );
    } catch (error) {
      if (input.init.signal.aborted) throw error;
      if (attempt === maximumAttempts) {
        throw new DecisionProviderError(
          `${input.providerName} network request failed after ${attempt} attempts: ${transportErrorDescription(error)}`,
          "NETWORK",
          { cause: error },
        );
      }
      await waitForRetry(
        boundedRetryDelay(undefined, attempt),
        input.init.signal,
      );
    }
  }
  throw new Error("Provider retry loop ended unexpectedly");
}

function parseTranscriptContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

export function decisionToolResultTranscript(
  callId: string,
  name: string,
  result: ToolExecutionResult,
): DecisionToolResultTranscript {
  return {
    callId,
    name,
    result:
      result.kind === "DECISION"
        ? { kind: "DECISION" }
        : {
            kind: "TOOL_RESULT",
            content: parseTranscriptContent(result.content),
            isError: result.isError,
          },
  };
}

export type TerminalDecisionDisposition =
  | { readonly kind: "FINAL" }
  | {
      readonly kind: "REPAIR";
      readonly toolResult: Extract<
        ToolExecutionResult,
        { kind: "TOOL_RESULT" }
      >;
    };

export async function reviewDecisionSubmission(
  input: AgentInput,
  decision: AgentDecision,
  signal: AbortSignal,
  repairAttemptsOffered: number,
): Promise<TerminalDecisionDisposition> {
  const review = await input.reviewTerminalDecision?.(decision, signal);
  if (review?.repair !== true) {
    return { kind: "FINAL" };
  }
  if (repairAttemptsOffered >= MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS) {
    return { kind: "FINAL" };
  }
  const attempt = repairAttemptsOffered + 1;
  return {
    kind: "REPAIR",
    toolResult: {
      kind: "TOOL_RESULT",
      content: JSON.stringify({
        ok: false,
        code: "TRADE_PLAN_VALIDATION_REJECTED",
        message: `Deterministic coverage, evidence provenance, reconciliation, or risk validation rejected the terminal plan. Continue with the remaining research budget, then submit one complete replacement plan. This is bounded repair attempt ${attempt} of ${MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS}.`,
        repair: {
          attempt,
          maximumAttempts: MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS,
          maximumAdditionalRounds: MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS,
          ...review.feedback,
        },
      }),
      isError: true,
    },
  };
}

export function resolveDecisionLimits(
  requested: Partial<DecisionLimits> | undefined,
): DecisionLimits {
  const parsed = PartialDecisionLimitsSchema.parse(requested ?? {});
  const resolved: DecisionLimits = {
    maximumRounds:
      parsed.maximumRounds ?? DEFAULT_DECISION_LIMITS.maximumRounds,
    maximumMarketDiscoveryRequests:
      parsed.maximumMarketDiscoveryRequests ??
      DEFAULT_DECISION_LIMITS.maximumMarketDiscoveryRequests,
    maximumWebSearches:
      parsed.maximumWebSearches ?? DEFAULT_DECISION_LIMITS.maximumWebSearches,
    maximumProviderWebSearchesPerResponse:
      parsed.maximumProviderWebSearchesPerResponse ??
      DEFAULT_DECISION_LIMITS.maximumProviderWebSearchesPerResponse,
    maximumEvidenceSourceReadRequests:
      parsed.maximumEvidenceSourceReadRequests ??
      DEFAULT_DECISION_LIMITS.maximumEvidenceSourceReadRequests,
    maximumMarketDetailRequests:
      parsed.maximumMarketDetailRequests ??
      DEFAULT_DECISION_LIMITS.maximumMarketDetailRequests,
    maximumMarketAnalysisRequests:
      parsed.maximumMarketAnalysisRequests ??
      DEFAULT_DECISION_LIMITS.maximumMarketAnalysisRequests,
    maximumTradePreviewRequests:
      parsed.maximumTradePreviewRequests ??
      DEFAULT_DECISION_LIMITS.maximumTradePreviewRequests,
    maximumNoteOperations:
      parsed.maximumNoteOperations ??
      DEFAULT_DECISION_LIMITS.maximumNoteOperations,
    timeoutMilliseconds:
      parsed.timeoutMilliseconds ?? DEFAULT_DECISION_LIMITS.timeoutMilliseconds,
    maximumOutputTokens:
      parsed.maximumOutputTokens ?? DEFAULT_DECISION_LIMITS.maximumOutputTokens,
  };
  for (const key of Object.keys(
    HARD_MAXIMUM_DECISION_LIMITS,
  ) as (keyof DecisionLimits)[]) {
    if (resolved[key] > HARD_MAXIMUM_DECISION_LIMITS[key]) {
      throw new RangeError(
        `${key} exceeds the hard maximum of ${HARD_MAXIMUM_DECISION_LIMITS[key]}`,
      );
    }
  }
  return resolved;
}

export function decisionLimitsFromConfig(
  config: AgentConfig["agent"],
): DecisionLimits {
  return resolveDecisionLimits({
    maximumRounds: config.maximumRounds,
    maximumMarketDiscoveryRequests: config.maximumMarketDiscoveryRequests,
    maximumWebSearches: config.maximumWebSearches,
    maximumProviderWebSearchesPerResponse:
      config.maximumProviderWebSearchesPerResponse,
    maximumEvidenceSourceReadRequests: config.maximumEvidenceSourceReadRequests,
    maximumMarketDetailRequests: config.maximumMarketDetailRequests,
    maximumMarketAnalysisRequests: config.maximumMarketAnalysisRequests,
    maximumTradePreviewRequests: config.maximumTradePreviewRequests,
    maximumNoteOperations: config.maximumNoteOperations,
    timeoutMilliseconds: config.timeoutSeconds * 1000,
  });
}

export async function runWithDecisionDeadline<T>(
  timeoutMilliseconds: number,
  upstreamSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromUpstream = (): void => {
    controller.abort(upstreamSignal?.reason);
  };
  if (upstreamSignal?.aborted === true) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true,
    });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Decision deadline exceeded"));
  }, timeoutMilliseconds);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = (): void => {
      reject(
        new DecisionProviderError(
          timedOut ? "Decision deadline exceeded" : "Decision was aborted",
          timedOut ? "TIMEOUT" : "ABORTED",
        ),
      );
    };
    if (controller.signal.aborted) {
      rejectForAbort();
    } else {
      controller.signal.addEventListener("abort", rejectForAbort, {
        once: true,
      });
    }
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
