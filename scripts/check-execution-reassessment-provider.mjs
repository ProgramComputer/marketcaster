import assert from "node:assert/strict";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";
import { OpenAIDecisionProvider } from "../dist/src/llm/openai-provider.js";
import { AnthropicDecisionProvider } from "../dist/src/llm/anthropic-provider.js";

// Every provider request is intercepted. These fixtures contain no account data.
const prompts = await loadPromptBundle();
const completePlan = {
  cycleSummary: "Synthetic execution reassessment",
  evidenceBundles: [],
  portfolioTargets: [],
  candidateDispositions: [],
};

for (const [Provider, providerKind] of [
  [OpenAIDecisionProvider, "openai"],
  [AnthropicDecisionProvider, "anthropic"],
]) {
  function harness({
    calls = [{ name: "submit_trade_plan", input: completePlan }],
    nativeSearch = false,
    malformedBlock = false,
    rawBody,
    status = 200,
    responseStatuses = [],
    delayed = false,
    thinking = false,
    signal,
    timeoutMilliseconds,
  } = {}) {
    const requests = [];
    const provenance = [];
    const transcript = [];
    let dispatches = 0;
    let reviews = 0;
    const tools = new DecisionResearchTools({
      prompts: prompts.research,
      webSearch: async () => {
        dispatches += 1;
        return [];
      },
      agentNotesHandler: async () => {
        dispatches += 1;
        return {};
      },
    });
    tools.recordProviderWebSearches(2, 1);
    tools.recordProviderEvidenceSources([
      {
        url: "https://example.com/synthetic-evidence",
        title: "Synthetic observed evidence",
        observedAt: "2026-01-01T00:00:00.000Z",
        provider: "CLIENT_WEB_SEARCH",
      },
    ]);
    const priorCounts = tools.totalCounts;
    const priorSources = tools.observedEvidenceSources;
    tools.createSession = () => {
      throw new Error("Execution reassessment must not create a session");
    };
    const provider = new Provider({
      apiKey: "synthetic-reassessment-key",
      modelId: "synthetic-primary",
      catalogModelId: "synthetic-catalog",
      extendedThinking: thinking,
      fetchImplementation: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (delayed) {
          await new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          });
        }
        const blocks = calls.map((call, index) =>
          providerKind === "openai"
            ? {
                type: "function_call",
                call_id: `synthetic-call-${index}`,
                name: call.name,
                arguments: JSON.stringify(call.input),
              }
            : {
                type: "tool_use",
                id: `synthetic-call-${index}`,
                name: call.name,
                input: call.input,
              },
        );
        if (nativeSearch)
          blocks.push(
            providerKind === "openai"
              ? { type: "web_search_call", status: "completed" }
              : {
                  type: "server_tool_use",
                  id: "synthetic-native-search",
                  name: "web_search",
                  input: { query: "synthetic" },
                },
          );
        if (malformedBlock)
          blocks.push({
            type: providerKind === "openai" ? "function_call" : "tool_use",
          });
        const body =
          providerKind === "openai"
            ? {
                id: "synthetic-response",
                status: "completed",
                output: blocks,
              }
            : {
                id: "synthetic-response",
                type: "message",
                role: "assistant",
                stop_reason: calls.length === 0 ? "end_turn" : "tool_use",
                content: blocks,
              };
        return new globalThis.Response(rawBody ?? JSON.stringify(body), {
          status: responseStatuses[requests.length - 1] ?? status,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        });
      },
    });
    return {
      requests,
      provenance,
      transcript,
      get dispatches() {
        return dispatches;
      },
      get reviews() {
        return reviews;
      },
      assertResearchPreserved() {
        assert.deepEqual(tools.totalCounts, priorCounts);
        assert.deepEqual(tools.observedEvidenceSources, priorSources);
      },
      decide: () =>
        provider.decide({
          mode: "EXECUTION_REASSESSMENT",
          prompt: {
            system: "Synthetic execution-only system instruction",
            user: "Submit one complete synthetic plan without research",
          },
          researchTools: tools,
          signal,
          limits: {
            maximumRounds: 4,
            maximumWebSearches: 3,
            maximumOutputTokens: 1234,
            timeoutMilliseconds: timeoutMilliseconds ?? (delayed ? 20 : 5000),
          },
          reviewTerminalDecision: async () => {
            reviews += 1;
            return {
              repair: true,
              feedback: {
                acceptedProposalIndexes: [],
                rejectedProposals: [],
                instructions: ["This generic repair must never be invoked"],
              },
            };
          },
          recordModelRequest: (request) => provenance.push(request),
          recordTranscriptRound: (round) => transcript.push(round),
        }),
    };
  }

  for (const thinking of [false, true]) {
    const successful = harness({ thinking });
    assert.equal(
      (await successful.decide()).cycleSummary,
      completePlan.cycleSummary,
    );
    assert.equal(successful.requests.length, 1);
    const request = successful.requests[0];
    assert.equal(request.model, "synthetic-primary");
    assert.deepEqual(
      request.tools.map((tool) => tool.name),
      ["submit_trade_plan"],
    );
    assert.equal(request.max_output_tokens ?? request.max_tokens, 1234);
    assert.equal(request.max_tool_calls, undefined);
    if (providerKind === "anthropic" && thinking)
      assert.deepEqual(request.tool_choice, { type: "auto" });
    else assert.equal(request.tool_choice.name, "submit_trade_plan");
    assert.equal(successful.provenance.length, 1);
    assert.equal(successful.transcript.length, 1);
    assert.equal(
      successful.transcript[0].toolResults[0].result.kind,
      "DECISION",
    );
    assert.equal(successful.reviews, 0);
    assert.equal(successful.dispatches, 0);
    successful.assertResearchPreserved();
  }

  const invalidCases = [
    { calls: [], thinking: true },
    { calls: [{ name: "submit_trade_plan", input: {} }] },
    {
      calls: [
        { name: "submit_trade_plan", input: completePlan },
        { name: "submit_trade_plan", input: completePlan },
      ],
    },
    { calls: [{ name: "web_search", input: { query: "synthetic" } }] },
    { calls: [{ name: "manage_notes", input: { action: "LIST" } }] },
    {
      calls: [
        { name: "submit_trade_plan", input: completePlan },
        { name: "manage_state", input: { action: "LIST" } },
      ],
    },
    { nativeSearch: true },
    { malformedBlock: true },
    { rawBody: "synthetic-invalid-json" },
    { rawBody: "{}" },
    { rawBody: "{}", status: 400 },
  ];
  for (const options of invalidCases) {
    const invalid = harness(options);
    await assert.rejects(invalid.decide(), (error) =>
      ["INVALID_DECISION", "INVALID_RESPONSE", "HTTP"].includes(error.code),
    );
    assert.equal(invalid.requests.length, 1);
    assert.equal(invalid.provenance.length, 1);
    assert.equal(invalid.transcript.length, 1);
    assert.equal(invalid.dispatches, 0);
    assert.equal(invalid.reviews, 0);
    invalid.assertResearchPreserved();
  }

  const timedOut = harness({ delayed: true });
  await assert.rejects(timedOut.decide(), (error) => error.code === "TIMEOUT");
  // Let the aborted transport finish recording its failure transcript.
  await setImmediate();
  assert.equal(timedOut.requests.length, 1);
  assert.equal(timedOut.provenance.length, 1);
  assert.equal(timedOut.transcript.length, 1);
  timedOut.assertResearchPreserved();

  const upstreamDeadline = harness({
    delayed: true,
    timeoutMilliseconds: 5000,
    signal: globalThis.AbortSignal.timeout(20),
  });
  await assert.rejects(
    upstreamDeadline.decide(),
    (error) => error.code === "ABORTED",
  );
  await setImmediate();
  assert.equal(upstreamDeadline.requests.length, 1);
  assert.equal(upstreamDeadline.transcript.length, 1);
  upstreamDeadline.assertResearchPreserved();

  const retriedTransport = harness({ responseStatuses: [429, 200] });
  await retriedTransport.decide();
  assert.equal(retriedTransport.requests.length, 2);
  assert.equal(retriedTransport.provenance.length, 1);
  assert.equal(retriedTransport.transcript.length, 1);
  assert.equal(retriedTransport.transcript[0].providerRequestAttempts, 2);
  retriedTransport.assertResearchPreserved();
}

process.stdout.write(
  "Execution-only provider submissions, bounded failures, and research preservation passed.\n",
);
