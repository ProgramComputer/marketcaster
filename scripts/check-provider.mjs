// check-schema-correction.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DecisionResearchTools } =
    await import("../dist/src/llm/research-tools.js");
  const { OpenAIDecisionProvider } =
    await import("../dist/src/llm/openai-provider.js");
  const { AnthropicDecisionProvider } =
    await import("../dist/src/llm/anthropic-provider.js");
  // All provider requests are intercepted below; no keys, models, or network are used.
  const prompts = await loadPromptBundle();
  const validPlan = {
    cycleSummary: "Synthetic terminal plan",
    evidenceBundles: [],
    portfolioTargets: [],
    candidateDispositions: [],
  };
  const submit = (input) => ({ name: "submit_trade_plan", input });
  const invalid = submit({ cycleSummary: "Missing required fields" });
  const valid = submit(validPlan);
  const feedback = {
    acceptedProposalIndexes: [],
    rejectedProposals: [],
    instructions: ["Synthetic guard requires one correction"],
  };

  for (const [Provider, providerKind] of [
    [OpenAIDecisionProvider, "openai"],
    [AnthropicDecisionProvider, "anthropic"],
  ]) {
    function harness(
      sequence,
      { toolOptions = {}, inputOptions = {}, fetchHook } = {},
    ) {
      const requests = [];
      const transcript = [];
      let reviews = 0;
      const provider = new Provider({
        apiKey: "synthetic-fixture-key",
        modelId: "synthetic-model",
        fetchImplementation: async (_url, init) => {
          const request = JSON.parse(init.body);
          requests.push(request);
          if (fetchHook !== undefined)
            await fetchHook(requests.length, init.signal);
          const call = sequence[requests.length - 1];
          assert.ok(call, `${providerKind}: unexpected extra provider request`);
          const id = `synthetic-call-${requests.length}`;
          const response =
            providerKind === "openai"
              ? {
                  id,
                  status: "completed",
                  output: [
                    {
                      type: "function_call",
                      call_id: id,
                      name: call.name,
                      arguments: JSON.stringify(call.input),
                    },
                  ],
                }
              : {
                  id,
                  type: "message",
                  role: "assistant",
                  stop_reason: "tool_use",
                  content: [
                    {
                      type: "tool_use",
                      id,
                      name: call.name,
                      input: call.input,
                    },
                  ],
                };
          return new globalThis.Response(JSON.stringify(response), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      return {
        requests,
        transcript,
        get reviews() {
          return reviews;
        },
        decide: () =>
          provider.decide({
            prompt: {
              system: "Synthetic system prompt",
              user: "Synthetic request",
            },
            researchTools: new DecisionResearchTools({
              prompts: prompts.research,
              ...toolOptions,
            }),
            limits: {
              maximumRounds: 1,
              maximumWebSearches: 0,
              timeoutMilliseconds: 5000,
            },
            reviewTerminalDecision: async () => {
              reviews += 1;
              return { repair: false };
            },
            recordTranscriptRound: (round) => transcript.push(round),
            ...inputOptions,
          }),
      };
    }

    const corrected = harness([invalid, valid]);
    assert.equal(
      (await corrected.decide()).cycleSummary,
      validPlan.cycleSummary,
    );
    assert.equal(
      corrected.requests.length,
      2,
      "One reserved submission survives the normal round limit",
    );
    assert.equal(
      corrected.reviews,
      1,
      "Only the corrected schema reaches substantive validation",
    );
    if (providerKind === "anthropic") {
      assert.deepEqual(
        corrected.requests[1].tools,
        corrected.requests[0].tools,
        "Anthropic schema correction keeps the cached tool prefix",
      );
    } else {
      assert.deepEqual(
        corrected.requests[1].tools.map((tool) => tool.name),
        ["submit_trade_plan"],
      );
    }
    assert.equal(corrected.requests[1].tool_choice.name, "submit_trade_plan");
    assert.ok(corrected.transcript[0].toolResults[0].result.isError);
    assert.equal(
      corrected.transcript[1].toolResults[0].result.kind,
      "DECISION",
    );

    const repeated = harness([invalid, invalid]);
    await assert.rejects(
      repeated.decide(),
      (error) => error.code === "INVALID_DECISION",
    );
    assert.equal(repeated.requests.length, 2);
    assert.equal(repeated.reviews, 0);

    const smuggledTool = harness([
      invalid,
      { name: "read_evidence_source", input: { url: "https://example.com" } },
    ]);
    await assert.rejects(
      smuggledTool.decide(),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(
      smuggledTool.requests.length,
      2,
      "Schema correction does not open extra research rounds",
    );

    const ordinaryRejection = harness([valid], {
      toolOptions: {
        requiredPriorityEvidenceMarketSlugs: ["synthetic-uninspected"],
      },
    });
    await assert.rejects(
      ordinaryRejection.decide(),
      (error) => error.code === "ROUND_LIMIT",
    );
    assert.equal(
      ordinaryRejection.requests.length,
      1,
      "A substantive tool rejection cannot claim a schema exception",
    );
    assert.equal(ordinaryRejection.reviews, 0);

    let guardReviews = 0;
    const guarded = harness([valid, invalid, valid], {
      inputOptions: {
        reviewTerminalDecision: async () => {
          guardReviews += 1;
          return guardReviews === 1
            ? { repair: true, feedback }
            : { repair: false };
        },
      },
    });
    await guarded.decide();
    assert.equal(guarded.requests.length, 3);
    assert.equal(
      guardReviews,
      2,
      "Schema correction cannot bypass a substantive terminal guard",
    );
    if (providerKind === "anthropic") {
      assert.deepEqual(guarded.requests[2].tools, guarded.requests[0].tools);
    } else {
      assert.deepEqual(
        guarded.requests[2].tools.map((tool) => tool.name),
        ["submit_trade_plan"],
      );
    }

    const timeout = harness([invalid, valid], {
      inputOptions: {
        limits: {
          maximumRounds: 1,
          maximumWebSearches: 0,
          timeoutMilliseconds: 50,
        },
      },
      fetchHook: async (count, signal) => {
        if (count === 2)
          await new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
      },
    });
    await assert.rejects(timeout.decide(), (error) => error.code === "TIMEOUT");
    assert.equal(
      timeout.requests.length,
      2,
      "Reserved submission shares the original decision deadline",
    );
  }
})();

// check-anthropic-cache-prefix.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { aggregateCacheDiagnostics } =
    await import("../dist/src/agent/cycle.js");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DecisionResearchTools } =
    await import("../dist/src/llm/research-tools.js");
  const { AnthropicDecisionProvider } =
    await import("../dist/src/llm/anthropic-provider.js");
  // All provider requests are intercepted below; no keys, models, or network are used.
  const prompts = await loadPromptBundle();
  const validPlan = {
    cycleSummary: "Synthetic terminal plan",
    evidenceBundles: [],
    portfolioTargets: [],
    candidateDispositions: [],
  };
  const submit = (input) => ({ name: "submit_trade_plan", input });
  const invalid = submit({ cycleSummary: "Missing required fields" });
  const valid = submit(validPlan);
  const research = {
    name: "read_evidence_source",
    input: { url: "https://example.com/synthetic-unobserved-source" },
  };
  const forcedSubmission = { type: "tool", name: "submit_trade_plan" };

  async function run(sequence, maximumRounds) {
    const requests = [];
    const provider = new AnthropicDecisionProvider({
      apiKey: "synthetic-fixture-key",
      modelId: "synthetic-model",
      fetchImplementation: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        const call = sequence[requests.length - 1];
        assert.ok(call, "unexpected extra provider request");
        const id = `synthetic-call-${requests.length}`;
        return new globalThis.Response(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id, name: call.name, input: call.input },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const decision = await provider.decide({
      prompt: { system: "Synthetic system prompt", user: "Synthetic request" },
      researchTools: new DecisionResearchTools({ prompts: prompts.research }),
      limits: {
        maximumRounds,
        maximumWebSearches: 2,
        timeoutMilliseconds: 5000,
      },
      reviewTerminalDecision: async () => ({ repair: false }),
    });
    assert.equal(decision.cycleSummary, validPlan.cycleSummary);
    return requests;
  }

  function assertStablePrefix(requests) {
    const [first, ...rest] = requests;
    assert.ok(
      first.tools.some(
        (tool) => tool.name === "web_search" && tool.type !== undefined,
      ),
      "Synthetic fixture exercises provider web search",
    );
    assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(first.tools.at(-1).cache_control, { type: "ephemeral" });
    for (const request of rest) {
      assert.deepEqual(request.tools, first.tools);
      assert.deepEqual(request.system, first.system);
      assert.equal(request.model, first.model);
    }
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(
        requests[index].messages.slice(0, requests[index - 1].messages.length),
        requests[index - 1].messages,
        "Each request appends to the previous message history",
      );
    }
  }

  // Normal round, forced final round, then schema correction of the final plan.
  const finalCorrection = await run([research, invalid, valid], 2);
  assert.equal(finalCorrection.length, 3);
  assertStablePrefix(finalCorrection);
  assert.deepEqual(finalCorrection[0].tool_choice, { type: "any" });
  assert.deepEqual(finalCorrection[1].tool_choice, forcedSubmission);
  assert.deepEqual(
    finalCorrection[2].tool_choice,
    finalCorrection[1].tool_choice,
    "Schema correction forces submission exactly as the final round does",
  );

  // Schema correction after an ordinary research round.
  const researchCorrection = await run([invalid, valid], 3);
  assert.equal(researchCorrection.length, 2);
  assertStablePrefix(researchCorrection);
  assert.deepEqual(researchCorrection[0].tool_choice, { type: "any" });
  assert.deepEqual(researchCorrection[1].tool_choice, forcedSubmission);

  // A correction round that changes the prefix is one miss. The next round is
  // still diagnosed against the correction request, but reads an older cache
  // entry covering its whole prompt, so it adds no missed input tokens.
  const diagnosticRound = (round, usage, cacheDiagnostic) => ({
    round,
    response: {},
    toolCalls: [],
    toolResults: [],
    providerWebSearchCount: 0,
    diagnosticsPreviousMessageId: round === 1 ? null : `synthetic-${round - 1}`,
    tokenUsage: { outputTokens: 10, ...usage },
    cacheDiagnostic,
  });
  const unchanged = { state: "DIAGNOSTICS_NULL" };
  const toolsChanged = {
    state: "CACHE_MISS",
    reasonType: "tools_changed",
    missedInputTokens: 30_000,
  };
  const diagnostics = aggregateCacheDiagnostics([
    diagnosticRound(
      1,
      {
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 30_000,
      },
      unchanged,
    ),
    diagnosticRound(
      2,
      {
        inputTokens: 20,
        cachedInputTokens: 29_980,
        cacheCreationInputTokens: 5_000,
      },
      unchanged,
    ),
    diagnosticRound(
      3,
      {
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 33_000,
      },
      toolsChanged,
    ),
    diagnosticRound(
      4,
      {
        inputTokens: 20,
        cachedInputTokens: 35_000,
        cacheCreationInputTokens: 4_000,
      },
      toolsChanged,
    ),
  ]);
  assert.deepEqual(diagnostics.missReasonCounts, { tools_changed: 2 });
  assert.equal(
    diagnostics.missedInputTokens,
    30_000,
    "A recovered prefix is not counted as a second miss",
  );
})();
