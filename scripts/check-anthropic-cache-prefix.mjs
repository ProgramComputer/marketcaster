import assert from "node:assert/strict";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";
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
