import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type AgentInput,
  type DecisionProviderTokenUsage,
  decisionToolResultTranscript,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionToolCallTranscript,
  type DecisionToolResultTranscript,
  type FetchImplementation,
  fetchProviderResponse,
  MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS,
  MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS,
  resolveDecisionLimits,
  reviewDecisionSubmission,
  runWithDecisionDeadline,
} from "./decision-provider.js";
import { ResearchToolLimitError } from "./research-tools.js";
import type { AgentDecision } from "../agent/decision-schema.js";
import { extractOpenAIEvidenceSources } from "../agent/evidence-provenance.js";
import {
  definitionsForCatalogModel,
  isCatalogToolName,
  isPrimaryModelHandoffToolName,
  PRIMARY_MODEL_HANDOFF_RESULT,
  PRIMARY_MODEL_HANDOFF_TOOL_NAME,
} from "./model-routing.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_COMPACT_THRESHOLD_TOKENS = 200_000;

const TokenCountSchema = z.number().int().nonnegative();
const OpenAIUsageSchema = z
  .object({
    input_tokens: TokenCountSchema,
    output_tokens: TokenCountSchema,
    total_tokens: TokenCountSchema.optional(),
    input_tokens_details: z
      .object({ cached_tokens: TokenCountSchema.optional() })
      .loose()
      .optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: TokenCountSchema.optional() })
      .loose()
      .optional(),
  })
  .loose();

const OpenAIResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z
      .enum([
        "completed",
        "failed",
        "in_progress",
        "cancelled",
        "queued",
        "incomplete",
      ])
      .optional(),
    output: z.array(z.unknown()),
    usage: OpenAIUsageSchema.optional(),
  })
  .loose();

const OpenAIFunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .loose();

const OpenAIWebSearchCallSchema = z
  .object({
    type: z.literal("web_search_call"),
    status: z
      .enum(["in_progress", "searching", "completed", "failed"])
      .optional(),
  })
  .loose();

export interface OpenAIDecisionProviderOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly catalogModelId?: string;
  readonly baseURL?: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly compactThresholdTokens?: number;
}

function nonEmptySecret(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function responsesEndpoint(baseURL = DEFAULT_OPENAI_BASE_URL): string {
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("OpenAI base URL must use HTTP or HTTPS");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError("OpenAI base URL must not include a query or fragment");
  }

  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
  return url.toString();
}

function requestIdentifier(response: Response): string | undefined {
  return response.headers.get("x-request-id") ?? undefined;
}

async function parseResponseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) {
    throw new DecisionProviderError(
      "OpenAI returned an empty response",
      "INVALID_RESPONSE",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new DecisionProviderError(
      "OpenAI returned malformed JSON",
      "INVALID_RESPONSE",
      { cause: error },
    );
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new DecisionProviderError(
      "OpenAI returned malformed tool arguments",
      "INVALID_RESPONSE",
      { cause: error },
    );
  }
}

function transcriptArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenUsage(
  usage: z.infer<typeof OpenAIUsageSchema>,
): DecisionProviderTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.total_tokens === undefined
      ? {}
      : { totalTokens: usage.total_tokens }),
    ...(usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : {
          reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
        }),
  };
}

