import assert from "node:assert/strict";
import process from "node:process";
import { Decimal } from "decimal.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";
import {
  buildOpportunityBoard,
  buildEnrichedOpportunityBoard,
  referenceSelectionPolicy,
} from "../dist/src/agent/opportunity-board.js";
import { buildFamilyScout } from "../dist/src/agent/family-scout.js";
import {
  freezeMarketSelectionSnapshot,
  replayMarketSelectionExperiment,
} from "../dist/src/experiments/market-selection.js";

const now = new Date("2030-01-01T00:00:00Z");
const markets = Array.from({ length: 6 }, (_, index) => ({
  id: { exchange: "kalshi", value: `synthetic-${index}` },
  slug: `synthetic-${index}`,
  eventId: "synthetic-event",
  title: `Synthetic outcome ${index}`,
  description: "Synthetic fixture",
  settlementRules: "Use the synthetic result.",
  active: true,
  closed: false,
  archived: false,
  closesAt: new Date("2030-01-02T00:00:00Z"),
  lastPrice: new Decimal("0.5"),
  minimumTradeQuantity: new Decimal(1),
  priceTick: new Decimal("0.01"),
}));
const catalog = {
  markets: [...markets, markets[0]],
  bySlug: new Map(markets.map((market) => [market.slug, market])),
  exchangeRanks: new Map(
    markets.map((market, index) => [market.slug, 6 - index]),
  ),
  heldSlugs: new Set([markets[5].slug]),
  categoryCounts: {},
  exchangeRankingBasis: "EXCHANGE_DEFAULT",
  warnings: [],
};
const config = {
  opportunityBoardVariant: "SYNTHETIC",
  maximumPromptMarkets: 3,
  minimumMinutesToClose: 0,
  maximumDaysToClose: 2,
  maximumSpread: new Decimal("0.05"),
  minimumLiquidityUsd: new Decimal(0),
  minimumVolume24hUsd: new Decimal(0),
  allowIfLiquidityOrVolumePasses: true,
};
const board = buildOpportunityBoard(catalog, config, now);
assert.deepEqual(
  board.map((row) => row.slug),
  ["synthetic-4", "synthetic-3", "synthetic-2"],
);
assert(
  board.every(
    (row) => row.prioritySignal === undefined && row.familyScout === undefined,
  ),
);
assert.deepEqual(referenceSelectionPolicy.selectRequiredMarketSlugs(board), []);
assert.throws(
  () => buildOpportunityBoard(catalog, config, new Date(Number.NaN)),
  TypeError,
);

const enrichedConfig = {
  ...config,
  familyScouts: {
    enabled: true,
    reservedPromptMarkets: 0,
    maximumFamilies: 1,
    maximumMembersPerFamily: 2,
    minimumFamilyMembers: 2,
    enrichmentRequestBudget: 2,
    scoringWeights: Object.fromEntries(
      [
        "liquidityOrDepth",
        "volume24h",
        "uncertainty",
        "exchangeRankQuality",
        "cappedRecurrence",
      ].map((key) => [key, new Decimal(0)]),
    ),
  },
};
let requests = 0;
const enriched = await buildEnrichedOpportunityBoard(
  catalog,
  enrichedConfig,
  async (slug) => {
    requests += 1;
    return {
      market: catalog.bySlug.get(slug),
      bbo: {
        yes: { bid: new Decimal("0.4"), ask: new Decimal("0.6") },
        no: {},
      },
    };
  },
  now,
);
assert.equal(requests, 2);
assert.deepEqual(
  enriched.map((row) => row.slug),
  ["synthetic-2", "synthetic-1", "synthetic-0"],
);
const mismatch = await buildEnrichedOpportunityBoard(
  catalog,
  enrichedConfig,
  async () => ({ market: markets[0] }),
  now,
);
assert.deepEqual(
  mismatch.map((row) => row.slug),
  ["synthetic-2", "synthetic-1", "synthetic-0"],
);
const controller = new globalThis.AbortController();
controller.abort();
await assert.rejects(
  buildEnrichedOpportunityBoard(
    catalog,
    enrichedConfig,
    async () => {
      throw new Error("must not be called");
    },
    now,
    controller.signal,
  ),
);

const rows = markets.map((market, index) => ({
  market,
  exchangeRank: index + 1,
}));
const options = {
  maximumFamilies: 1,
  maximumMembersPerFamily: 2,
  minimumFamilyMembers: 2,
};
assert.deepEqual(
  buildFamilyScout(rows, options)[0].sampledMembers.map(
    (row) => row.market.slug,
  ),
  ["synthetic-0", "synthetic-1"],
);
assert.deepEqual(
  buildFamilyScout(rows, {
    ...options,
    selectMembers: (members) => members.slice(-2),
  })[0].sampledMembers.map((row) => row.market.slug),
  ["synthetic-4", "synthetic-5"],
);
assert.throws(
  () =>
    buildFamilyScout(rows, {
      ...options,
      selectMembers: (members) => [members[0], members[0]],
    }),
  TypeError,
);
assert.throws(
  () =>
    buildFamilyScout(rows, { ...options, selectMembers: (members) => members }),
  TypeError,
);

const snapshot = freezeMarketSelectionSnapshot(
  { ...catalog, markets },
  config,
  now,
);
const definition = {
  experimentId: "synthetic-comparison",
  hypothesis: "Compare two supplied orderings.",
  controlVariant: "FIRST",
  treatmentVariant: "LAST",
  limitations: ["Synthetic fixtures only."],
};
const report = replayMarketSelectionExperiment(
  snapshot,
  definition,
  (input, policy, at, variant) => {
    const selected = buildOpportunityBoard(input, policy, at);
    return variant === "LAST" ? selected.slice(-1) : selected.slice(0, 1);
  },
);
assert.equal(report.experimentId, definition.experimentId);
assert.equal(report.comparison.overlapCount, 0);
assert.equal(report.control.selections.length, 1);
assert.equal(report.treatment.selections.length, 1);
const prompts = await loadPromptBundle();
const terminalPlan = {
  cycleSummary: "Synthetic plan",
  evidenceBundles: [],
  portfolioTargets: [],
  candidateDispositions: [],
};
const gateOptions = {
  prompts: prompts.research,
  requiredPriorityEvidenceMarketSlugs: ["synthetic-uninspected"],
};
const gateSignal = new globalThis.AbortController().signal;
const uniform = await new DecisionResearchTools(gateOptions)
  .createSession(DEFAULT_DECISION_LIMITS)
  .execute("submit_trade_plan", terminalPlan, gateSignal);
assert.equal(uniform.isError, true);
assert.match(uniform.content, /PRIORITY_RESEARCH_REQUIRED/u);
let gateCalls = 0;
const supplied = await new DecisionResearchTools({
  ...gateOptions,
  requiredResearchGate: (decision, details) => {
    gateCalls += 1;
    assert.equal(decision.cycleSummary, terminalPlan.cycleSummary);
    assert.equal(details.size, 0);
    return false;
  },
})
  .createSession(DEFAULT_DECISION_LIMITS)
  .execute("submit_trade_plan", terminalPlan, gateSignal);
assert.equal(supplied.kind, "DECISION");
assert.equal(gateCalls, 1);
process.stdout.write(
  "Synthetic selection contract, budget, cancellation, grouping, and replay checks passed.\n",
);
