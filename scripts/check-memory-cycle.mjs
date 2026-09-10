import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Decimal } from "decimal.js";
import pino from "pino";
import { runCycle } from "../src/agent/cycle.ts";
import { FileAgentState } from "../src/agent/agent-state.ts";
import { loadRepositoryConfig } from "../src/config/schema.ts";

async function runWithLocalSummary(directory, dependencies) {
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = join(directory, "synthetic-summary.md");
  try {
    return await runCycle(dependencies);
  } finally {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  }
}

/** Full offline observe cycle: no exchange writes and no external evidence. */
export async function checkCycleForecastMemory(directory, prompts) {
  const now = () => new Date("2026-01-02T12:00:00.000Z");
  const decimal = (value = 0) => new Decimal(value);
  const marketId = { exchange: "kalshi", value: "synthetic-exit" };
  const market = {
    id: marketId,
    slug: "synthetic-exit",
    title: "Synthetic event",
    description: "Synthetic contract used only for an offline test",
    settlementRules: "Settles from the synthetic event's recorded outcome",
    active: true,
    closed: false,
    archived: false,
    minimumTradeQuantity: decimal(1),
    priceTick: decimal("0.01"),
    closesAt: new Date("2026-01-03T12:00:00.000Z"),
    liquidity: decimal(10000),
    volume24h: decimal(2000),
  };
  const position = {
    marketId,
    marketSlug: market.slug,
    side: "YES",
    quantity: decimal(10),
    availableQuantity: decimal(10),
    costBasis: decimal(4),
    realizedPnl: decimal(0),
    expired: false,
  };
  const snapshot = {
    observedAt: now(),
    currentBalance: decimal(100),
    buyingPower: decimal(100),
    assetNotional: decimal(5),
    assetAvailable: decimal(5),
    openOrderValue: decimal(0),
    unsettledFunds: decimal(0),
    marginRequirement: decimal(0),
    positions: [position],
    openOrders: [],
    recentActivities: [],
  };
  const forbidden = () => {
    throw new Error(
      "Offline observe cycle must never place or cancel an order",
    );
  };
  const exchange = {
    id: "kalshi",
    memoryScope: "synthetic-memory-account",
    listMarkets: async () => ({ items: [market], eof: true }),
    getMarket: async () => market,
    getMarketBySlug: async () => market,
    getBbo: async () => ({
      marketId,
      yes: { bid: decimal("0.5"), ask: decimal("0.51") },
      no: { bid: decimal("0.49"), ask: decimal("0.5") },
      observedAt: now(),
    }),
    getOrderBook: async () => ({
      marketId,
      yesBids: [{ price: decimal("0.5"), quantity: decimal(100) }],
      yesAsks: [{ price: decimal("0.51"), quantity: decimal(100) }],
      observedAt: now(),
    }),
    getSettlement: async () => ({ marketId, state: "OPEN" }),
    getAccountSnapshot: async () => snapshot,
    getPositions: async () => [position],
    getOpenOrders: async () => [],
    getActivities: async () => ({ items: [], eof: true }),
    previewImmediateOrder: async () => ({
      accepted: true,
      estimatedFees: decimal(0),
      warnings: [],
      rejectionReasons: [],
    }),
    createImmediateOrderFeeReserveEstimator: async () => () => decimal(0),
    placeImmediateOrder: forbidden,
    cancelOrder: forbidden,
  };
  const loadedConfig = await loadRepositoryConfig();
  const config = {
    ...loadedConfig,
    reporting: {
      ...loadedConfig.reporting,
      directory: join(directory, "full-cycle"),
      shadowLedger: { ...loadedConfig.reporting.shadowLedger, enabled: false },
    },
  };
  const report = await runWithLocalSummary(directory, {
    config,
    prompts,
    exchange,
    mode: "observe",
    logger: pino({ level: "silent" }),
    runId: "memory-fixture",
    cycleId: "scalar-conflict",
    now,
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
        const details = await session.execute(
          "get_market_details",
          { marketSlug: market.slug },
          signal,
        );
        assert.equal(JSON.parse(details.content).market.slug, market.slug);
        const unrelated = await session.execute(
          "manage_state",
          {
            action: "SET_NEXT_CYCLE_PLAN",
            content: "Synthetic unsupported advisory write",
            marketSlugs: ["uninspected-other-market"],
            basisMarketSlugs: ["uninspected-other-market"],
          },
          signal,
        );
        assert.equal(JSON.parse(unrelated.content).ok, false);
        assert.equal(JSON.parse(unrelated.content).staged, false);
        const write = await session.execute(
          "manage_state",
          {
            action: "ADD_BELIEF",
            type: "EVENT_ANALYSIS",
            confidence: 60,
            content:
              "Synthetic note has a mismatched scalar; retain its text for review",
            marketSlugs: [market.slug],
            basisMarketSlugs: [market.slug],
            evidenceUpdatedAt: now().toISOString(),
            invalidationConditions: [],
            forecastYesProbability: 0.8,
          },
          signal,
        );
        assert.equal(JSON.parse(write.content).staged, true);
        const submission = await session.execute(
          "submit_trade_plan",
          {
            cycleSummary: "Synthetic exit is independently eligible",
            portfolioTargets: [
              {
                marketSlug: market.slug,
                side: "YES",
                targetCostBasisFraction: "0",
                estimatedProbability: "0.2",
                probabilityLowerBound: "0.1",
                probabilityUpperBound: "0.3",
                maximumEntryPrice: null,
                minimumExitPrice: "0.45",
                confidence: "MEDIUM",
                thesis: "Synthetic target exits an existing position",
                settlementVerification: "Synthetic existing contract",
                invalidationConditions: "Synthetic revision",
                evidence: [],
                evidenceBundleIds: [],
              },
            ],
            candidateDispositions: [],
          },
          signal,
        );
        assert.equal(submission.kind, "DECISION");
        const feedback = await reviewTerminalDecision(
          submission.decision,
          signal,
        );
        assert.equal(feedback.repair, false, JSON.stringify(feedback));
        return submission.decision;
      },
    },
  });
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.equal(report.mode, "observe");
  assert.equal(report.risk.accepted.length, 1, JSON.stringify(report.risk));
  assert.equal(report.risk.rejected.length, 0);
  assert.equal(report.agent.portfolioTargets[0].estimatedProbability, "0.2");
  const persisted = await new FileAgentState({
    filePath: join(
      config.reporting.directory,
      "memory",
      exchange.id,
      `${exchange.memoryScope}.state.json`,
    ),
    now,
  }).loadAudit();
  assert.equal(persisted.beliefs[0].forecastYesProbability, null);
  assert.equal(persisted.beliefs[0].forecastReview.originalYesProbability, 0.8);
  assert.equal(persisted.beliefs[0].forecastReview.targetYesProbability, 0.2);
  const artifacts = join(
    config.reporting.directory,
    "runs",
    "memory-fixture",
    "scalar-conflict",
  );
  const review = JSON.parse(
    await readFile(join(artifacts, "forecast-memory-review.json"), "utf8"),
  );
  assert.equal(review.data.issues[0].originalYesProbability, 0.8);
  assert.equal(review.data.issues[0].targetYesProbability, 0.2);
  const persistence = JSON.parse(
    await readFile(join(artifacts, "advisory-persistence.json"), "utf8"),
  );
  assert.equal(persistence.data.status, "COMMITTED");
  assert.equal(
    report.agent.decisionAudit.forecastMemory.quarantinedBeliefIds.length,
    1,
  );
}
