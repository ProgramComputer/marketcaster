import { z } from "zod";
import type { AgentDecision } from "../agent/decision-schema.js";
import { extractAnthropicEvidenceSources } from "../agent/evidence-provenance.js";
import {
  type AgentInput,
  type DecisionCacheDiagnostic,
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
import {
  definitionsForCatalogModel,
  isCatalogToolName,
  isPrimaryModelHandoffToolName,
  PRIMARY_MODEL_HANDOFF_RESULT,
  PRIMARY_MODEL_HANDOFF_TOOL_NAME,
} from "./model-routing.js";

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_CACHE_DIAGNOSTICS_BETA = "cache-diagnosis-2026-04-07";
const ANTHROPIC_CONTEXT_PRESSURE_INPUT_TOKENS = 175_000;
const ANTHROPIC_CONTEXT_PRESSURE_OUTPUT_TOKENS = 4096;
const ANTHROPIC_STABLE_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "1h",
} as const;
const TokenCountSchema = z.number().int().nonnegative();

const AnthropicCacheMissReasonSchema = z
  .object({
    type: z.string().min(1),
    cache_missed_input_tokens: TokenCountSchema.optional(),
  })
  .loose();

const AnthropicDiagnosticsSchema = z.union([
  z.null(),
  z
    .object({
      cache_miss_reason: z
        .union([z.null(), AnthropicCacheMissReasonSchema])
        .optional(),
    })
    .loose(),
]);

const AnthropicUsageSchema = z
  .object({
    input_tokens: TokenCountSchema.optional(),
    output_tokens: TokenCountSchema.optional(),
    cache_creation_input_tokens: TokenCountSchema.optional(),
    cache_read_input_tokens: TokenCountSchema.optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: TokenCountSchema.optional(),
        ephemeral_1h_input_tokens: TokenCountSchema.optional(),
      })
      .loose()
      .optional(),
    server_tool_use: z
      .object({
        web_search_requests: TokenCountSchema.optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const AnthropicResponseSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
    diagnostics: AnthropicDiagnosticsSchema.optional(),
    stop_reason: z.string().nullable(),
    usage: AnthropicUsageSchema.optional(),
  })
  .loose();

const AnthropicToolUseSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .loose();

const AnthropicServerWebSearchResultSchema = z
  .object({
    type: z.literal("web_search_tool_result"),
    tool_use_id: z.string().min(1),
    content: z.unknown().optional(),
  })
  .loose();

function serverWebSearchResultSucceeded(
  result: z.infer<typeof AnthropicServerWebSearchResultSchema>,
): boolean {
  const content = result.content;
  const items: readonly unknown[] = Array.isArray(content)
    ? (content as readonly unknown[])
    : [content];
  return !items.some((item) => {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      return false;
    }
    const type: unknown = item.type;
    return (
      typeof type === "string" &&
      type.toLocaleLowerCase("en-US").includes("error")
    );
  });
}

export interface AnthropicDecisionProviderOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly catalogModelId?: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly previousMessageId?: string;
}

function requiredValue(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function requestIdentifier(response: Response): string | undefined {
  return response.headers.get("request-id") ?? undefined;
}

async function parseResponseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) {
    throw new DecisionProviderError(
      "Anthropic returned an empty response",
      "INVALID_RESPONSE",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new DecisionProviderError(
      "Anthropic returned malformed JSON",
      "INVALID_RESPONSE",
      { cause: error },
    );
  }
}

function providerErrorDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("error" in parsed) ||
      typeof parsed.error !== "object" ||
      parsed.error === null ||
      !("message" in parsed.error) ||
      typeof parsed.error.message !== "string"
    ) {
      return undefined;
    }
    const detail = parsed.error.message.replace(/\s+/gu, " ").trim();
    return detail.length === 0 ? undefined : detail.slice(0, 500);
  } catch {
    return undefined;
  }
}

async function providerHttpError(
  response: Response,
  attempts: number,
): Promise<DecisionProviderError> {
  const identifier = requestIdentifier(response);
  let detail: string | undefined;
  try {
    detail = providerErrorDetail(await response.text());
  } catch {
    detail = undefined;
  }
  return new DecisionProviderError(
    `Anthropic request failed with HTTP ${response.status}${identifier === undefined ? "" : ` (request ${identifier})`}${attempts === 1 ? "" : ` after ${attempts} attempts`}${detail === undefined ? "" : `: ${detail}`}`,
    "HTTP",
  );
}

