import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { AnthropicDecisionProvider } from "../dist/src/llm/anthropic-provider.js";
import { OpenAIDecisionProvider } from "../dist/src/llm/openai-provider.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";

// Every provider request is intercepted. This check uses no credentials,
// provider traffic, exchange traffic, or persistent account state.
const prompts = await loadPromptBundle();
const candidateRuntime = {
  Provider: AnthropicDecisionProvider,
  ResearchTools: DecisionResearchTools,
  prompts,
};
const OPUS_55 = "claude-opus-5-5";
const LEGACY = "claude-opus-4-6";
const validPlan = {
  cycleSummary: "Synthetic terminal plan",
  evidenceBundles: [],
  portfolioTargets: [],
  candidateDispositions: [],
};

function toolUse(id, name, input, extra = {}) {
  return { type: "tool_use", id, name, input, ...extra };
}

function response(id, content, stopReason = "tool_use", usage) {
  return {
    id,
    type: "message",
    role: "assistant",
    stop_reason: stopReason,
    content,
    ...(usage === undefined ? {} : { usage }),
  };
}

function assertPreservedPrefix(previous, next) {
  assert.equal(JSON.stringify(next.system), JSON.stringify(previous.system));
  assert.equal(JSON.stringify(next.tools), JSON.stringify(previous.tools));
  assert.equal(
    JSON.stringify(next.messages.slice(0, previous.messages.length)),
    JSON.stringify(previous.messages),
  );
}

function assertAllPreservedPrefixes(scenario) {
  for (let index = 1; index < scenario.requests.length; index += 1) {
    assertPreservedPrefix(
      scenario.requests[index - 1],
      scenario.requests[index],
    );
  }
}

function assertDistinctBaselineProvider(
  candidateProviderPath,
  baselineProviderPath,
) {
  assert.notEqual(
    baselineProviderPath,
    candidateProviderPath,
    "MARKETCASTER_BASELINE_DIST must resolve to a distinct provider build",
  );
}

function openAiFunctionCall(id, name, input) {
  return {
    type: "function_call",
    call_id: id,
    name,
    arguments: JSON.stringify(input),
  };
}

function openAiResponse(id, output, status = "completed") {
  return { id, status, output };
}

