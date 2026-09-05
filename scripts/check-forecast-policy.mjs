import assert from "node:assert/strict";
import { log } from "node:console";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import {
  DecisionResearchTools,
  forecastPolicyApi,
} from "../dist/src/llm/research-tools.js";

const prompts = await loadPromptBundle();
const { AbortController } = globalThis;
const signal = new AbortController().signal;
const details = {
  id: "synthetic-id",
  slug: "synthetic-market",
  title: "Synthetic event",
  description: "Synthetic engine-contract fixture",
  settlementRules: "YES if the synthetic event occurs; otherwise NO.",
  category: "Synthetic",
  active: true,
  closed: false,
  archived: false,
  minimumTradeQuantity: "1",
  priceTick: "0.01",
  quoteAvailable: false,
  warnings: [],
  held: false,
};

let sourceReads = 0;
const reader = async () => {
  sourceReads += 1;
  return { text: "Observed synthetic value: 7" };
};
const baseline = new DecisionResearchTools({
  prompts: prompts.research,
  marketDetails: [details],
  evidencePageReader: reader,
});
const baselineResult = await baseline
  .createSession(DEFAULT_DECISION_LIMITS)
  .execute("get_market_details", { marketSlug: details.slug }, signal);
assert.equal(baselineResult.isError, false);
assert.equal(sourceReads, 0);
assert.equal(baseline.observedEvidenceSources.length, 0);
assert.equal(JSON.parse(baselineResult.content).liveEvidenceSources, undefined);

const operations = [];
const policy = {
  forecastTolerance: new forecastPolicyApi.Decimal("0.01"),
  systemLiveEvidenceSources: () => [
    {
      title: "Synthetic source",
      url: "https://example.com/synthetic-evidence",
      findHint: "synthetic",
    },
  ],
  liveEvidenceLinePreview: (text) => ({
    evidenceExcerpt: text,
    preview: `${text}\nDerived synthetic estimate: 0.4`,
  }),
  refreshForecasts: async () => ({
    requiredMarketSlugs: new Set(),
    selectedSideProbabilityByMarketSlug: new Map(),
  }),
};
const tools = new DecisionResearchTools({
  prompts: prompts.research,
  marketDetails: [details],
  evidencePageReader: reader,
  forecastPolicy: policy,
  agentStateHandler: async (operation) => {
    operations.push(operation);
    return { action: operation.action };
  },
});
const session = tools.createSession(DEFAULT_DECISION_LIMITS);
const result = await session.execute(
  "get_market_details",
  { marketSlug: details.slug },
  signal,
);
assert.equal(result.isError, false);
assert.equal(sourceReads, 1);
assert.match(
  JSON.parse(result.content).liveEvidenceSources[0].preview,
  /Derived synthetic estimate/u,
);
assert.equal(tools.observedEvidenceSources.length, 1);
assert.equal(
  tools.observedEvidenceSources[0].excerpt,
  "Observed synthetic value: 7",
);
assert.doesNotMatch(
  JSON.stringify(tools.observedEvidenceSources),
  /Derived synthetic estimate/u,
);

const update = {
  action: "UPDATE_BELIEF",
  beliefId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "SUPERSEDED",
  supersedesBeliefId: null,
  expiresAt: null,
  reviewAt: "2026-01-02T00:00:00Z",
};
const updateResult = await session.execute("manage_state", update, signal);
assert.equal(updateResult.isError, false);
assert.deepEqual(operations[0], update);
assert.equal("evidenceUrls" in operations[0], false);
assert.equal("basisMarketSlugs" in operations[0], false);

log(
  "Forecast policy injection, evidence separation, and state metadata checks passed.",
);
