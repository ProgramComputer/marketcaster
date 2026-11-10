import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import pino from "pino";
import { runCycle } from "../dist/src/agent/cycle.js";
import { loadRuntimeConfiguration } from "../dist/src/config/runtime-overrides.js";

// Exercise actual target reconciliation and terminal review with no live APIs.
const root = await mkdtemp(
  join(tmpdir(), "marketcaster-research-continuation-"),
);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network forbidden in synthetic cycle");
};
const D = (value) => new Decimal(value);
const at = new Date("2040-01-01T12:00:00Z");
const market = (slug) => ({
  id: { exchange: "kalshi", value: slug },
  slug,
  title: `Synthetic ${slug}`,
  description: "Synthetic contract.",
  settlementRules: "Synthetic official result.",
  active: true,
  closed: false,
  archived: false,
  tags: [],
  category: "synthetic",
  closesAt: new Date("2040-01-02T12:00:00Z"),
  minimumTradeQuantity: D(1),
  priceTick: D("0.01"),
});
const markets = [market("synthetic-held"), market("synthetic-pending")];
const position = {
  marketId: markets[0].id,
  marketSlug: markets[0].slug,
  side: "YES",
  quantity: D(10),
  availableQuantity: D(10),
  costBasis: D(2),
  realizedPnl: D(0),
  expired: false,
};
const snapshot = {
  observedAt: at,
  currentBalance: D(98),
  buyingPower: D(98),
  assetNotional: D(2),
  assetAvailable: D(2),
  openOrderValue: D(0),
  unsettledFunds: D(0),
  marginRequirement: D(0),
  positions: [position],
  openOrders: [],
  recentActivities: [],
};
const forbidden = () => {
  throw new Error("Unexpected exchange mutation or execution preview");
};
const exchange = {
  id: "kalshi",
  memoryScope: "synthetic-continuation",
  getAccountSnapshot: async () => snapshot,
  listMarkets: async () => ({ items: markets, eof: true }),
  getPositions: async () => snapshot.positions,
  getOpenOrders: async () => [],
  getActivities: async () => ({ items: [], eof: true }),
  getMarket: async (id) => markets.find((item) => item.id.value === id.value),
  getMarketBySlug: async (slug) => markets.find((item) => item.slug === slug),
  getBbo: async (marketId) => ({ marketId, yes: {}, no: {}, observedAt: at }),
  getOrderBook: async (marketId) => ({
    marketId,
    yesBids: [],
    yesAsks: [],
    observedAt: at,
  }),
  getSettlement: async () => ({ status: "UNRESOLVED" }),
  getOrder: forbidden,
  previewImmediateOrder: forbidden,
  createImmediateOrderFeeReserveEstimator: forbidden,
  placeImmediateOrder: forbidden,
  cancelOrder: forbidden,
};
try {
  const runtime = await loadRuntimeConfiguration({});
  for (const exhaust of [false, true]) {
    let reviews = 0;
    const config = {
      ...runtime.config,
      reporting: {
        ...runtime.config.reporting,
        directory: join(root, String(exhaust)),
        shadowLedger: {
          ...runtime.config.reporting.shadowLedger,
          enabled: false,
        },
      },
      agent: {
        ...runtime.config.agent,
        maximumMarketDetailRequests: exhaust ? 1 : 3,
        memory: { ...runtime.config.agent.memory, enabled: false },
        state: { ...runtime.config.agent.state, enabled: false },
        passResearch: Object.fromEntries(
          Object.keys(runtime.config.agent.passResearch).map((key) => [key, 0]),
        ),
      },
    };
    const report = await runCycle({
      ...runtime,
      config,
      exchange,
      mode: "observe",
      now: () => at,
      logger: pino({ level: "silent" }),
      runId: "synthetic-run",
      cycleId: "synthetic-cycle",
      strategy: {
        ...runtime.strategy,
        selection: {
          ...runtime.strategy.selection,
          selectResearchContinuationMarketSlugs: (board) =>
            board.map((item) => item.slug),
        },
      },
      decisionProvider: {
        providerId: "synthetic",
        modelId: "synthetic",
        decide: async ({
          researchTools,
          limits,
          signal,
          reviewTerminalDecision,
        }) => {
          const session = researchTools.createSession(limits);
          session.observeRound(false);
          const inspected = await session.execute(
            "get_market_details",
            { marketSlug: "synthetic-held" },
            signal,
          );
          assert.equal(inspected.isError, false, inspected.content);
          const held = JSON.parse(inspected.content).market;
          const plan = {
            cycleSummary: exhaust
              ? "Synthetic incomplete coverage: detail budget exhausted."
              : "Synthetic held position unchanged.",
            portfolioTargets: [
              {
                marketSlug: "synthetic-held",
                side: "LONG",
                targetCostBasisFraction:
                  held.existingExposure.costBasisFractionOfRiskEquity,
                estimatedProbability: "0.5",
                probabilityLowerBound: "0.3",
                probabilityUpperBound: "0.7",
                confidence: "LOW",
                thesis: "Retain current synthetic exposure.",
                settlementVerification:
                  "Synthetic contract remains unresolved.",
                invalidationConditions: "A changed synthetic result.",
                evidence: [],
              },
            ],
            candidateDispositions: [],
          };
          const submitted = await session.execute(
            "submit_trade_plan",
            plan,
            signal,
          );
          assert.equal(submitted.kind, "DECISION", submitted.content);
          const review = await reviewTerminalDecision(
            submitted.decision,
            signal,
          );
          reviews += 1;
          assert.equal(review.repair, false, JSON.stringify(review));
          if (exhaust) {
            assert.notEqual(review.continueResearch, true);
            return submitted.decision;
          }
          assert.equal(review.continueResearch, true, JSON.stringify(review));
          assert.ok(
            review.feedback.instructions.some((item) =>
              item.includes("synthetic-pending"),
            ),
          );
          session.continueResearch();
          const next = await session.execute(
            "get_market_details",
            { marketSlug: "synthetic-pending" },
            signal,
          );
          assert.equal(next.isError, false, next.content);
          const final = await session.execute(
            "submit_trade_plan",
            plan,
            signal,
          );
          assert.equal(final.kind, "DECISION");
          assert.deepEqual(
            await reviewTerminalDecision(final.decision, signal),
            { repair: false },
          );
          reviews += 1;
          return final.decision;
        },
      },
    });
    assert.equal(reviews, exhaust ? 1 : 2);
    assert.equal(
      report.candidateFunnel.passResearchGate.status,
      exhaust ? "INCOMPLETE_NO_ORDERS" : "NO_QUALIFIED_CANDIDATES",
    );
    assert.equal(report.executions.length, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
