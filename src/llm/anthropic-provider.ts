import { decisionRequestProvenance } from "../reporting/decision-input-provenance.js";
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
  isTradePlanSchemaValidationError,
  MAXIMUM_TRADE_PLAN_SCHEMA_CORRECTION_ATTEMPTS,
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
// Claude versions from these onward reject forced tool_choice and bind thinking
// blocks to an append-only conversation. Later versions inherit the behavior.
const ANTHROPIC_APPEND_ONLY_MINIMUM_VERSIONS: ReadonlyMap<
  string,
  readonly [number, number]
> = new Map([
  ["opus", [5, 5]],
  ["sonnet", [5, 5]],
  ["haiku", [5, 5]],
  ["fable", [5, 1]],
  ["mythos", [5, 1]],
]);
const ANTHROPIC_MODEL_VERSION_PATTERN =
  /(?:^|[^a-z0-9])claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?![0-9])/u;
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

const AnthropicServerToolUseSchema = z
  .object({
    type: z.literal("server_tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
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

function validPreservedServerWebSearchResult(
  result: z.infer<typeof AnthropicServerWebSearchResultSchema>,
): boolean {
  if (!Object.hasOwn(result, "content")) return false;
  const content = result.content;
  if (Array.isArray(content)) {
    return content.every(
      (item) =>
        isRecord(item) &&
        item.type === "web_search_result" &&
        typeof item.url === "string" &&
        typeof item.title === "string" &&
        typeof item.encrypted_content === "string" &&
        (item.page_age === undefined ||
          item.page_age === null ||
          typeof item.page_age === "string"),
    );
  }
  return (
    isRecord(content) &&
    content.type === "web_search_tool_result_error" &&
    typeof content.error_code === "string" &&
    content.error_code.length > 0
  );
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

function requiresAppendOnlyAnthropicConversation(modelId: string): boolean {
  const match = ANTHROPIC_MODEL_VERSION_PATTERN.exec(
    modelId.toLocaleLowerCase("en-US"),
  );
  const minimum =
    match?.[1] === undefined
      ? undefined
      : ANTHROPIC_APPEND_ONLY_MINIMUM_VERSIONS.get(match[1]);
  if (match === null || minimum === undefined) return false;
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

type AnthropicDecisionPhase =
  | "catalog"
  | "research"
  | "final"
  | "schema-correction"
  | "repair-research"
  | "repair-final";

function anthropicPhaseInstruction(phase: AnthropicDecisionPhase): string {
  switch (phase) {
    case "catalog":
      return "Current phase: catalog narrowing. Use only catalog tools. When narrowing is complete, call continue_with_primary_model by itself. Do not call research, persistence, preview, server-search, or submission tools.";
    case "research":
      return "Current phase: primary research. Use only the authorized research tools, or call submit_trade_plan by itself when the plan is ready. Do not call continue_with_primary_model.";
    case "final":
      return "Current phase: terminal submission. Call submit_trade_plan exactly once and do not call any other client or server tool. Prose is not a submitted plan.";
    case "schema-correction":
      return "Current phase: schema correction. Correct the rejected plan and call submit_trade_plan exactly once. Do not call research, catalog, persistence, preview, handoff, or server tools.";
    case "repair-research":
      return "Current phase: substantive decision repair. Research is reopened within the remaining limits. Use only authorized primary-model research tools, or call submit_trade_plan by itself when the replacement plan is ready.";
    case "repair-final":
      return "Current phase: final substantive-repair submission. Call submit_trade_plan exactly once and do not call any other client or server tool. Prose is not a replacement plan.";
  }
}

function appendAnthropicPhaseInstruction(
  messages: unknown[],
  instruction: string,
  requestAlreadySent: boolean,
): void {
  if (!requestAlreadySent) {
    const initialMessage = messages[0];
    if (
      isRecord(initialMessage) &&
      initialMessage.role === "user" &&
      typeof initialMessage.content === "string"
    ) {
      initialMessage.content = `${initialMessage.content}\n\n${instruction}`;
      return;
    }
  }
  messages.push({ role: "user", content: instruction });
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
        let schemaCorrectionAttemptsOffered = 0;
        let schemaCorrectionPending = false;
        let schemaCorrectionFinalRound = false;
        let transcriptRound = 0;
        let previousInputTokens: number | undefined;
        let diagnosticsPreviousMessageId = this.#previousMessageId;
        let catalogPhaseActive = this.catalogModelId !== undefined;
        let previousRequestModelId: string | undefined;
        let previousPhase: AnthropicDecisionPhase | undefined;
        const pendingServerToolUseIds = new Set<string>();
        const seenToolCallIds = new Set<string>();
        const seenServerToolResultIds = new Set<string>();
        let preservedDefinitions:
          | readonly {
              readonly name: string;
              readonly description: string;
              readonly inputSchema: Readonly<Record<string, unknown>>;
            }[]
          | undefined;
        const preserveConversation = [this.modelId, this.catalogModelId].some(
          (modelId) =>
            modelId !== undefined &&
            requiresAppendOnlyAnthropicConversation(modelId),
        );
        while (
          schemaCorrectionPending ||
          (repairActive
            ? repairRounds < MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS
            : initialRounds < limits.maximumRounds)
        ) {
          const schemaCorrectionRound = schemaCorrectionPending;
          schemaCorrectionPending = false;
          const contextPressure =
            previousInputTokens !== undefined &&
            previousInputTokens >= ANTHROPIC_CONTEXT_PRESSURE_INPUT_TOKENS;
          const finalRound: boolean =
            contextPressure ||
            (schemaCorrectionRound
              ? schemaCorrectionFinalRound
              : repairActive
                ? repairRounds === MAXIMUM_TERMINAL_DECISION_REPAIR_ROUNDS - 1
                : initialRounds === limits.maximumRounds - 1);
          const useCatalogModel =
            catalogPhaseActive &&
            !repairActive &&
            !schemaCorrectionRound &&
            !finalRound;
          const requestModelId = useCatalogModel
            ? (this.catalogModelId ?? this.modelId)
            : this.modelId;
          if (
            !preserveConversation &&
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
          if (!schemaCorrectionRound) {
            if (repairActive) repairRounds += 1;
            else initialRounds += 1;
          }
          transcriptRound += 1;
          const roundDefinitions = input.researchTools.definitionsForRound(
            finalRound || schemaCorrectionRound,
          );
          if (preserveConversation && preservedDefinitions === undefined) {
            const routedDefinitions =
              this.catalogModelId === undefined
                ? []
                : definitionsForCatalogModel(roundDefinitions);
            preservedDefinitions = Object.freeze([
              ...roundDefinitions,
              ...routedDefinitions.filter(
                (definition) =>
                  !roundDefinitions.some(
                    (candidate) => candidate.name === definition.name,
                  ),
              ),
            ]);
          }
          // Schema correction keeps the full tool list, including server web
          // search, and forces submit_trade_plan through tool_choice as the
          // final round does, so the cached tools -> system -> messages prefix
          // stays identical to the preceding request.
          const definitions = preserveConversation
            ? (preservedDefinitions ?? roundDefinitions)
            : useCatalogModel
              ? definitionsForCatalogModel(roundDefinitions)
              : roundDefinitions;
          const remainingServerWebSearches =
            limits.maximumWebSearches - serverWebSearchCount;
          const useServerWebSearch =
            (preserveConversation || !useCatalogModel) &&
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
          const phase: AnthropicDecisionPhase = useCatalogModel
            ? "catalog"
            : schemaCorrectionRound
              ? "schema-correction"
              : repairActive
                ? finalRound
                  ? "repair-final"
                  : "repair-research"
                : finalRound
                  ? "final"
                  : "research";
          if (
            preserveConversation &&
            pendingServerToolUseIds.size > 0 &&
            phase !== "research" &&
            phase !== "repair-research"
          ) {
            throw new DecisionProviderError(
              "Anthropic left a server tool unresolved before a restricted decision phase",
              "INVALID_RESPONSE",
            );
          }
          if (preserveConversation && phase !== previousPhase) {
            appendAnthropicPhaseInstruction(
              messages,
              anthropicPhaseInstruction(phase),
              transcriptRound > 1,
            );
            previousPhase = phase;
          }
          const toolChoice = requiresAppendOnlyAnthropicConversation(
            requestModelId,
          )
            ? { type: "auto" }
            : finalRound || schemaCorrectionRound
              ? { type: "tool", name: "submit_trade_plan" }
              : { type: "any" };
          const comparedMessageId = diagnosticsPreviousMessageId;
          const requestBody = {
            model: requestModelId,
            max_tokens: limits.maximumOutputTokens,
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
          };
          await input.recordModelRequest?.(
            decisionRequestProvenance({
              round: transcriptRound,
              provider: this.providerId,
              model: requestModelId,
              endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
              body: requestBody,
              limits,
              secretValues: [
                ...(input.provenanceSecretValues ?? []),
                this.#apiKey,
              ],
            }),
          );
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
              body: JSON.stringify(requestBody),
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
          const serverToolCalls = parsedResponse.data.content.flatMap(
            (item) => {
              const parsed = AnthropicServerToolUseSchema.safeParse(item);
              return parsed.success ? [parsed.data] : [];
            },
          );
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
          const reportedServerWebSearches =
            parsedResponse.data.usage?.server_tool_use?.web_search_requests;
          let observedServerWebSearches =
            reportedServerWebSearches ?? completedServerWebSearchIds.size;
          let providerWebSearchAttemptsToRecord = observedServerWebSearches;
          let providerWebSearchSuccessesToRecord = Math.min(
            observedServerWebSearches,
            successfulServerWebSearchCount,
          );
          const observedTokenUsage =
            parsedResponse.data.usage === undefined
              ? undefined
              : tokenUsage(parsedResponse.data.usage);
          if (parsedResponse.data.usage !== undefined) {
            previousInputTokens = inputTokenCount(parsedResponse.data.usage);
          }
          const toolResults: unknown[] = [];
          try {
            if (preserveConversation) {
              const malformedToolBlock = parsedResponse.data.content.some(
                (item) =>
                  isRecord(item) &&
                  ((item.type === "tool_use" &&
                    !AnthropicToolUseSchema.safeParse(item).success) ||
                    (item.type === "server_tool_use" &&
                      !AnthropicServerToolUseSchema.safeParse(item).success) ||
                    (item.type === "web_search_tool_result" &&
                      !AnthropicServerWebSearchResultSchema.safeParse(item)
                        .success)),
              );
              if (malformedToolBlock) {
                throw new DecisionProviderError(
                  "Anthropic returned a malformed tool-call block",
                  "INVALID_RESPONSE",
                );
              }
              const callIds = [
                ...calls.map((call) => call.id),
                ...serverToolCalls.map((call) => call.id),
              ];
              if (
                new Set(callIds).size !== callIds.length ||
                callIds.some((callId) => seenToolCallIds.has(callId))
              ) {
                throw new DecisionProviderError(
                  "Anthropic returned duplicate or reused tool-call IDs",
                  "INVALID_RESPONSE",
                );
              }
              if (
                calls.length > 0 &&
                parsedResponse.data.stop_reason !== "tool_use"
              ) {
                throw new DecisionProviderError(
                  `Anthropic stopped with ${parsedResponse.data.stop_reason ?? "no reason"} while returning client tool calls`,
                  "INVALID_RESPONSE",
                );
              }
              const catalogDefinitions =
                definitionsForCatalogModel(roundDefinitions);
              const declaredClientNames = new Set(
                definitions
                  .filter(
                    (definition) =>
                      definition.name !== "web_search" ||
                      input.researchTools.hasClientWebSearchHandler,
                  )
                  .map((definition) => definition.name),
              );
              const authorizedNames = new Set(
                (useCatalogModel
                  ? catalogDefinitions.map((definition) => definition.name)
                  : finalRound || schemaCorrectionRound
                    ? ["submit_trade_plan"]
                    : roundDefinitions.map((definition) => definition.name)
                ).filter((name) => declaredClientNames.has(name)),
              );
              if (calls.some((call) => !authorizedNames.has(call.name))) {
                throw new DecisionProviderError(
                  "Anthropic called a tool outside the current decision phase",
                  "INVALID_RESPONSE",
                );
              }
              if (serverToolCalls.some((call) => call.name !== "web_search")) {
                throw new DecisionProviderError(
                  "Anthropic called an unsupported server tool",
                  "INVALID_RESPONSE",
                );
              }
              const currentServerToolUseIds = new Set(
                serverToolCalls.map((call) => call.id),
              );
              const responseServerToolResultIds = serverWebSearchResults.map(
                (result) => result.tool_use_id,
              );
              if (
                new Set(responseServerToolResultIds).size !==
                  responseServerToolResultIds.length ||
                responseServerToolResultIds.some((resultId) =>
                  seenServerToolResultIds.has(resultId),
                ) ||
                serverWebSearchResults.some(
                  (result) => !validPreservedServerWebSearchResult(result),
                )
              ) {
                throw new DecisionProviderError(
                  "Anthropic returned a malformed, duplicate, or reused server-tool result",
                  "INVALID_RESPONSE",
                );
              }
              if (
                serverWebSearchResults.some(
                  (result) =>
                    !currentServerToolUseIds.has(result.tool_use_id) &&
                    !pendingServerToolUseIds.has(result.tool_use_id),
                )
              ) {
                throw new DecisionProviderError(
                  "Anthropic returned a server-tool result without a matching call",
                  "INVALID_RESPONSE",
                );
              }
              const pendingBeforeResponse = new Set(pendingServerToolUseIds);
              const completedPendingServerToolUseIds = new Set(
                serverWebSearchResults
                  .filter((result) =>
                    pendingBeforeResponse.has(result.tool_use_id),
                  )
                  .map((result) => result.tool_use_id),
              );
              for (const result of serverWebSearchResults) {
                pendingServerToolUseIds.delete(result.tool_use_id);
                seenServerToolResultIds.add(result.tool_use_id);
              }
              for (const call of serverToolCalls) {
                if (!completedServerWebSearchIds.has(call.id)) {
                  pendingServerToolUseIds.add(call.id);
                }
              }
              for (const callId of callIds) seenToolCallIds.add(callId);

              const identifiedSearchActivity =
                serverToolCalls.length + completedPendingServerToolUseIds.size;
              const unrepresentedReportedSearches = Math.max(
                0,
                (reportedServerWebSearches ?? 0) - identifiedSearchActivity,
              );
              observedServerWebSearches =
                serverToolCalls.length + unrepresentedReportedSearches;
              providerWebSearchAttemptsToRecord =
                serverWebSearchResults.length + unrepresentedReportedSearches;
              providerWebSearchSuccessesToRecord =
                successfulServerWebSearchCount;

              const serverActivity =
                serverToolCalls.length > 0 ||
                serverWebSearchResults.length > 0 ||
                (reportedServerWebSearches ?? 0) > 0;
              const serverSearchAuthorized =
                !useCatalogModel &&
                !finalRound &&
                !schemaCorrectionRound &&
                useServerWebSearch;
              if (serverActivity && !serverSearchAuthorized) {
                throw new DecisionProviderError(
                  "Anthropic attempted provider web search outside its permitted phase",
                  "INVALID_RESPONSE",
                );
              }
              if (
                parsedResponse.data.stop_reason === "pause_turn" &&
                (!serverSearchAuthorized || !serverActivity)
              ) {
                throw new DecisionProviderError(
                  "Anthropic returned an invalid server-tool pause",
                  "INVALID_RESPONSE",
                );
              }
              const terminalOrHandoffCalls = calls.filter(
                (call) =>
                  call.name === "submit_trade_plan" ||
                  isPrimaryModelHandoffToolName(call.name),
              );
              if (
                terminalOrHandoffCalls.length > 0 &&
                (calls.length !== 1 ||
                  serverToolCalls.length > 0 ||
                  unrepresentedReportedSearches > 0 ||
                  pendingServerToolUseIds.size > 0)
              ) {
                throw new DecisionProviderError(
                  "Anthropic combined a terminal or model-handoff call with another client or server tool call",
                  "INVALID_RESPONSE",
                );
              }
              if (
                (finalRound || schemaCorrectionRound) &&
                (calls.length !== 1 || calls[0]?.name !== "submit_trade_plan")
              ) {
                throw new DecisionProviderError(
                  "Anthropic did not make the required solitary terminal submission",
                  "INVALID_RESPONSE",
                );
              }
            }
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
              providerWebSearchAttemptsToRecord,
              providerWebSearchSuccessesToRecord,
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
                if (
                  schemaCorrectionRound &&
                  call.name !== "submit_trade_plan"
                ) {
                  throw new DecisionProviderError(
                    "Schema correction permits only submit_trade_plan",
                    "INVALID_RESPONSE",
                  );
                }
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
                  if (
                    call.name === "submit_trade_plan" &&
                    isTradePlanSchemaValidationError(result)
                  ) {
                    if (
                      schemaCorrectionAttemptsOffered >=
                      MAXIMUM_TRADE_PLAN_SCHEMA_CORRECTION_ATTEMPTS
                    ) {
                      throw new DecisionProviderError(
                        "Anthropic submitted a trade plan that failed schema validation after one correction attempt",
                        "INVALID_DECISION",
                      );
                    }
                    schemaCorrectionAttemptsOffered += 1;
                    schemaCorrectionFinalRound = finalRound;
                    schemaCorrectionPending = true;
                  }
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
