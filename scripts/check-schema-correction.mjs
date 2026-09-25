import assert from "node:assert/strict";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";
import { OpenAIDecisionProvider } from "../dist/src/llm/openai-provider.js";
import { AnthropicDecisionProvider } from "../dist/src/llm/anthropic-provider.js";

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
                  { type: "tool_use", id, name: call.name, input: call.input },
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
  assert.equal((await corrected.decide()).cycleSummary, validPlan.cycleSummary);
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
  assert.equal(corrected.transcript[1].toolResults[0].result.kind, "DECISION");

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