function inputTokenCount(
  usage: z.infer<typeof AnthropicUsageSchema>,
): number | undefined {
  if (usage.input_tokens === undefined) return undefined;
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function tokenUsage(
  usage: z.infer<typeof AnthropicUsageSchema>,
): DecisionProviderTokenUsage | undefined {
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cachedInputTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cache_creation_input_tokens }),
    ...(usage.cache_creation?.ephemeral_5m_input_tokens === undefined
      ? {}
      : {
          cacheCreation5mInputTokens:
            usage.cache_creation.ephemeral_5m_input_tokens,
        }),
    ...(usage.cache_creation?.ephemeral_1h_input_tokens === undefined
      ? {}
      : {
          cacheCreation1hInputTokens:
            usage.cache_creation.ephemeral_1h_input_tokens,
        }),
  };
}

function cacheDiagnostic(
  response: z.infer<typeof AnthropicResponseSchema>,
): DecisionCacheDiagnostic {
  const diagnostics = response.diagnostics;
  if (diagnostics === undefined) return { state: "NOT_RETURNED" };
  if (diagnostics === null) return { state: "DIAGNOSTICS_NULL" };
  if (!Object.hasOwn(diagnostics, "cache_miss_reason")) {
    return { state: "CACHE_MISS_REASON_OMITTED" };
  }
  const reason = diagnostics.cache_miss_reason;
  if (reason === null || reason === undefined) {
    return { state: "CACHE_MISS_REASON_NULL" };
  }
  return {
    state: "CACHE_MISS",
    reasonType: reason.type,
    ...(reason.cache_missed_input_tokens === undefined
      ? {}
      : { missedInputTokens: reason.cache_missed_input_tokens }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function transferableAnthropicMessages(
  messages: readonly unknown[],
): unknown[] {
  const handoffCallIds = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        block.name === PRIMARY_MODEL_HANDOFF_TOOL_NAME &&
        typeof block.id === "string"
      ) {
        handoffCallIds.add(block.id);
      }
    }
  }

  return messages.flatMap((message) => {
    if (!isRecord(message)) return [];
    if (message.role === "user" && typeof message.content === "string") {
      return [message];
    }
    if (!Array.isArray(message.content)) return [];
    if (message.role === "assistant") {
      const content = message.content.filter(
        (block) =>
          isRecord(block) &&
          block.type === "tool_use" &&
          block.name !== PRIMARY_MODEL_HANDOFF_TOOL_NAME,
      );
      return content.length === 0 ? [] : [{ role: "assistant", content }];
    }
    if (message.role === "user") {
      const content = message.content.filter(
        (block) =>
          isRecord(block) &&
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          !handoffCallIds.has(block.tool_use_id),
      );
      return content.length === 0 ? [] : [{ role: "user", content }];
    }
    return [];
  });
}

export class AnthropicDecisionProvider implements DecisionProvider {
  public readonly providerId = "anthropic";
  public readonly modelId: string;
  public readonly catalogModelId?: string;
  readonly #apiKey: string;
  readonly #fetch: FetchImplementation;
  #previousMessageId: string | null;

  public constructor(options: AnthropicDecisionProviderOptions) {
    this.#apiKey = requiredValue(options.apiKey, "Anthropic API key");
    this.modelId = requiredValue(options.modelId, "Anthropic model ID");
    const catalogModelId = options.catalogModelId?.trim();
    if (
      catalogModelId !== undefined &&
      catalogModelId.length > 0 &&
      catalogModelId !== this.modelId
    ) {
      this.catalogModelId = catalogModelId;
    }
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#previousMessageId =
      options.previousMessageId === undefined
        ? null
        : requiredValue(
            options.previousMessageId,
            "Anthropic diagnostics previous message ID",
          );
  }

