import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import {
  loadEntryFills,
  summarizeSettledPositions,
} from "../src/agent/settled-positions.ts";
import { buildAgentContext } from "../src/agent/context-builder.ts";

// Wholly synthetic markets and accounts; nothing here contacts an exchange.
const fill = (marketSlug, enteredAt, overrides = {}) => ({
  marketSlug,
  side: "YES",
  action: "BUY",
  quantity: new Decimal(10),
  averagePrice: new Decimal("0.40"),
  fees: new Decimal("0.10"),
  enteredAt: new Date(enteredAt),
  ...overrides,
});
const resolution = (marketSlug, realizedPnl, resolvedAt) => ({
  kind: "RESOLUTION",
  marketSlug,
  realizedPnl: new Decimal(realizedPnl),
  resolvedAt: new Date(resolvedAt),
});

// Settlements join only to the recorded BUY fills that opened them.
{
  const positions = summarizeSettledPositions(
    [
      resolution("alpha", "1", "2040-01-02T00:00:00Z"),
      resolution("alpha", "11.9", "2040-01-03T00:00:00Z"),
      resolution("bravo", "0", "2040-01-03T00:00:00Z"),
      resolution("charlie", "-4", "2040-01-03T00:00:00Z"),
      resolution("delta", "-4", "2040-01-03T00:00:00Z"),
      resolution("echo", "-4", "2040-01-03T00:00:00Z"),
      resolution("foxtrot", "-4.1", "2040-01-04T00:00:00Z"),
    ],
    [
      fill("alpha", "2040-01-01T13:00:00Z"),
      fill("alpha", "2040-01-01T14:00:00Z", {
        quantity: new Decimal(30),
        averagePrice: new Decimal("0.20"),
        estimatedProbability: new Decimal("0.6"),
        authorizationProbability: new Decimal("0.55"),
      }),
      fill("bravo", "2040-01-01T13:00:00Z", { side: "NO" }),
      fill("charlie", "2040-01-01T13:00:00Z"),
      fill("charlie", "2040-01-01T15:00:00Z", { action: "SELL" }),
      fill("delta", "2040-01-01T13:00:00Z"),
      fill("delta", "2040-01-01T15:00:00Z", { side: "NO" }),
      fill("echo", "2040-01-05T13:00:00Z"),
      fill("foxtrot", "2040-01-01T13:00:00Z"),
    ],
  );
  assert.deepEqual(
    positions.map((position) => position.marketSlug),
    ["foxtrot", "alpha", "bravo"],
    "newest settlement first; SELL, two-sided and later fills are omitted",
  );
  const alpha = positions.find((position) => position.marketSlug === "alpha");
  assert.equal(alpha.outcome, "WON");
  assert.equal(alpha.realizedPnl.toString(), "11.9", "latest settlement wins");
  assert.equal(alpha.quantity.toString(), "40");
  assert.equal(alpha.averageEntryPrice.toString(), "0.25");
  assert.equal(alpha.costUsd.toString(), "10.2", "notional plus fees");
  assert.equal(alpha.firstEnteredAt.toISOString(), "2040-01-01T13:00:00.000Z");
  assert.equal(alpha.estimatedProbability.toString(), "0.6");
  assert.equal(alpha.authorizationProbability.toString(), "0.55");
  const bravo = positions.find((position) => position.marketSlug === "bravo");
  assert.equal(bravo.side, "NO");
  assert.equal(bravo.outcome, "UNKNOWN", "zero realized PnL is not a result");
  assert.equal(bravo.estimatedProbability, undefined);
  assert.equal(
    positions.find((position) => position.marketSlug === "foxtrot").outcome,
    "LOST",
  );
}