function harness({
  runtime = candidateRuntime,
  modelId,
  catalogModelId,
  responses,
  maximumRounds = 1,
  maximumWebSearches = 0,
  timeoutMilliseconds = 5000,
  maximumOutputTokens,
  signal,
  reviewTerminalDecision,
  fetchHook,
  fetchResponse,
  toolOptions = {},
}) {
  const requests = [];
  const rawBodies = [];
  const requestHeaders = [];
  const transcripts = [];
  let reviews = 0;
  const provider = new runtime.Provider({
    apiKey: "synthetic-fixture-key",
    modelId,
    ...(catalogModelId === undefined ? {} : { catalogModelId }),
    fetchImplementation: async (_url, init) => {
      rawBodies.push(init.body);
      requests.push(JSON.parse(init.body));
      requestHeaders.push({ ...init.headers });
      await fetchHook?.(requests.length, init.signal);
      const injectedResponse = await fetchResponse?.(
        requests.length,
        init.signal,
      );
      if (injectedResponse !== undefined) return injectedResponse;
      const fixture = responses[requests.length - 1];
      assert.ok(fixture, "Unexpected extra Anthropic request");
      return new globalThis.Response(JSON.stringify(fixture), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const researchTools = new runtime.ResearchTools({
    prompts: runtime.prompts.research,
    ...toolOptions,
  });
  return {
    requests,
    rawBodies,
    requestHeaders,
    transcripts,
    researchTools,
    get reviews() {
      return reviews;
    },
    decide: () =>
      provider.decide({
        prompt: {
          system: "Synthetic system prompt",
          user: "Synthetic request",
        },
        researchTools,
        limits: {
          maximumRounds,
          maximumWebSearches,
          timeoutMilliseconds,
          ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
        },
        ...(signal === undefined ? {} : { signal }),
        reviewTerminalDecision: async (...args) => {
          reviews += 1;
          return reviewTerminalDecision === undefined
            ? { repair: false }
            : reviewTerminalDecision(reviews, ...args);
        },
        recordTranscriptRound: (round) => transcripts.push(round),
      }),
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Unexpected network call in Anthropic Opus 5.5 checker");
};

try {
  const legacyResearch = harness({
    modelId: LEGACY,
    maximumRounds: 2,
    responses: [
      response("legacy-research", [
        toolUse("legacy-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await legacyResearch.decide();
  assert.deepEqual(legacyResearch.requests[0].tool_choice, { type: "any" });
  assert.equal(
    legacyResearch.requests[0].messages[0].content,
    "Synthetic request",
    "Legacy prompts remain byte-for-byte unchanged",
  );

  const legacyFinal = harness({
    modelId: LEGACY,
    responses: [
      response("legacy-final", [
        toolUse("legacy-final-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await legacyFinal.decide();
  assert.deepEqual(legacyFinal.requests[0].tool_choice, {
    type: "tool",
    name: "submit_trade_plan",
  });

  for (const [modelId, expectedChoice] of [
    ["claude-opus-5-6", "auto"],
    ["claude-opus-6", "auto"],
    ["claude-sonnet-5-5", "auto"],
    ["claude-fable-5-1", "auto"],
    ["claude-mythos-5-1", "auto"],
    ["anthropic.claude-opus-5-5", "auto"],
    ["claude-opus-5-5@20261001", "auto"],
    ["claude-opus-5", "tool"],
    ["claude-opus-5-20260401", "tool"],
    ["claude-opus-4-5-20251101", "tool"],
    ["claude-sonnet-5", "tool"],
    ["claude-fable-5", "tool"],
    ["claude-3-5-sonnet-20241022", "tool"],
    ["synthetic-model", "tool"],
  ]) {
    const versioned = harness({
      modelId,
      responses: [
        response(`versioned-${modelId}`, [
          toolUse(
            `versioned-${modelId}-submit`,
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    await versioned.decide();
    assert.equal(
      versioned.requests[0].tool_choice.type,
      expectedChoice,
      `${modelId} selects the ${expectedChoice} submission contract`,
    );
  }

  const opusFinal = harness({
    modelId: OPUS_55,
    responses: [
      response("opus-final", [
        { type: "thinking", thinking: "", signature: "sig-final" },
        toolUse("opus-final-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await opusFinal.decide();
  assert.deepEqual(opusFinal.requests[0].tool_choice, { type: "auto" });
  assert.match(
    opusFinal.requests[0].messages[0].content,
    /terminal submission/u,
  );
  assert.equal(
    Object.hasOwn(opusFinal.requests[0], "thinking"),
    false,
    "Opus 5.5 requests do not send a rejected thinking configuration",
  );

  const invalidPlan = { cycleSummary: "Missing required fields" };
  const correctionFirstContent = [
    { type: "thinking", thinking: "", signature: "sig-correction" },
    {
      type: "redacted_thinking",
      data: "encrypted-thinking",
      future_field: { preserved: true },
    },
    toolUse("invalid-submit", "submit_trade_plan", invalidPlan, {
      opaque_field: "preserve-me",
    }),
  ];
  const correction = harness({
    modelId: OPUS_55,
    responses: [
      response("correction-1", correctionFirstContent),
      response("correction-2", [
        toolUse("corrected-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await correction.decide();
  assert.equal(correction.requests.length, 2);
  assertAllPreservedPrefixes(correction);
  assert.deepEqual(correction.requests[1].tool_choice, { type: "auto" });
  assert.deepEqual(
    correction.requests[1].messages[0],
    correction.requests[0].messages[0],
    "The original user prefix is not rewritten during correction",
  );
  assert.deepEqual(
    correction.requests[1].messages[1].content,
    correctionFirstContent,
    "Every assistant content block is replayed without reconstruction",
  );
  assert.match(
    correction.requests[1].messages.at(-1).content,
    /schema correction/u,
  );

  for (const [catalogModelId, modelId, firstChoice, secondChoice] of [
    [LEGACY, OPUS_55, "any", "auto"],
    [OPUS_55, LEGACY, "auto", "any"],
  ]) {
    const handoffContent = [
      { type: "thinking", thinking: "", signature: "sig-handoff" },
      { type: "redacted_thinking", data: "redacted-handoff" },
      { type: "text", text: "Synthetic catalog findings" },
      toolUse(
        "handoff-call",
        "continue_with_primary_model",
        {},
        {
          opaque_field: { preserved: true },
        },
      ),
    ];
    const mixed = harness({
      modelId,
      catalogModelId,
      maximumRounds: 3,
      responses: [
        response("mixed-handoff", handoffContent),
        response("mixed-submit", [
          toolUse("mixed-final", "submit_trade_plan", validPlan),
        ]),
      ],
    });
    await mixed.decide();
    assert.equal(mixed.requests[0].model, catalogModelId);
    assert.equal(mixed.requests[1].model, modelId);
    assert.equal(mixed.requests[0].tool_choice.type, firstChoice);
    assert.equal(mixed.requests[1].tool_choice.type, secondChoice);
    assertAllPreservedPrefixes(mixed);
    assert.deepEqual(mixed.requests[1].messages[1].content, handoffContent);
    assert.equal(
      mixed.requests[1].messages[2].content[0].tool_use_id,
      "handoff-call",
      "The handoff result remains paired with the preserved handoff call",
    );
  }

  const equalRouteModels = harness({
    modelId: OPUS_55,
    catalogModelId: OPUS_55,
    maximumRounds: 2,
    responses: [
      response("equal-route", [
        toolUse("equal-route-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await equalRouteModels.decide();
  assert.equal(equalRouteModels.requests.length, 1);
  assert.equal(equalRouteModels.requests[0].model, OPUS_55);
  assert.equal(
    equalRouteModels.requests[0].tools.some(
      (tool) => tool.name === "continue_with_primary_model",
    ),
    false,
  );

  for (const [pressureModelId, pressureCase] of [OPUS_55, LEGACY].flatMap(
    (modelId) =>
      [
        {
          name: "below",
          usage: {
            input_tokens: 99_999,
            cache_creation_input_tokens: 40_000,
            cache_read_input_tokens: 35_000,
            output_tokens: 10,
          },
          expectedMaxTokens: 6_000,
          terminal: false,
        },
        {
          name: "at-threshold",
          usage: {
            input_tokens: 100_000,
            cache_creation_input_tokens: 40_000,
            cache_read_input_tokens: 35_000,
            output_tokens: 10,
          },
          expectedMaxTokens: 6_000,
          terminal: true,
        },
        {
          name: "configured-limit",
          usage: { input_tokens: 175_000, output_tokens: 10 },
          configuredMaxTokens: 2_048,
          expectedMaxTokens: 2_048,
          terminal: true,
        },
      ].map((pressureCase) => [modelId, pressureCase]),
  )) {
    let pressureNoteCalls = 0;
    const contextPressure = harness({
      modelId: pressureModelId,
      maximumRounds: 3,
      maximumOutputTokens: pressureCase.configuredMaxTokens ?? 6_000,
      toolOptions: {
        agentNotesHandler: async () => {
          pressureNoteCalls += 1;
          return { notes: [] };
        },
      },
      responses: [
        response(
          `context-pressure-${pressureCase.name}-research`,
          [
            toolUse(
              `context-pressure-${pressureCase.name}-notes`,
              "manage_notes",
              { action: "LIST" },
            ),
          ],
          "tool_use",
          pressureCase.usage,
        ),
        response(`context-pressure-${pressureCase.name}-next`, [
          pressureCase.terminal
            ? toolUse(
                `context-pressure-${pressureCase.name}-submit`,
                "submit_trade_plan",
                validPlan,
              )
            : toolUse(
                `context-pressure-${pressureCase.name}-notes-2`,
                "manage_notes",
                { action: "LIST" },
              ),
        ]),
        response(`context-pressure-${pressureCase.name}-final`, [
          toolUse(
            `context-pressure-${pressureCase.name}-final-submit`,
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    await contextPressure.decide();
    assert.equal(
      contextPressure.requests[1].max_tokens,
      pressureCase.expectedMaxTokens,
    );
    if (pressureModelId === OPUS_55) {
      assert.equal(
        /terminal submission/u.test(
          contextPressure.requests[1].messages.at(-1).content,
        ),
        pressureCase.terminal,
      );
    } else {
      assert.equal(
        contextPressure.requests[1].tool_choice.type,
        pressureCase.terminal ? "tool" : "any",
      );
    }
    assertAllPreservedPrefixes(contextPressure);
    assert.equal(pressureNoteCalls, pressureCase.terminal ? 1 : 2);
  }

  for (const [catalogModelId, modelId, firstChoice, secondChoice] of [
    [LEGACY, OPUS_55, "any", "auto"],
    [OPUS_55, LEGACY, "auto", "tool"],
  ]) {
    let catalogCalls = 0;
    const automaticPrimaryTakeover = harness({
      modelId,
      catalogModelId,
      maximumRounds: 2,
      toolOptions: {
        listMarketFacets: async () => {
          catalogCalls += 1;
          return { items: [], eof: true };
        },
      },
      responses: [
        response("automatic-catalog", [
          toolUse("automatic-catalog-facets", "list_market_facets", {
            kind: "ALL",
          }),
        ]),
        response("automatic-primary", [
          toolUse("automatic-primary-submit", "submit_trade_plan", validPlan),
        ]),
      ],
    });
    await automaticPrimaryTakeover.decide();
    assert.equal(catalogCalls, 1);
    assert.equal(automaticPrimaryTakeover.requests[0].model, catalogModelId);
    assert.equal(automaticPrimaryTakeover.requests[1].model, modelId);
    assert.equal(
      automaticPrimaryTakeover.requests[0].tool_choice.type,
      firstChoice,
    );
    assert.equal(
      automaticPrimaryTakeover.requests[1].tool_choice.type,
      secondChoice,
    );
    assertAllPreservedPrefixes(automaticPrimaryTakeover);
  }

  const pauseContent = [
    { type: "thinking", thinking: "", signature: "sig-search" },
    {
      type: "server_tool_use",
      id: "server-search",
      name: "web_search",
      input: { query: "synthetic query" },
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "server-search",
      content: [
        {
          type: "web_search_result",
          url: "https://example.com/search-result",
          title: "Synthetic search result",
          encrypted_content: "opaque",
          future_result_field: { preserved: true },
        },
      ],
    },
  ];
  const pausedSearch = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    responses: [
      response("search-pause", pauseContent, "pause_turn", {
        input_tokens: 10,
        output_tokens: 5,
        server_tool_use: { web_search_requests: 1 },
      }),
      response("search-final", [
        toolUse("search-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await pausedSearch.decide();
  assertAllPreservedPrefixes(pausedSearch);
  assert.deepEqual(pausedSearch.requests[1].messages[1].content, pauseContent);
  assert.deepEqual(pausedSearch.requests[1].tool_choice, { type: "auto" });

  const repaired = harness({
    modelId: OPUS_55,
    responses: [
      response("repair-1", [
        toolUse("repair-submit-1", "submit_trade_plan", validPlan),
      ]),
      response("repair-2", [
        toolUse("repair-submit-2", "submit_trade_plan", validPlan),
      ]),
    ],
    reviewTerminalDecision: (reviews) =>
      reviews === 1
        ? {
            repair: true,
            feedback: {
              acceptedProposalIndexes: [],
              rejectedProposals: [],
              instructions: ["Synthetic substantive repair"],
            },
          }
        : { repair: false },
  });
  await repaired.decide();
  assert.equal(repaired.reviews, 2);
  assertAllPreservedPrefixes(repaired);
  assert.match(
    repaired.requests[1].messages.at(-1).content,
    /substantive decision repair/u,
    "Research is explicitly reopened after substantive rejection",
  );

  let repairResearchCalls = 0;
  const repairFinalResponses = [
    response("repair-final-initial", [
      toolUse("repair-final-initial-submit", "submit_trade_plan", validPlan),
    ]),
    ...Array.from({ length: 7 }, (_unused, index) =>
      response(`repair-final-research-${index}`, [
        toolUse(`repair-final-notes-${index}`, "manage_notes", {
          action: "LIST",
        }),
      ]),
    ),
    response("repair-final-terminal", [
      toolUse("repair-final-submit", "submit_trade_plan", validPlan),
    ]),
  ];
  const repairFinal = harness({
    modelId: OPUS_55,
    responses: repairFinalResponses,
    toolOptions: {
      agentNotesHandler: async () => {
        repairResearchCalls += 1;
        return { notes: [] };
      },
    },
    reviewTerminalDecision: (reviews) =>
      reviews === 1
        ? {
            repair: true,
            feedback: {
              acceptedProposalIndexes: [],
              rejectedProposals: [],
              instructions: ["Use every bounded repair round"],
            },
          }
        : { repair: false },
  });
  await repairFinal.decide();
  assert.equal(repairResearchCalls, 7);
  assert.equal(repairFinal.reviews, 2);
  assert.equal(repairFinal.requests.length, 9);
  assert.deepEqual(repairFinal.requests.at(-1).tool_choice, { type: "auto" });
  assert.match(
    repairFinal.requests.at(-1).messages.at(-1).content,
    /final substantive-repair submission/u,
  );
  assertAllPreservedPrefixes(repairFinal);

  const repairAttemptExhaustion = harness({
    modelId: OPUS_55,
    responses: Array.from({ length: 4 }, (_unused, index) =>
      response(`repair-attempt-${index}`, [
        toolUse(
          `repair-attempt-submit-${index}`,
          "submit_trade_plan",
          validPlan,
        ),
      ]),
    ),
    reviewTerminalDecision: () => ({
      repair: true,
      feedback: {
        acceptedProposalIndexes: [],
        rejectedProposals: [],
        instructions: ["Synthetic bounded repair rejection"],
      },
    }),
  });
  await repairAttemptExhaustion.decide();
  assert.equal(
    repairAttemptExhaustion.reviews,
    4,
    "Three repair offers are followed by one final reviewed submission",
  );
  assert.equal(repairAttemptExhaustion.requests.length, 4);
  assertAllPreservedPrefixes(repairAttemptExhaustion);

  async function rejectsBeforeReview(
    content,
    stopReason = "tool_use",
    options,
  ) {
    const guarded = harness({
      modelId: OPUS_55,
      responses: [response("guarded", content, stopReason, options?.usage)],
      maximumWebSearches: options?.maximumWebSearches ?? 0,
    });
    await assert.rejects(
      guarded.decide(),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(guarded.reviews, 0);
  }

  await rejectsBeforeReview([
    { type: "tool_use", name: "submit_trade_plan", input: validPlan },
    toolUse("valid-sibling", "submit_trade_plan", validPlan),
  ]);
  await rejectsBeforeReview([
    toolUse("duplicate", "submit_trade_plan", validPlan),
    toolUse("duplicate", "submit_trade_plan", validPlan),
  ]);
  await rejectsBeforeReview(
    [
      {
        type: "server_tool_use",
        id: "forbidden-search",
        name: "web_search",
        input: { query: "synthetic" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "forbidden-search",
        content: [],
      },
      toolUse("mixed-terminal", "submit_trade_plan", validPlan),
    ],
    "tool_use",
    {
      maximumWebSearches: 1,
      usage: { server_tool_use: { web_search_requests: 1 } },
    },
  );
  await rejectsBeforeReview([], "end_turn");
  await rejectsBeforeReview(
    [toolUse("refused-submit", "submit_trade_plan", validPlan)],
    "refusal",
  );
  await rejectsBeforeReview(
    [toolUse("truncated-submit", "submit_trade_plan", validPlan)],
    "max_tokens",
  );
  await rejectsBeforeReview(
    [toolUse("context-truncated-submit", "submit_trade_plan", validPlan)],
    "model_context_window_exceeded",
  );
  await rejectsBeforeReview(
    [toolUse("paused-client-submit", "submit_trade_plan", validPlan)],
    "pause_turn",
  );
  await rejectsBeforeReview(
    [toolUse("ended-client-submit", "submit_trade_plan", validPlan)],
    "end_turn",
  );
  await rejectsBeforeReview(
    [toolUse("null-stop-submit", "submit_trade_plan", validPlan)],
    null,
  );
  await rejectsBeforeReview(
    [toolUse("unknown-stop-submit", "submit_trade_plan", validPlan)],
    "future_stop_state",
  );

  let authorizedSiblingCalls = 0;
  const forbiddenSibling = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    toolOptions: {
      agentNotesHandler: async () => {
        authorizedSiblingCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("forbidden-sibling", [
        toolUse("authorized-first", "manage_notes", { action: "LIST" }),
        toolUse("forbidden-second", "continue_with_primary_model", {}),
      ]),
    ],
  });
  await assert.rejects(
    forbiddenSibling.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(authorizedSiblingCalls, 0);
  assert.equal(forbiddenSibling.reviews, 0);

  const unmatchedServerResult = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    responses: [
      response(
        "unmatched-server-result",
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "missing-server-call",
            content: [],
          },
        ],
        "pause_turn",
      ),
    ],
  });
  await assert.rejects(
    unmatchedServerResult.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );

  const unresolvedServerTurn = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    responses: [
      response(
        "unresolved-server-turn",
        [
          {
            type: "server_tool_use",
            id: "pending-server-search",
            name: "web_search",
            input: { query: "synthetic" },
          },
        ],
        "pause_turn",
        { server_tool_use: { web_search_requests: 1 } },
      ),
    ],
  });
  await assert.rejects(
    unresolvedServerTurn.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(
    unresolvedServerTurn.requests.length,
    1,
    "An unresolved server turn is not dispatched into a terminal-only round",
  );

  let deferredNoteCalls = 0;
  const deferredCompletion = harness({
    modelId: OPUS_55,
    maximumRounds: 3,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        deferredNoteCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response(
        "deferred-start",
        [
          {
            type: "server_tool_use",
            id: "deferred-search",
            name: "web_search",
            input: { query: "synthetic deferred query" },
          },
          toolUse("deferred-notes", "manage_notes", { action: "LIST" }),
        ],
        "tool_use",
        { server_tool_use: { web_search_requests: 1 } },
      ),
      response(
        "deferred-complete",
        [
          {
            type: "web_search_tool_result",
            tool_use_id: "deferred-search",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/deferred-result",
                title: "Synthetic deferred result",
                encrypted_content: "opaque",
              },
            ],
          },
          toolUse("deferred-submit", "submit_trade_plan", validPlan),
        ],
        "tool_use",
        { server_tool_use: { web_search_requests: 0 } },
      ),
    ],
  });
  await deferredCompletion.decide();
  assert.equal(deferredNoteCalls, 1);
  assert.equal(deferredCompletion.reviews, 1);
  assert.equal(deferredCompletion.researchTools.totalCounts.webSearches, 1);
  assertAllPreservedPrefixes(deferredCompletion);
  assert.deepEqual(
    deferredCompletion.requests[1].messages.at(-1).content.map((block) => ({
      type: block.type,
      tool_use_id: block.tool_use_id,
    })),
    [{ type: "tool_result", tool_use_id: "deferred-notes" }],
    "Mixed server/client continuation appends only required client results",
  );

  for (const deferredUsage of [
    { name: "missing", start: undefined, complete: undefined },
    {
      name: "positive",
      start: { server_tool_use: { web_search_requests: 1 } },
      complete: { server_tool_use: { web_search_requests: 1 } },
    },
  ]) {
    let handlerCalls = 0;
    const deferred = harness({
      modelId: OPUS_55,
      maximumRounds: 3,
      maximumWebSearches: 1,
      toolOptions: {
        agentNotesHandler: async () => {
          handlerCalls += 1;
          return { notes: [] };
        },
      },
      responses: [
        response(
          `deferred-${deferredUsage.name}-start`,
          [
            {
              type: "server_tool_use",
              id: `deferred-${deferredUsage.name}-search`,
              name: "web_search",
              input: { query: `synthetic deferred ${deferredUsage.name}` },
            },
            toolUse(`deferred-${deferredUsage.name}-notes`, "manage_notes", {
              action: "LIST",
            }),
          ],
          "tool_use",
          deferredUsage.start,
        ),
        response(
          `deferred-${deferredUsage.name}-complete`,
          [
            {
              type: "web_search_tool_result",
              tool_use_id: `deferred-${deferredUsage.name}-search`,
              content: [
                {
                  type: "web_search_result",
                  url: `https://example.com/deferred-${deferredUsage.name}`,
                  title: `Synthetic deferred ${deferredUsage.name}`,
                  encrypted_content: "opaque",
                },
              ],
            },
            toolUse(
              `deferred-${deferredUsage.name}-submit`,
              "submit_trade_plan",
              validPlan,
            ),
          ],
          "tool_use",
          deferredUsage.complete,
        ),
      ],
    });
    await deferred.decide();
    assert.equal(handlerCalls, 1);
    assert.equal(deferred.reviews, 1);
    assert.equal(deferred.researchTools.totalCounts.webSearches, 1);
    assert.equal(
      deferred.researchTools.strictPassResearchReadiness.webSearches,
      1,
    );
    assertAllPreservedPrefixes(deferred);
  }

  let pendingNoteCalls = 0;
  const pendingTerminal = harness({
    modelId: OPUS_55,
    maximumRounds: 3,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        pendingNoteCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("pending-start", [
        {
          type: "server_tool_use",
          id: "still-pending-search",
          name: "web_search",
          input: { query: "synthetic pending query" },
        },
        toolUse("pending-notes", "manage_notes", { action: "LIST" }),
      ]),
      response("pending-submit", [
        toolUse("pending-submit-call", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await assert.rejects(
    pendingTerminal.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(pendingNoteCalls, 1);
  assert.equal(pendingTerminal.reviews, 0);
  assert.equal(pendingTerminal.requests.length, 2);
  assertAllPreservedPrefixes(pendingTerminal);

  let zeroUsageNoteCalls = 0;
  const zeroUsageSearch = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        zeroUsageNoteCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response(
        "zero-usage-search",
        [
          {
            type: "server_tool_use",
            id: "zero-usage-server-call",
            name: "web_search",
            input: { query: "synthetic zero usage" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "zero-usage-server-call",
            content: [],
          },
          toolUse("zero-usage-notes", "manage_notes", { action: "LIST" }),
        ],
        "tool_use",
        { server_tool_use: { web_search_requests: 0 } },
      ),
      response("zero-usage-submit", [
        toolUse("zero-usage-submit-call", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await zeroUsageSearch.decide();
  assert.equal(zeroUsageNoteCalls, 1);
  assert.equal(zeroUsageSearch.researchTools.totalCounts.webSearches, 1);
  assert.equal(
    zeroUsageSearch.researchTools.strictPassResearchReadiness.webSearches,
    1,
  );
  assertAllPreservedPrefixes(zeroUsageSearch);

  let malformedResultHandlerCalls = 0;
  const malformedResult = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        malformedResultHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("malformed-result", [
        {
          type: "server_tool_use",
          id: "malformed-result-call",
          name: "web_search",
          input: { query: "synthetic malformed result" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "malformed-result-call",
        },
        toolUse("malformed-result-notes", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    malformedResult.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(malformedResultHandlerCalls, 0);

  const malformedSearchContents = [
    [null],
    [42],
    [{}],
    [{ type: "not_a_web_search_result" }],
    [{ type: "web_search_result", title: "Missing URL and ciphertext" }],
    [
      {
        type: "web_search_result",
        url: 42,
        title: "Wrong URL type",
        encrypted_content: "opaque",
      },
    ],
    [
      {
        type: "web_search_result",
        url: "https://example.com/wrong-title",
        title: null,
        encrypted_content: "opaque",
      },
    ],
    [
      {
        type: "web_search_result",
        url: "https://example.com/wrong-page-age",
        title: "Wrong page age",
        encrypted_content: "opaque",
        page_age: 7,
      },
    ],
    [
      {
        type: "web_search_result",
        url: "https://example.com/valid",
        title: "Valid sibling",
        encrypted_content: "opaque",
      },
      {},
    ],
    { type: "web_search_tool_result_error" },
    { type: "web_search_tool_result_error", error_code: "" },
    { type: "web_search_tool_result_error", error_code: 42 },
    { type: "other_error", error_code: "synthetic" },
  ];
  for (const [index, content] of malformedSearchContents.entries()) {
    let handlerCalls = 0;
    const malformedMember = harness({
      modelId: OPUS_55,
      maximumRounds: 2,
      maximumWebSearches: 1,
      toolOptions: {
        agentNotesHandler: async () => {
          handlerCalls += 1;
          return { notes: [] };
        },
      },
      responses: [
        response(`malformed-member-${index}`, [
          {
            type: "server_tool_use",
            id: `malformed-member-call-${index}`,
            name: "web_search",
            input: { query: "synthetic malformed member" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: `malformed-member-call-${index}`,
            content,
          },
          toolUse(`malformed-member-notes-${index}`, "manage_notes", {
            action: "LIST",
          }),
        ]),
      ],
    });
    await assert.rejects(
      malformedMember.decide(),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(handlerCalls, 0);
    assert.equal(malformedMember.reviews, 0);
    assert.equal(malformedMember.researchTools.totalCounts.webSearches, 0);

    let deferredHandlerCalls = 0;
    const malformedDeferred = harness({
      modelId: OPUS_55,
      maximumRounds: 3,
      maximumWebSearches: 1,
      toolOptions: {
        agentNotesHandler: async () => {
          deferredHandlerCalls += 1;
          return { notes: [] };
        },
      },
      responses: [
        response(`malformed-deferred-start-${index}`, [
          {
            type: "server_tool_use",
            id: `malformed-deferred-call-${index}`,
            name: "web_search",
            input: { query: "synthetic malformed deferred result" },
          },
          toolUse(`malformed-deferred-notes-${index}`, "manage_notes", {
            action: "LIST",
          }),
        ]),
        response(`malformed-deferred-complete-${index}`, [
          {
            type: "web_search_tool_result",
            tool_use_id: `malformed-deferred-call-${index}`,
            content,
          },
          toolUse(
            `malformed-deferred-submit-${index}`,
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    await assert.rejects(
      malformedDeferred.decide(),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(deferredHandlerCalls, 1);
    assert.equal(malformedDeferred.reviews, 0);
    assert.equal(
      malformedDeferred.researchTools.strictPassResearchReadiness.webSearches,
      0,
    );
  }

  const validSearchError = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    responses: [
      response(
        "valid-search-error",
        [
          {
            type: "server_tool_use",
            id: "valid-search-error-call",
            name: "web_search",
            input: { query: "synthetic valid error" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "valid-search-error-call",
            content: {
              type: "web_search_tool_result_error",
              error_code: "synthetic_error",
              opaque: "preserved",
            },
          },
        ],
        "pause_turn",
      ),
      response("valid-search-error-submit", [
        toolUse(
          "valid-search-error-submit-call",
          "submit_trade_plan",
          validPlan,
        ),
      ]),
    ],
  });
  await validSearchError.decide();
  assert.equal(validSearchError.researchTools.totalCounts.webSearches, 1);
  assert.equal(
    validSearchError.researchTools.strictPassResearchReadiness.webSearches,
    0,
  );

  let overBudgetHandlerCalls = 0;
  const overBudget = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        overBudgetHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response(
        "over-budget",
        [
          {
            type: "server_tool_use",
            id: "over-budget-1",
            name: "web_search",
            input: { query: "synthetic one" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "over-budget-1",
            content: [],
          },
          {
            type: "server_tool_use",
            id: "over-budget-2",
            name: "web_search",
            input: { query: "synthetic two" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "over-budget-2",
            content: [],
          },
          toolUse("over-budget-notes", "manage_notes", { action: "LIST" }),
        ],
        "tool_use",
        { server_tool_use: { web_search_requests: 0 } },
      ),
    ],
  });
  await assert.rejects(
    overBudget.decide(),
    (error) => error.code === "TOOL_LIMIT",
  );
  assert.equal(overBudgetHandlerCalls, 0);

  let accumulatedHandlerCalls = 0;
  const accumulatedSearchLimit = harness({
    modelId: OPUS_55,
    maximumRounds: 3,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        accumulatedHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("accumulated-search-first", [
        {
          type: "server_tool_use",
          id: "accumulated-search-call-1",
          name: "web_search",
          input: { query: "synthetic accumulated one" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "accumulated-search-call-1",
          content: [],
        },
        toolUse("accumulated-notes-1", "manage_notes", { action: "LIST" }),
      ]),
      response("accumulated-search-second", [
        {
          type: "server_tool_use",
          id: "accumulated-search-call-2",
          name: "web_search",
          input: { query: "synthetic accumulated two" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "accumulated-search-call-2",
          content: [],
        },
        toolUse("accumulated-notes-2", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    accumulatedSearchLimit.decide(),
    (error) => error.code === "TOOL_LIMIT",
  );
  assert.equal(accumulatedHandlerCalls, 1);
  assert.equal(accumulatedSearchLimit.requests.length, 2);
  assertAllPreservedPrefixes(accumulatedSearchLimit);

  let repairSearchHandlerCalls = 0;
  const repairSearchLimit = harness({
    modelId: OPUS_55,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        repairSearchHandlerCalls += 1;
        return { notes: [] };
      },
    },
    reviewTerminalDecision: () => ({
      repair: true,
      feedback: {
        acceptedProposalIndexes: [],
        rejectedProposals: [],
        instructions: ["Synthetic search-budget repair"],
      },
    }),
    responses: [
      response("repair-search-initial", [
        toolUse("repair-search-initial-submit", "submit_trade_plan", validPlan),
      ]),
      response("repair-search-first", [
        {
          type: "server_tool_use",
          id: "repair-search-call-1",
          name: "web_search",
          input: { query: "synthetic repair search one" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "repair-search-call-1",
          content: [],
        },
        toolUse("repair-search-notes-1", "manage_notes", { action: "LIST" }),
      ]),
      response("repair-search-second", [
        {
          type: "server_tool_use",
          id: "repair-search-call-2",
          name: "web_search",
          input: { query: "synthetic repair search two" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "repair-search-call-2",
          content: [],
        },
        toolUse("repair-search-notes-2", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    repairSearchLimit.decide(),
    (error) => error.code === "TOOL_LIMIT",
  );
  assert.equal(repairSearchHandlerCalls, 1);
  assert.equal(repairSearchLimit.requests.length, 3);
  assertAllPreservedPrefixes(repairSearchLimit);

  let duplicateResultHandlerCalls = 0;
  const duplicateResult = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        duplicateResultHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("duplicate-result", [
        {
          type: "server_tool_use",
          id: "duplicate-result-call",
          name: "web_search",
          input: { query: "synthetic duplicate result" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "duplicate-result-call",
          content: [],
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "duplicate-result-call",
          content: [],
        },
        toolUse("duplicate-result-notes", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    duplicateResult.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(duplicateResultHandlerCalls, 0);

  let reusedResultHandlerCalls = 0;
  const reusedResult = harness({
    modelId: OPUS_55,
    maximumRounds: 3,
    maximumWebSearches: 1,
    toolOptions: {
      agentNotesHandler: async () => {
        reusedResultHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("reused-result-first", [
        {
          type: "server_tool_use",
          id: "reused-result-call",
          name: "web_search",
          input: { query: "synthetic reused result" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "reused-result-call",
          content: [],
        },
        toolUse("reused-result-notes-1", "manage_notes", { action: "LIST" }),
      ]),
      response("reused-result-second", [
        {
          type: "web_search_tool_result",
          tool_use_id: "reused-result-call",
          content: [],
        },
        toolUse("reused-result-notes-2", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    reusedResult.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(reusedResultHandlerCalls, 1);
  assert.equal(reusedResult.reviews, 0);
  assertAllPreservedPrefixes(reusedResult);

  let reusedCallHandlerCalls = 0;
  const reusedCall = harness({
    modelId: OPUS_55,
    maximumRounds: 3,
    toolOptions: {
      agentNotesHandler: async () => {
        reusedCallHandlerCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("reused-call-1", [
        toolUse("reused-client-id", "manage_notes", { action: "LIST" }),
      ]),
      response("reused-call-2", [
        toolUse("reused-client-id", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    reusedCall.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(
    reusedCallHandlerCalls,
    1,
    "A reused call ID is rejected before the second handler dispatch",
  );

  let clientSearchCalls = 0;
  const clientSearch = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    maximumWebSearches: 1,
    toolOptions: {
      webSearch: async () => {
        clientSearchCalls += 1;
        return [
          {
            title: "Synthetic result",
            url: "https://example.com/synthetic",
            snippet: "Synthetic evidence",
          },
        ];
      },
    },
    responses: [
      response("client-search", [
        toolUse("client-search-call", "web_search", {
          query: "synthetic client search",
        }),
      ]),
      response("client-search-submit", [
        toolUse("client-search-submit-call", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await clientSearch.decide();
  assert.equal(clientSearchCalls, 1);
  assert.equal(clientSearch.researchTools.totalCounts.webSearches, 1);
  assert.equal(
    clientSearch.requests[0].tools.some(
      (tool) => tool.type === "web_search_20250305",
    ),
    false,
  );
  assertAllPreservedPrefixes(clientSearch);

  const roundLimited = harness({
    modelId: OPUS_55,
    toolOptions: {
      requiredPriorityEvidenceMarketSlugs: ["synthetic-uninspected"],
    },
    responses: [
      response("round-limit", [
        toolUse("round-limit-submit", "submit_trade_plan", validPlan),
      ]),
    ],
  });
  await assert.rejects(
    roundLimited.decide(),
    (error) => error.code === "ROUND_LIMIT",
  );
  assert.equal(roundLimited.requests.length, 1);
  assert.equal(roundLimited.reviews, 0);

  const timedOut = harness({
    modelId: OPUS_55,
    responses: [
      response("timeout-invalid", [
        toolUse("timeout-invalid-submit", "submit_trade_plan", invalidPlan),
      ]),
      response("timeout-valid", [
        toolUse("timeout-valid-submit", "submit_trade_plan", validPlan),
      ]),
    ],
    timeoutMilliseconds: 50,
    fetchHook: async (requestCount, signal) => {
      if (requestCount !== 2) return;
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  });
  await assert.rejects(timedOut.decide(), (error) => error.code === "TIMEOUT");
  assert.equal(timedOut.requests.length, 2);

  const repeatedInvalidSchema = harness({
    modelId: OPUS_55,
    responses: [
      response("repeated-invalid-schema-1", [
        toolUse(
          "repeated-invalid-schema-submit-1",
          "submit_trade_plan",
          invalidPlan,
        ),
      ]),
      response("repeated-invalid-schema-2", [
        toolUse(
          "repeated-invalid-schema-submit-2",
          "submit_trade_plan",
          invalidPlan,
        ),
      ]),
    ],
  });
  await assert.rejects(
    repeatedInvalidSchema.decide(),
    (error) => error.code === "INVALID_DECISION",
  );
  assert.equal(repeatedInvalidSchema.requests.length, 2);
  assert.equal(repeatedInvalidSchema.reviews, 0);
  assertAllPreservedPrefixes(repeatedInvalidSchema);

  const externalAbortController = new globalThis.AbortController();
  externalAbortController.abort(new Error("Synthetic external abort"));
  const externallyAborted = harness({
    modelId: OPUS_55,
    responses: [],
    signal: externalAbortController.signal,
  });
  await assert.rejects(
    externallyAborted.decide(),
    (error) => error.code === "ABORTED",
  );
  assert.equal(externallyAborted.requests.length, 1);

  const httpFailure = harness({
    modelId: OPUS_55,
    responses: [],
    fetchResponse: async () =>
      new globalThis.Response("synthetic bad request", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
  });
  await assert.rejects(httpFailure.decide(), (error) => error.code === "HTTP");
  assert.equal(httpFailure.requests.length, 1);

  const malformedJson = harness({
    modelId: OPUS_55,
    responses: [],
    fetchResponse: async () =>
      new globalThis.Response("{not-json", {
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    malformedJson.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(malformedJson.requests.length, 1);

  const malformedShape = harness({
    modelId: OPUS_55,
    responses: [],
    fetchResponse: async () =>
      new globalThis.Response(JSON.stringify({ id: "missing-shape" }), {
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    malformedShape.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(malformedShape.requests.length, 1);

  let catalogViolationCalls = 0;
  const catalogViolation = harness({
    modelId: OPUS_55,
    catalogModelId: LEGACY,
    maximumRounds: 2,
    toolOptions: {
      agentNotesHandler: async () => {
        catalogViolationCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("catalog-violation", [
        toolUse("forbidden-note", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    catalogViolation.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(catalogViolation.reviews, 0);
  assert.equal(catalogViolationCalls, 0);

  const catalogServerSearch = harness({
    modelId: OPUS_55,
    catalogModelId: LEGACY,
    maximumRounds: 2,
    maximumWebSearches: 1,
    responses: [
      response("catalog-server-search", [
        {
          type: "server_tool_use",
          id: "catalog-server-search-call",
          name: "web_search",
          input: { query: "forbidden catalog search" },
        },
      ]),
    ],
  });
  await assert.rejects(
    catalogServerSearch.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(catalogServerSearch.reviews, 0);

  const primaryHandoff = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    responses: [
      response("primary-handoff", [
        toolUse("primary-handoff-call", "continue_with_primary_model", {}),
      ]),
    ],
  });
  await assert.rejects(
    primaryHandoff.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(primaryHandoff.reviews, 0);

  let finalResearchCalls = 0;
  const finalResearch = harness({
    modelId: OPUS_55,
    toolOptions: {
      agentNotesHandler: async () => {
        finalResearchCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("final-research", [
        toolUse("final-research-call", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    finalResearch.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(finalResearchCalls, 0);
  assert.equal(finalResearch.reviews, 0);

  let correctionResearchCalls = 0;
  const correctionResearch = harness({
    modelId: OPUS_55,
    toolOptions: {
      agentNotesHandler: async () => {
        correctionResearchCalls += 1;
        return { notes: [] };
      },
    },
    responses: [
      response("correction-research-invalid", [
        toolUse(
          "correction-research-invalid-submit",
          "submit_trade_plan",
          invalidPlan,
        ),
      ]),
      response("correction-research-call", [
        toolUse("correction-forbidden-notes", "manage_notes", {
          action: "LIST",
        }),
      ]),
    ],
  });
  await assert.rejects(
    correctionResearch.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(correctionResearchCalls, 0);
  assert.equal(correctionResearch.reviews, 0);
  assertAllPreservedPrefixes(correctionResearch);

  const terminalMixedClient = harness({
    modelId: OPUS_55,
    maximumRounds: 2,
    responses: [
      response("terminal-mixed-client", [
        toolUse("terminal-mixed-submit", "submit_trade_plan", validPlan),
        toolUse("terminal-mixed-notes", "manage_notes", { action: "LIST" }),
      ]),
    ],
  });
  await assert.rejects(
    terminalMixedClient.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(terminalMixedClient.reviews, 0);

  let mixedHandoffCatalogCalls = 0;
  const handoffMixedClient = harness({
    modelId: OPUS_55,
    catalogModelId: LEGACY,
    maximumRounds: 2,
    toolOptions: {
      listMarketFacets: async () => {
        mixedHandoffCatalogCalls += 1;
        return { items: [], eof: true };
      },
    },
    responses: [
      response("handoff-mixed-client", [
        toolUse("handoff-mixed-call", "continue_with_primary_model", {}),
        toolUse("handoff-mixed-facets", "list_market_facets", {
          kind: "ALL",
        }),
      ]),
    ],
  });
  await assert.rejects(
    handoffMixedClient.decide(),
    (error) => error.code === "INVALID_RESPONSE",
  );
  assert.equal(mixedHandoffCatalogCalls, 0);
  assert.equal(handoffMixedClient.reviews, 0);

  async function legacySuite(runtime) {
    const scenarios = [];

    const normal = harness({
      runtime,
      modelId: LEGACY,
      maximumRounds: 2,
      responses: [
        response("baseline-normal", [
          toolUse("baseline-normal-submit", "submit_trade_plan", validPlan),
        ]),
      ],
    });
    normal.outcome = await normal.decide();
    scenarios.push(normal);

    const final = harness({
      runtime,
      modelId: LEGACY,
      responses: [
        response("baseline-final", [
          toolUse("baseline-final-submit", "submit_trade_plan", validPlan),
        ]),
      ],
    });
    final.outcome = await final.decide();
    scenarios.push(final);

    const catalog = harness({
      runtime,
      modelId: LEGACY,
      catalogModelId: "claude-haiku-4-5",
      maximumRounds: 3,
      responses: [
        response("baseline-handoff", [
          toolUse("baseline-handoff-call", "continue_with_primary_model", {}),
        ]),
        response("baseline-catalog-submit", [
          toolUse(
            "baseline-catalog-submit-call",
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    catalog.outcome = await catalog.decide();
    scenarios.push(catalog);

    const correction = harness({
      runtime,
      modelId: LEGACY,
      responses: [
        response("baseline-correction-invalid", [
          toolUse(
            "baseline-correction-invalid-call",
            "submit_trade_plan",
            invalidPlan,
          ),
        ]),
        response("baseline-correction-valid", [
          toolUse(
            "baseline-correction-valid-call",
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    correction.outcome = await correction.decide();
    scenarios.push(correction);

    const repair = harness({
      runtime,
      modelId: LEGACY,
      responses: [
        response("baseline-repair-first", [
          toolUse("baseline-repair-first-call", "submit_trade_plan", validPlan),
        ]),
        response("baseline-repair-second", [
          toolUse(
            "baseline-repair-second-call",
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
      reviewTerminalDecision: (reviews) =>
        reviews === 1
          ? {
              repair: true,
              feedback: {
                acceptedProposalIndexes: [],
                rejectedProposals: [],
                instructions: ["Synthetic baseline repair"],
              },
            }
          : { repair: false },
    });
    repair.outcome = await repair.decide();
    scenarios.push(repair);

    const nativeSearch = harness({
      runtime,
      modelId: LEGACY,
      maximumRounds: 2,
      maximumWebSearches: 1,
      responses: [
        response(
          "baseline-search",
          [
            {
              type: "server_tool_use",
              id: "baseline-search-call",
              name: "web_search",
              input: { query: "synthetic baseline query" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "baseline-search-call",
              content: [],
            },
          ],
          "pause_turn",
          { server_tool_use: { web_search_requests: 1 } },
        ),
        response("baseline-search-submit", [
          toolUse(
            "baseline-search-submit-call",
            "submit_trade_plan",
            validPlan,
          ),
        ]),
      ],
    });
    nativeSearch.outcome = await nativeSearch.decide();
    scenarios.push(nativeSearch);

    let multiRequestCalls = 0;
    const multiRequest = harness({
      runtime,
      modelId: LEGACY,
      maximumRounds: 2,
      toolOptions: {
        agentNotesHandler: async () => {
          multiRequestCalls += 1;
          return { notes: [] };
        },
      },
      responses: [
        response("baseline-multi-research", [
          toolUse("baseline-multi-notes", "manage_notes", { action: "LIST" }),
        ]),
        response("baseline-multi-submit", [
          toolUse("baseline-multi-submit-call", "submit_trade_plan", validPlan),
        ]),
      ],
    });
    multiRequest.outcome = await multiRequest.decide();
    assert.equal(multiRequestCalls, 1);
    scenarios.push(multiRequest);

    const failure = harness({
      runtime,
      modelId: LEGACY,
      responses: [response("baseline-failure", [], "end_turn")],
    });
    try {
      await failure.decide();
      assert.fail("Legacy failure fixture unexpectedly succeeded");
    } catch (error) {
      failure.outcome = { errorCode: error.code };
    }
    scenarios.push(failure);

    return scenarios.map((scenario) => ({
      rawBodies: scenario.rawBodies,
      requestHeaders: scenario.requestHeaders,
      transcripts: scenario.transcripts,
      counts: scenario.researchTools.totalCounts,
      reviews: scenario.reviews,
      outcome: scenario.outcome,
    }));
  }

  async function openAiParitySuite(runtime) {
    async function runScenario({
      responses,
      maximumRounds = 1,
      maximumWebSearches = 0,
      catalogModelId,
      reviewTerminalDecision,
      toolOptions = {},
    }) {
      const rawBodies = [];
      const requestHeaders = [];
      const transcripts = [];
      let reviews = 0;
      const provider = new runtime.Provider({
        apiKey: "synthetic-fixture-key",
        modelId: "gpt-5.4",
        ...(catalogModelId === undefined ? {} : { catalogModelId }),
        fetchImplementation: async (_url, init) => {
          rawBodies.push(init.body);
          requestHeaders.push({ ...init.headers });
          const fixture = responses[rawBodies.length - 1];
          assert.ok(fixture, "Unexpected extra OpenAI request");
          return new globalThis.Response(JSON.stringify(fixture), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const researchTools = new runtime.ResearchTools({
        prompts: runtime.prompts.research,
        ...toolOptions,
      });
      let outcome;
      try {
        outcome = await provider.decide({
          prompt: {
            system: "Synthetic system prompt",
            user: "Synthetic request",
          },
          researchTools,
          limits: {
            maximumRounds,
            maximumWebSearches,
            timeoutMilliseconds: 5_000,
          },
          reviewTerminalDecision: async (...args) => {
            reviews += 1;
            return reviewTerminalDecision === undefined
              ? { repair: false }
              : reviewTerminalDecision(reviews, ...args);
          },
          recordTranscriptRound: (round) => transcripts.push(round),
        });
      } catch (error) {
        outcome = { errorCode: error.code };
      }
      return {
        rawBodies,
        requestHeaders,
        transcripts,
        counts: researchTools.totalCounts,
        reviews,
        outcome,
      };
    }

    return Promise.all([
      runScenario({
        maximumRounds: 2,
        toolOptions: { agentNotesHandler: async () => ({ notes: [] }) },
        responses: [
          openAiResponse("openai-research", [
            openAiFunctionCall("openai-notes", "manage_notes", {
              action: "LIST",
            }),
          ]),
          openAiResponse("openai-final", [
            openAiFunctionCall(
              "openai-final-submit",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
        ],
      }),
      runScenario({
        maximumRounds: 3,
        catalogModelId: "gpt-5.4-mini",
        responses: [
          openAiResponse("openai-handoff", [
            openAiFunctionCall(
              "openai-handoff-call",
              "continue_with_primary_model",
              {},
            ),
          ]),
          openAiResponse("openai-handoff-submit", [
            openAiFunctionCall(
              "openai-handoff-submit-call",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
        ],
      }),
      runScenario({
        responses: [
          openAiResponse("openai-correction-invalid", [
            openAiFunctionCall(
              "openai-correction-invalid-call",
              "submit_trade_plan",
              invalidPlan,
            ),
          ]),
          openAiResponse("openai-correction-valid", [
            openAiFunctionCall(
              "openai-correction-valid-call",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
        ],
      }),
      runScenario({
        responses: [
          openAiResponse("openai-repair-first", [
            openAiFunctionCall(
              "openai-repair-first-call",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
          openAiResponse("openai-repair-second", [
            openAiFunctionCall(
              "openai-repair-second-call",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
        ],
        reviewTerminalDecision: (reviews) =>
          reviews === 1
            ? {
                repair: true,
                feedback: {
                  acceptedProposalIndexes: [],
                  rejectedProposals: [],
                  instructions: ["Synthetic OpenAI repair"],
                },
              }
            : { repair: false },
      }),
      runScenario({
        maximumRounds: 2,
        maximumWebSearches: 1,
        responses: [
          openAiResponse("openai-native-search", [
            { type: "web_search_call", status: "completed" },
          ]),
          openAiResponse("openai-native-submit", [
            openAiFunctionCall(
              "openai-native-submit-call",
              "submit_trade_plan",
              validPlan,
            ),
          ]),
        ],
      }),
      runScenario({
        responses: [openAiResponse("openai-failure", [])],
      }),
    ]);
  }

  const baselineDist = globalThis.process.env.MARKETCASTER_BASELINE_DIST;
  assert.ok(
    baselineDist,
    "MARKETCASTER_BASELINE_DIST must name a built, untouched baseline dist directory",
  );
  const candidateProviderPath = await realpath(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/src/llm/anthropic-provider.js",
    ),
  );
  const baselineProviderPath = await realpath(
    path.join(baselineDist, "src/llm/anthropic-provider.js"),
  );
  assert.throws(() =>
    assertDistinctBaselineProvider(
      candidateProviderPath,
      candidateProviderPath,
    ),
  );
  assertDistinctBaselineProvider(candidateProviderPath, baselineProviderPath);
  globalThis.console.log(`Candidate provider: ${candidateProviderPath}`);
  globalThis.console.log(`Baseline provider: ${baselineProviderPath}`);
  const baselineProviderModule = await import(
    pathToFileURL(baselineProviderPath).href
  );
  const baselineResearchToolsModule = await import(
    pathToFileURL(path.join(baselineDist, "src/llm/research-tools.js")).href
  );
  const baselineOpenAIProviderModule = await import(
    pathToFileURL(path.join(baselineDist, "src/llm/openai-provider.js")).href
  );
  const baselineRuntime = {
    Provider: baselineProviderModule.AnthropicDecisionProvider,
    ResearchTools: baselineResearchToolsModule.DecisionResearchTools,
    prompts,
  };
  assert.deepEqual(
    await legacySuite(candidateRuntime),
    await legacySuite(baselineRuntime),
    "Wholly legacy Anthropic behavior must match the untouched pinned baseline",
  );
  assert.deepEqual(
    await openAiParitySuite({
      Provider: OpenAIDecisionProvider,
      ResearchTools: DecisionResearchTools,
      prompts,
    }),
    await openAiParitySuite({
      Provider: baselineOpenAIProviderModule.OpenAIDecisionProvider,
      ResearchTools: baselineResearchToolsModule.DecisionResearchTools,
      prompts,
    }),
    "OpenAI request and control-flow behavior must match the pinned baseline",
  );

  globalThis.console.log("Anthropic Opus 5.5 compatibility checks passed.");
} finally {
  globalThis.fetch = originalFetch;
}
