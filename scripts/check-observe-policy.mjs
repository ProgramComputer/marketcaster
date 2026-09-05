import assert from "node:assert/strict";
import { log } from "node:console";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import pino from "pino";
import { runCycle } from "../dist/src/agent/cycle.js";
import { loadRuntimeConfiguration } from "../dist/src/config/runtime-overrides.js";
import {
  applyFreshForecastProbability,
  riskAdjustedProbability,
  validateProposals,
} from "../dist/src/risk/validate.js";

const { AbortController } = globalThis;
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "marketcaster-observe-"),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network is forbidden in the synthetic observe check");
};
try {
  const strategyPath = join(temporaryDirectory, "synthetic-policy.mjs");
  await writeFile(
    strategyPath,
    `
export const calls = { selection: 0, required: 0, refresh: 0, allocation: 0 };
export default api => ({
  apiVersion: 1,
  selection: {
    buildOpportunityBoard: () => [],
    buildEnrichedOpportunityBoard: async () => { calls.selection++; return []; },
    selectRequiredMarketSlugs: () => { calls.required++; return []; },
  },
  forecast: {
    forecastTolerance: new api.Decimal('0.01'),
    systemLiveEvidenceSources: () => [],
    liveEvidenceLinePreview: () => undefined,
    refreshForecasts: async () => {
      calls.refresh++;
      return { requiredMarketSlugs: new Set(), selectedSideProbabilityByMarketSlug: new Map() };
    },
  },
  allocation: () => { calls.allocation++; return []; },
  passAuditMinimumEdge: new api.Decimal(0),
});
`,
  );
  const runtime = await loadRuntimeConfiguration({
    MARKETCASTER_STRATEGY_PATH: strategyPath,
  });
  const { calls } = await import(pathToFileURL(strategyPath).href);
  const config = {
    ...runtime.config,
    agent: {
      ...runtime.config.agent,
      memory: { ...runtime.config.agent.memory, enabled: false },
      state: { ...runtime.config.agent.state, enabled: false },
      passResearch: Object.fromEntries(
        Object.keys(runtime.config.agent.passResearch).map((key) => [key, 0]),
      ),
    },
  };
  const observedAt = new Date("2026-01-01T00:00:00Z");
  const snapshot = {
    observedAt,
    currentBalance: new Decimal(100),
    buyingPower: new Decimal(100),
    assetNotional: new Decimal(0),
    assetAvailable: new Decimal(0),
    openOrderValue: new Decimal(0),
    unsettledFunds: new Decimal(0),
    marginRequirement: new Decimal(0),
    positions: [],
    openOrders: [],
    recentActivities: [],
  };
  let placements = 0;
  let cancellations = 0;
  const unsupportedRead = () => {
    throw new Error("Unexpected market read in the empty synthetic catalog");
  };
  const exchange = {
    id: "kalshi",
    memoryScope: "synthetic-observe",
    getAccountSnapshot: async () => snapshot,
    listMarkets: async () => ({ items: [], eof: true }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    getActivities: async () => ({ items: [], eof: true }),
    getMarket: unsupportedRead,
    getMarketBySlug: unsupportedRead,
    getBbo: unsupportedRead,
    getOrderBook: unsupportedRead,
    getSettlement: unsupportedRead,
    getOrder: unsupportedRead,
    previewImmediateOrder: unsupportedRead,
    createImmediateOrderFeeReserveEstimator: unsupportedRead,
    placeImmediateOrder: () => {
      placements++;
      throw new Error("Observe mode attempted placement");
    },
    cancelOrder: () => {
      cancellations++;
      throw new Error("Observe mode attempted cancellation");
    },
  };
  const decisionProvider = {
    providerId: "synthetic",
    modelId: "synthetic",
    decide: async ({
      researchTools,
      limits,
      signal,
      reviewTerminalDecision,
    }) => {
      const session = researchTools.createSession(limits);
      const result = await session.execute(
        "submit_trade_plan",
        {
          cycleSummary: "Synthetic empty catalog; no executable candidate.",
          portfolioTargets: [],
          candidateDispositions: [],
        },
        signal,
      );
      assert.equal(result.kind, "DECISION");
      const review = await reviewTerminalDecision(result.decision, signal);
      assert.equal(review.repair, false);
      return result.decision;
    },
  };
  const report = await runCycle({
    ...runtime,
    config,
    exchange,
    decisionProvider,
    mode: "observe",
    logger: pino({ level: "silent" }),
    now: () => observedAt,
    writeReports: false,
  });
  assert.equal(report.status, "PASS", JSON.stringify(report));
  assert.equal(placements, 0);
  assert.equal(cancellations, 0);
  for (const count of Object.values(calls)) assert(count > 0);

  // A refreshed point must retain the downside/upside risk envelope.
  const proposal = {
    marketSlug: "synthetic-market",
    side: "YES",
    action: "BUY",
    estimatedProbability: new Decimal("0.8"),
    probabilityLowerBound: new Decimal("0.5"),
    probabilityUpperBound: new Decimal("0.95"),
  };
  const refreshed = applyFreshForecastProbability(
    proposal,
    new Decimal("0.82"),
  );
  assert.equal(
    riskAdjustedProbability(refreshed, new Decimal("0.5")).toString(),
    "0.66",
  );
  assert.equal(refreshed.probabilityUpperBound.toString(), "0.95");
  const downward = applyFreshForecastProbability(proposal, new Decimal("0.2"));
  assert.equal(downward.probabilityLowerBound.toString(), "0.2");
  assert.equal(downward.probabilityUpperBound.toString(), "0.95");
  assert.equal(proposal.estimatedProbability.toString(), "0.8");

  for (const probability of [
    undefined,
    new Decimal("NaN"),
    new Decimal(-1),
    new Decimal("1.01"),
  ]) {
    const validation = await validateProposals({
      proposals: [proposal],
      snapshot,
      valuation: { riskEquity: new Decimal(100) },
      exchange,
      policy: config.risk,
      requireFreshProbabilityMarketSlugs: new Set([proposal.marketSlug]),
      freshProbabilityByMarketSlug: new Map(
        probability === undefined ? [] : [[proposal.marketSlug, probability]],
      ),
      signal: new AbortController().signal,
    });
    assert.equal(validation.accepted.length, 0);
    assert.equal(validation.rejected[0].code, "MARKET_CHANGED");
  }
  log(
    "Offline observe cycle, loaded hooks, forbidden mutations/network, and forecast-risk regressions passed.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