  public async decide(input: AgentInput): Promise<AgentDecision> {
    const limits = resolveDecisionLimits(input.limits);
    return runWithDecisionDeadline(
      limits.timeoutMilliseconds,
      input.signal,
      async (signal) => {
        const researchSession = input.researchTools.createSession(limits);
        let serverWebSearchCount = 0;
        const messages: unknown[] = [
          { role: "user", content: input.prompt.user },
        ];

        let initialRounds = 0;
        let repairRounds = 0;
        let repairActive = false;
        let repairAttemptsOffered = 0;
        let transcriptRound = 0;
        let previousInputTokens: number | undefined;
        let diagnosticsPreviousMessageId = this.#previousMessageId;
        let catalogPhaseActive = this.catalogModelId !== undefined;
        let previousRequestModelId: string | undefined;
        while (
          repairActive
            ? repairRounds < MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS
            : initialRounds < limits.maximumRounds
        ) {
          const contextPressure =
            previousInputTokens !== undefined &&
            previousInputTokens >= ANTHROPIC_CONTEXT_PRESSURE_INPUT_TOKENS;
          const finalRound =
            contextPressure ||
            (repairActive
              ? repairRounds === MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS - 1
              : initialRounds === limits.maximumRounds - 1);
          const useCatalogModel =
            catalogPhaseActive && !repairActive && !finalRound;
          const requestModelId = useCatalogModel
            ? (this.catalogModelId ?? this.modelId)
            : this.modelId;
          if (
            previousRequestModelId !== undefined &&
            previousRequestModelId !== requestModelId
          ) {
            const transferableMessages =
              transferableAnthropicMessages(messages);
            messages.length = 0;
            messages.push(...transferableMessages);
            diagnosticsPreviousMessageId = null;
            previousInputTokens = undefined;
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
          const remainingServerWebSearches =
            limits.maximumWebSearches - serverWebSearchCount;
          const useServerWebSearch =
            !useCatalogModel &&
            !input.researchTools.hasClientWebSearchHandler &&
            limits.maximumWebSearches > 0;
          const providerTools: Record<string, unknown>[] = [
            ...(useServerWebSearch
              ? [
                  {
                    type: "web_search_20250305",
                    name: "web_search",
                    // A fixed total limit keeps this tool definition cacheable
                    // across every continuation. The configured total equals
                    // the per-response limit for this bounded decision loop.
                    max_uses: limits.maximumWebSearches,
                  },
                ]
              : []),
            ...definitions
              .filter(
                (definition) =>
                  definition.name !== "web_search" ||
                  input.researchTools.hasClientWebSearchHandler,
              )
              .map((definition) => ({
                name: definition.name,
                description: definition.description,
                input_schema: definition.inputSchema,
              })),
          ];
          const finalProviderTool = providerTools.at(-1);
          if (finalProviderTool !== undefined) {
            finalProviderTool.cache_control = ANTHROPIC_STABLE_CACHE_CONTROL;
          }
          const toolChoice = finalRound
            ? { type: "tool", name: "submit_trade_plan" }
            : { type: "any" };
          const comparedMessageId = diagnosticsPreviousMessageId;
          const providerRequest = await fetchProviderResponse({
            providerName: "Anthropic",
            fetchImplementation: this.#fetch,
            url: ANTHROPIC_MESSAGES_ENDPOINT,
            init: {
              method: "POST",
              headers: {
                "x-api-key": this.#apiKey,
                "anthropic-version": ANTHROPIC_API_VERSION,
                "anthropic-beta": ANTHROPIC_CACHE_DIAGNOSTICS_BETA,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: requestModelId,
                max_tokens: contextPressure
                  ? Math.min(
                      limits.maximumOutputTokens,
                      ANTHROPIC_CONTEXT_PRESSURE_OUTPUT_TOKENS,
                    )
                  : limits.maximumOutputTokens,
                system: [
                  {
                    type: "text",
                    text: input.prompt.system,
                    cache_control: ANTHROPIC_STABLE_CACHE_CONTROL,
                  },
                ],
                messages,
                tools: providerTools,
                cache_control: { type: "ephemeral" },
                diagnostics: { previous_message_id: comparedMessageId },
                tool_choice: toolChoice,
              }),
              signal,
            },
          });
          const { response } = providerRequest;
          if (!response.ok) {
            throw await providerHttpError(response, providerRequest.attempts);
          }

          const responseBody = await parseResponseJson(response);
          const parsedResponse =
            AnthropicResponseSchema.safeParse(responseBody);
          if (!parsedResponse.success) {
            await input.recordTranscriptRound?.({
              round: transcriptRound,
              modelId: requestModelId,
              response: responseBody,
              toolCalls: [],
              toolResults: [],
              providerWebSearchCount: 0,
              providerRequestAttempts: providerRequest.attempts,
              diagnosticsPreviousMessageId: comparedMessageId,
            });
            throw new DecisionProviderError(
              "Anthropic response did not match the expected API shape",
              "INVALID_RESPONSE",
              { cause: parsedResponse.error },
            );
          }
          diagnosticsPreviousMessageId = parsedResponse.data.id;
          this.#previousMessageId = parsedResponse.data.id;
          const observedCacheDiagnostic = cacheDiagnostic(parsedResponse.data);
          const calls = parsedResponse.data.content.flatMap((item) => {
            const parsed = AnthropicToolUseSchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          });
          const transcriptToolCalls: DecisionToolCallTranscript[] = calls.map(
            (call) => ({
              callId: call.id,
              name: call.name,
              input: call.input,
            }),
          );
          const transcriptToolResults: DecisionToolResultTranscript[] = [];
          const serverWebSearchResults = parsedResponse.data.content.flatMap(
            (item) => {
              const parsed =
                AnthropicServerWebSearchResultSchema.safeParse(item);
              return parsed.success ? [parsed.data] : [];
            },
          );
          const completedServerWebSearchIds = new Set(
            serverWebSearchResults.map((result) => result.tool_use_id),
          );
          const successfulServerWebSearchCount = serverWebSearchResults.filter(
            serverWebSearchResultSucceeded,
          ).length;
          const observedServerWebSearches =
            parsedResponse.data.usage?.server_tool_use?.web_search_requests ??
            completedServerWebSearchIds.size;
          const observedTokenUsage =
            parsedResponse.data.usage === undefined
              ? undefined
              : tokenUsage(parsedResponse.data.usage);
          if (parsedResponse.data.usage !== undefined) {
            previousInputTokens = inputTokenCount(parsedResponse.data.usage);
          }
          const toolResults: unknown[] = [];
          try {
            if (observedServerWebSearches > remainingServerWebSearches) {
              throw new DecisionProviderError(
                "Anthropic exceeded the configured web-search limit",
                "TOOL_LIMIT",
              );
            }
            if (useCatalogModel && observedServerWebSearches > 0) {
              throw new DecisionProviderError(
                "The catalog model attempted provider web search outside its permitted phase",
                "INVALID_RESPONSE",
              );
            }
            serverWebSearchCount += observedServerWebSearches;
            input.researchTools.recordProviderWebSearches(
              observedServerWebSearches,
              Math.min(
                observedServerWebSearches,
                successfulServerWebSearchCount,
              ),
            );
            input.researchTools.recordProviderEvidenceSources(
              extractAnthropicEvidenceSources(responseBody),
            );
            if (calls.length === 0) {
              if (
                parsedResponse.data.stop_reason === "pause_turn" &&
                !finalRound
              ) {
                messages.push({
                  role: "assistant",
                  content: parsedResponse.data.content,
                });
                continue;
              }
              throw new DecisionProviderError(
                `Anthropic stopped with ${parsedResponse.data.stop_reason ?? "no reason"} without calling a permitted tool`,
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
                "Anthropic combined a terminal or model-handoff call with another tool call",
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

            messages.push({
              role: "assistant",
              content: parsedResponse.data.content,
            });
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
                    decisionToolResultTranscript(call.id, call.name, result),
                  );
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: result.content,
                    is_error: false,
                  });
                  continue;
                }
                const result = await researchSession.execute(
                  call.name,
                  call.input,
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
                      decisionToolResultTranscript(call.id, call.name, result),
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
                      call.id,
                      call.name,
                      disposition.toolResult,
                    ),
                  );
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: disposition.toolResult.content,
                    is_error: true,
                  });
                } else {
                  transcriptToolResults.push(
                    decisionToolResultTranscript(call.id, call.name, result),
                  );
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: result.content,
                    is_error: result.isError,
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
                    "Anthropic submitted a decision that failed schema validation",
                    "INVALID_DECISION",
                    { cause: error },
                  );
                }
                throw error;
              }
            }
            messages.push({ role: "user", content: toolResults });
          } finally {
            await input.recordTranscriptRound?.({
              round: transcriptRound,
              modelId: requestModelId,
              response: responseBody,
              toolCalls: transcriptToolCalls,
              toolResults: transcriptToolResults,
              providerWebSearchCount: observedServerWebSearches,
              providerRequestAttempts: providerRequest.attempts,
              diagnosticsPreviousMessageId: comparedMessageId,
              cacheDiagnostic: observedCacheDiagnostic,
              ...(observedTokenUsage === undefined
                ? {}
                : { tokenUsage: observedTokenUsage }),
            });
          }
        }

        throw new DecisionProviderError(
          repairActive
            ? "Anthropic exhausted the bounded decision-repair rounds without a replacement plan"
            : "Anthropic exhausted the decision round limit without submitting a plan",
          "ROUND_LIMIT",
        );
      },
    );
  }
}