// Fills come from the history index; each entry's own report supplies the
// probability, and unreadable or out-of-root reports only drop probabilities.
{
  const root = await mkdtemp(join(tmpdir(), "marketcaster-settled-"));
  try {
    const scope = "account-fixture";
    const execution = (marketSlug, filledQuantity) => ({
      marketSlug,
      side: "YES",
      action: "BUY",
      quantity: "10",
      canonicalLimitPrice: "0.5",
      executionPolicy: "IOC",
      status: "FILLED",
      filledQuantity,
      averageFillPrice: "0.45",
      fees: "0.05",
      finalState: "FILLED",
    });
    const entry = (cycleId, completedAt, reportPath, executions) => ({
      runId: "run-1",
      cycleId,
      reportPath,
      mode: "live",
      status: "SUCCESS",
      outcome: "FILLED",
      completedAt,
      account: {},
      performanceChange: {},
      exchangeObservedActivity: { after: {}, newlyObserved: {} },
      agentState: {},
      agentStateChanges: {},
      currentCycleExecutions: executions,
    });
    const reportPath = "runs/run-1/cycle-a/cycle-report.json";
    await mkdir(join(root, "runs/run-1/cycle-a"), { recursive: true });
    await writeFile(
      join(root, reportPath),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        cycleId: "cycle-a",
        accountScope: scope,
        recordedAt: "2040-01-01T00:00:00.000Z",
        kind: "cycle-report",
        data: {
          risk: {
            accepted: [
              {
                marketSlug: "alpha",
                side: "YES",
                action: "BUY",
                estimatedProbability: "0.7",
                riskAdjustedProbability: "0.65",
              },
            ],
          },
        },
      }),
    );
    await mkdir(join(root, "history/polymarket-us", scope), {
      recursive: true,
    });
    await writeFile(
      join(root, "history/polymarket-us", scope, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        exchangeId: "polymarket-us",
        accountScope: scope,
        updatedAt: "2040-01-02T00:00:00.000Z",
        maximumEntries: 100,
        entries: [
          entry("cycle-b", "2040-01-02T00:00:00.000Z", "../outside.json", [
            execution("bravo", "3"),
            execution("charlie", "0"),
            { malformed: true },
          ]),
          // Points at another cycle's report, so it borrows no probability.
          entry("cycle-c", "2040-01-01T12:00:00.000Z", reportPath, [
            execution("alpha", "4"),
          ]),
          entry("cycle-a", "2040-01-01T00:00:00.000Z", reportPath, [
            execution("alpha", "10"),
          ]),
        ],
      }),
    );
    const fills = await loadEntryFills({
      rootDirectory: root,
      exchangeId: "polymarket-us",
      accountScope: scope,
    });
    assert.deepEqual(
      fills.map((item) => item.marketSlug),
      ["bravo", "alpha", "alpha"],
      "unfilled and malformed executions are skipped",
    );
    assert.equal(fills[0].estimatedProbability, undefined);
    assert.equal(fills[1].estimatedProbability, undefined);
    assert.equal(fills[2].estimatedProbability.toString(), "0.7");
    assert.equal(fills[2].authorizationProbability.toString(), "0.65");
    assert.equal(fills[2].enteredAt.toISOString(), "2040-01-01T00:00:00.000Z");
    assert.deepEqual(
      await loadEntryFills({
        rootDirectory: root,
        exchangeId: "kalshi",
        accountScope: scope,
      }),
      [],
      "a missing history index is no history",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The critical-learning policy receives settled positions, and the engine
// bounds the scorecard it returns.
{
  const zero = new Decimal(0);
  const input = (criticalLearningPolicy) => ({
    observedAt: new Date("2040-01-05T00:00:00Z"),
    exchangeId: "polymarket-us",
    exchangeName: "Fixture",
    account: {
      observedAt: new Date("2040-01-05T00:00:00Z"),
      currentBalance: new Decimal(100),
      buyingPower: new Decimal(100),
      assetNotional: zero,
      assetAvailable: zero,
      openOrderValue: zero,
      unsettledFunds: zero,
      marginRequirement: zero,
      positions: [],
      openOrders: [],
      recentActivities: [],
    },
    marketCatalog: { count: 0, categoryCounts: {} },
    preloadedMarkets: [],
    riskConstraints: {
      maximumPositionCostBasisFraction: new Decimal("0.5"),
      maximumCycleSpendFraction: new Decimal("0.5"),
      maximumExecutionSpread: new Decimal("0.1"),
      kellyFraction: new Decimal("0.5"),
      uncertaintyBoundWeight: new Decimal("0.25"),
      duplicateWindowMinutes: 30,
      minimumIndependentSources: 1,
      allowNakedShorts: false,
      emergencyExitEnabled: false,
      managedRestingBuyOrders: { enabled: false, maximumLifetimeMinutes: 15 },
    },
    criticalLearningPolicy,
    settledPositions: [{ marketSlug: "alpha" }],
  });
  const learning = (scorecard) => ({
    advisoryOnly: true,
    realizedOutcomeSampleSize: 0,
    profitableMarketSlugs: [],
    losingMarketSlugs: [],
    winningPatternAssessment: "none",
    losingPatternAssessment: "none",
    positionManagementReminders: [],
    ...(scorecard === undefined ? {} : { scorecard }),
  });
  const scorecard = {
    basis: "Synthetic settlements.",
    settledPositions: 1,
    groups: [
      {
        dimension: "side",
        group: "YES",
        settled: 1,
        won: 1,
        lost: 0,
        unknown: 0,
        costUsd: "10.2",
        realizedPnlUsd: "-1.5",
      },
    ],
    calibration: [
      {
        band: "50-75%",
        settled: 1,
        won: 1,
        meanProbability: "0.6",
        meanEntryPrice: "0.25",
      },
    ],
  };
  let received;
  const context = buildAgentContext(
    input((performance, previousCycle, settledPositions) => {
      received = settledPositions;
      return learning(scorecard);
    }),
  );
  assert.deepEqual(received, [{ marketSlug: "alpha" }]);
  assert.deepEqual(context.criticalLearning.scorecard, scorecard);
  assert.throws(
    () =>
      buildAgentContext(
        input(() => learning({ ...scorecard, basis: "x".repeat(401) })),
      ),
    /settlement scorecard is invalid/u,
  );
  assert.throws(
    () =>
      buildAgentContext(
        input(() =>
          learning({
            ...scorecard,
            groups: [{ ...scorecard.groups[0], won: 1.5 }],
          }),
        ),
      ),
    /settlement scorecard is invalid/u,
  );
  assert.equal(
    buildAgentContext(input(() => learning())).criticalLearning.scorecard,
    undefined,
    "a policy may omit the scorecard",
  );
}

globalThis.console.log(JSON.stringify({ status: "PASS" }));