function providerHttpError(
  response: Response,
  attempts: number,
): DecisionProviderError {
  const identifier = requestIdentifier(response);
  return new DecisionProviderError(
    `OpenAI request failed with HTTP ${response.status}${identifier === undefined ? "" : ` (request ${identifier})`}${attempts === 1 ? "" : ` after ${attempts} attempts`}`,
    "HTTP",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function transferableOpenAIConversationInput(
  input: readonly unknown[],
): unknown[] {
  const handoffCallIds = new Set(
    input.flatMap((item) =>
      isRecord(item) &&
      item.type === "function_call" &&
      item.name === PRIMARY_MODEL_HANDOFF_TOOL_NAME &&
      typeof item.call_id === "string"
        ? [item.call_id]
        : [],
    ),
  );
  return input.filter((item) => {
    if (!isRecord(item)) return false;
    if (item.role === "user") return true;
    if (item.type === "function_call") {
      return item.name !== PRIMARY_MODEL_HANDOFF_TOOL_NAME;
    }
    if (item.type === "function_call_output") {
      return (
        typeof item.call_id === "string" && !handoffCallIds.has(item.call_id)
      );
    }
    return false;
  });
}

export class OpenAIDecisionProvider implements DecisionProvider {
  public readonly providerId = "openai";
  public readonly modelId: string;
  public readonly catalogModelId?: string;
  readonly #apiKey: string;
  readonly #fetch: FetchImplementation;
  readonly #responsesEndpoint: string;
  readonly #compactThresholdTokens: number;

  public constructor(options: OpenAIDecisionProviderOptions) {
    this.#apiKey = nonEmptySecret(options.apiKey, "OpenAI API key");
    this.modelId = nonEmptySecret(options.modelId, "OpenAI model ID");
    const catalogModelId = options.catalogModelId?.trim();
    if (
      catalogModelId !== undefined &&
      catalogModelId.length > 0 &&
      catalogModelId !== this.modelId
    ) {
      this.catalogModelId = catalogModelId;
    }
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#responsesEndpoint = responsesEndpoint(options.baseURL);
    this.#compactThresholdTokens =
      options.compactThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS;
    if (
      !Number.isInteger(this.#compactThresholdTokens) ||
      this.#compactThresholdTokens <= 0
    ) {
      throw new RangeError(
        "OpenAI compact threshold must be a positive integer",
      );
    }
  }

  public async decide(input: AgentInput): Promise<AgentDecision> {
    const limits = resolveDecisionLimits(input.limits);
    return runWithDecisionDeadline(
      limits.timeoutMilliseconds,
      input.signal,
      async (signal) => {
        const researchSession = input.researchTools.createSession(limits);
        let serverWebSearchCount = 0;
        const conversationInput: unknown[] = [
          {
            role: "user",
            content: [{ type: "input_text", text: input.prompt.user }],
          },
        ];

        let initialRounds = 0;
        let repairRounds = 0;
        let repairActive = false;
        let repairAttemptsOffered = 0;
        let transcriptRound = 0;
        let catalogPhaseActive = this.catalogModelId !== undefined;
        let previousRequestModelId: string | undefined;
        while (
          repairActive
            ? repairRounds < MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS
            : initialRounds < limits.maximumRounds
        ) {
          const finalRound = repairActive
            ? repairRounds === MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS - 1
            : initialRounds === limits.maximumRounds - 1;
          const useCatalogModel =
            catalogPhaseActive && !repairActive && !finalRound;
          const requestModelId = useCatalogModel
            ? (this.catalogModelId ?? this.modelId)
            : this.modelId;
          if (
            previousRequestModelId !== undefined &&
            previousRequestModelId !== requestModelId
          ) {
            const transferableInput =
              transferableOpenAIConversationInput(conversationInput);
            conversationInput.length = 0;
            conversationInput.push(...transferableInput);
          }
          previousRequestModelId = requestModelId;
          if (repairActive) repairRounds += 1;
          else initialRounds += 1;
          transcriptRound += 1;
          const roundDefinitions =
            input.researchTools.definitionsForRound(finalRound);
          const definitions = useCatalogModel
            ? definitionsForCatalogModel(roundDefinitions)
            : roundDefinitions;
          const remainingWebSearches =
            limits.maximumWebSearches - serverWebSearchCount;
          const serverWebSearchEnabled =
            !useCatalogModel && !finalRound && remainingWebSearches > 0;
          const providerTools: unknown[] = [
            ...(serverWebSearchEnabled ? [{ type: "web_search" }] : []),
            ...definitions
              .filter((definition) => definition.name !== "web_search")
              .map((definition) => ({
                type: "function",
                name: definition.name,
                description: definition.description,
                parameters: definition.inputSchema,
                strict: true,
              })),
          ];
          const promptCacheKey = fingerprint({
            model: requestModelId,
            tools: providerTools,
            instructions: input.prompt.system,
          });
          const providerRequest = await fetchProviderResponse({
            providerName: "OpenAI",
            fetchImplementation: this.#fetch,
            url: this.#responsesEndpoint,
            init: {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.#apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: requestModelId,
                prompt_cache_key: promptCacheKey,
                instructions: input.prompt.system,
                input: conversationInput,
                tools: providerTools,
                tool_choice: "required",
                parallel_tool_calls: false,
                ...(serverWebSearchEnabled
                  ? {
                      max_tool_calls: Math.min(
                        limits.maximumProviderWebSearchesPerResponse,
                        remainingWebSearches,
                      ),
                    }
                  : {}),
                max_output_tokens: limits.maximumOutputTokens,
                store: false,
                context_management: [
                  {
                    type: "compaction",
                    compact_threshold: this.#compactThresholdTokens,
                  },
                ],
              }),
              signal,
            },
          });
          const { response } = providerRequest;
          if (!response.ok) {
            throw providerHttpError(response, providerRequest.attempts);
          }

          const responseBody = await parseResponseJson(response);
          const parsedResponse = OpenAIResponseSchema.safeParse(responseBody);
          if (!parsedResponse.success) {
            await input.recordTranscriptRound?.({
              round: transcriptRound,
              modelId: requestModelId,
              response: responseBody,
              toolCalls: [],
              toolResults: [],
              providerWebSearchCount: 0,
              providerRequestAttempts: providerRequest.attempts,
              promptCacheKey,
            });
            throw new DecisionProviderError(
              "OpenAI response did not match the expected API shape",
              "INVALID_RESPONSE",
              { cause: parsedResponse.error },
            );
          }
          const calls = parsedResponse.data.output.flatMap((item) => {
            const parsed = OpenAIFunctionCallSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          });
          const transcriptToolCalls: DecisionToolCallTranscript[] = calls.map(
            (call) => ({
              callId: call.call_id,
              name: call.name,
              input: transcriptArguments(call.arguments),
            }),
          );
          const transcriptToolResults: DecisionToolResultTranscript[] = [];
          const webSearchCalls = parsedResponse.data.output.flatMap((item) => {
            const parsed = OpenAIWebSearchCallSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          });
          const attemptedWebSearchCount = webSearchCalls.length;
          const successfulWebSearchCount = webSearchCalls.filter(
            (call) => call.status === undefined || call.status === "completed",
          ).length;
          try {
            if (
              parsedResponse.data.status !== undefined &&
              parsedResponse.data.status !== "completed"
            ) {
              throw new DecisionProviderError(
                `OpenAI response ended with status ${parsedResponse.data.status}`,
                "INVALID_RESPONSE",
              );
            }

            if (attemptedWebSearchCount > remainingWebSearches) {
              throw new DecisionProviderError(
                "OpenAI exceeded the configured web-search limit",
                "TOOL_LIMIT",
              );
            }
            if (useCatalogModel && attemptedWebSearchCount > 0) {
              throw new DecisionProviderError(
                "The catalog model attempted provider web search outside its permitted phase",
                "INVALID_RESPONSE",
              );
            }
            serverWebSearchCount += attemptedWebSearchCount;
            input.researchTools.recordProviderWebSearches(
              attemptedWebSearchCount,
              successfulWebSearchCount,
            );
            input.researchTools.recordProviderEvidenceSources(
              extractOpenAIEvidenceSources(responseBody),
            );
            if (calls.length === 0) {
              if (attemptedWebSearchCount > 0 && !finalRound) {
                conversationInput.push(...parsedResponse.data.output);
                continue;
              }
              throw new DecisionProviderError(
                "OpenAI did not call a permitted decision tool",
                "INVALID_RESPONSE",
              );
            }
            if (
              calls.length > 1 &&
              calls.some(
                (call) =>
                  call.name === "submit_trade_plan" ||
                  isPrimaryModelHandoffToolName(call.name),
              )
            ) {
              throw new DecisionProviderError(
                "OpenAI combined a terminal or model-handoff call with another tool call",
                "INVALID_RESPONSE",
              );
            }
            if (
              useCatalogModel &&
              calls.some(
                (call) =>
                  !isCatalogToolName(call.name) &&
                  !isPrimaryModelHandoffToolName(call.name),
              )
            ) {
              throw new DecisionProviderError(
                "The catalog model called a tool outside its permitted catalog phase",
                "INVALID_RESPONSE",
              );
            }

            // Replaying every output item retains reasoning and any encrypted
            // compaction state while a model remains active. On handoff, only
            // provider-neutral tool calls and results cross the model boundary.
            conversationInput.push(...parsedResponse.data.output);
            for (const call of calls) {
              try {
                if (isPrimaryModelHandoffToolName(call.name)) {
                  catalogPhaseActive = false;
                  const result = {
                    kind: "TOOL_RESULT",
                    content: PRIMARY_MODEL_HANDOFF_RESULT,
                    isError: false,
                  } as const;
                  transcriptToolResults.push(
                    decisionToolResultTranscript(
                      call.call_id,
                      call.name,
                      result,
                    ),
                  );
                  conversationInput.push({
                    type: "function_call_output",
                    call_id: call.call_id,
                    output: result.content,
                  });
                  continue;
                }
                const result = await researchSession.execute(
                  call.name,
                  parseArguments(call.arguments),
                  signal,
                );
                if (result.kind === "DECISION") {
                  const disposition = await reviewDecisionSubmission(
                    input,
                    result.decision,
                    signal,
                    repairAttemptsOffered,
                  );
                  if (disposition.kind === "FINAL") {
                    transcriptToolResults.push(
                      decisionToolResultTranscript(
                        call.call_id,
                        call.name,
                        result,
                      ),
                    );
                    return result.decision;
                  }
                  repairAttemptsOffered += 1;
                  repairActive = true;
                  repairRounds = 0;
                  researchSession.reopenForTerminalDecisionRepair(
                    MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS,
                  );
                  transcriptToolResults.push(
                    decisionToolResultTranscript(
                      call.call_id,
                      call.name,
                      disposition.toolResult,
                    ),
                  );
                  conversationInput.push({
                    type: "function_call_output",
                    call_id: call.call_id,
                    output: disposition.toolResult.content,
                  });
                } else {
                  transcriptToolResults.push(
                    decisionToolResultTranscript(
                      call.call_id,
                      call.name,
                      result,
                    ),
                  );
                  conversationInput.push({
                    type: "function_call_output",
                    call_id: call.call_id,
                    output: result.content,
                  });
                }
              } catch (error) {
                if (error instanceof ResearchToolLimitError) {
                  throw new DecisionProviderError(error.message, "TOOL_LIMIT", {
                    cause: error,
                  });
                }
                if (
                  call.name === "submit_trade_plan" &&
                  error instanceof z.ZodError
                ) {
                  throw new DecisionProviderError(
                    "OpenAI submitted a decision that failed schema validation",
                    "INVALID_DECISION",
                    { cause: error },
                  );
                }
                throw error;
              }
            }
          } finally {
            await input.recordTranscriptRound?.({
              round: transcriptRound,
              modelId: requestModelId,
              response: responseBody,
              toolCalls: transcriptToolCalls,
              toolResults: transcriptToolResults,
              providerWebSearchCount: attemptedWebSearchCount,
              providerRequestAttempts: providerRequest.attempts,
              promptCacheKey,
              ...(parsedResponse.data.usage === undefined
                ? {}
                : { tokenUsage: tokenUsage(parsedResponse.data.usage) }),
            });
          }
        }

        throw new DecisionProviderError(
          repairActive
            ? "OpenAI exhausted the bounded decision-repair rounds without a replacement plan"
            : "OpenAI exhausted the decision round limit without submitting a plan",
          "ROUND_LIMIT",
        );
      },
    );
  }
}
