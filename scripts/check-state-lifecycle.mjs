import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { FileAgentState } from "../src/agent/agent-state.ts";
import { mapFill, mapResolution } from "../src/exchanges/kalshi/mappers.ts";
import {
  KalshiFillSchema,
  KalshiSettlementSchema,
} from "../src/exchanges/kalshi/schemas.ts";
import { buildCycleReport } from "../src/reporting/build-report.ts";
import { persistCrossCycleHistory } from "../src/reporting/cross-cycle-history.ts";

// Synthetic, offline fixtures only. Run with node --import tsx.
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "marketcaster-state-lifecycle-"),
);
const timestamp = "2026-01-02T00:00:00.000Z";
const now = () => new Date(timestamp);
const decimal = (value = 0) => new Decimal(value);

try {
  const path = join(temporaryDirectory, "state.json");
  const legacyBelief = {
    id: "00000000-0000-4000-8000-000000000001",
    type: "EVENT_ANALYSIS",
    confidence: 50,
    content: "Synthetic initial observation.",
    marketSlugs: ["fixture-market"],
    evidenceUpdatedAt: timestamp,
    invalidationConditions: ["Synthetic source corrected."],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const legacyPlan = {
    content: "Review synthetic observation.",
    marketSlugs: ["fixture-market"],
    updatedAt: timestamp,
  };
  const legacy = {
    version: 2,
    beliefs: [legacyBelief],
    nextCyclePlan: legacyPlan,
    longTermPlan: null,
  };
  const legacySource = JSON.stringify(legacy);
  await writeFile(path, legacySource);
  const state = new FileAgentState({ filePath: path, now });
  const loaded = await state.load();
  assert.deepEqual(loaded.beliefs, [legacyBelief]);
  assert.deepEqual(loaded.nextCyclePlan, legacyPlan);
  assert.equal(
    await readFile(path, "utf8"),
    legacySource,
    "Old v2 state should not be rewritten merely to add defaults",
  );

  const references = {
    evidenceUrls: ["https://example.test/evidence"],
    basisMarketSlugs: ["fixture-market"],
  };
  await state.manage({
    action: "UPDATE_BELIEF",
    beliefId: legacyBelief.id,
    ...references,
    reviewAt: "2026-01-01T12:00:00-06:00",
  });
  await state.manage({
    action: "UPDATE_BELIEF",
    beliefId: legacyBelief.id,
    confidence: 51,
  });
  const reloaded = new FileAgentState({ filePath: path, now });
  const persisted = (await reloaded.load()).beliefs[0];
  assert.deepEqual(persisted.evidenceUrls, references.evidenceUrls);
  assert.deepEqual(persisted.basisMarketSlugs, references.basisMarketSlugs);
  assert.equal(
    persisted.reviewAt,
    "2026-01-01T18:00:00.000Z",
    "Overdue review alone does not remove a belief",
  );
  await state.manage({
    action: "SET_NEXT_CYCLE_PLAN",
    content: legacyPlan.content,
    marketSlugs: legacyPlan.marketSlugs,
    ...references,
    reviewAt: timestamp,
  });
  assert.deepEqual(
    (await reloaded.load()).nextCyclePlan.evidenceUrls,
    references.evidenceUrls,
  );
  assert.equal((await reloaded.load()).nextCyclePlan.reviewAt, timestamp);

  const correction = await state.manage({
    action: "ADD_BELIEF",
    type: "EVENT_ANALYSIS",
    confidence: 50,
    content: "Synthetic corrected observation.",
    marketSlugs: ["fixture-market"],
    evidenceUpdatedAt: timestamp,
    invalidationConditions: [],
    ...references,
    supersedesBeliefId: legacyBelief.id,
    expiresAt: "2026-01-03T00:00:00Z",
  });
  assert.deepEqual(
    (await reloaded.load()).beliefs.map((belief) => belief.id),
    [correction.mutatedBeliefId],
  );
  assert.equal(
    (await state.manage({ action: "LIST" })).beliefs.length,
    2,
    "LIST retains superseded audit history",
  );
  const beforeInvalid = await readFile(path, "utf8");
  await assert.rejects(
    state.manage({
      action: "UPDATE_BELIEF",
      beliefId: legacyBelief.id,
      supersedesBeliefId: correction.mutatedBeliefId,
    }),
    /cycle/u,
  );
  assert.equal(
    await readFile(path, "utf8"),
    beforeInvalid,
    "Cyclic supersession must fail atomically",
  );
  await state.manage({
    action: "UPDATE_BELIEF",
    beliefId: correction.mutatedBeliefId,
    expiresAt: timestamp,
  });
  assert.equal(
    (await reloaded.load()).beliefs.length,
    0,
    "Expiry applies at its exact boundary",
  );
  assert.equal((await reloaded.load()).inactiveBeliefCount, 2);
  await state.manage({
    action: "UPDATE_BELIEF",
    beliefId: correction.mutatedBeliefId,
    expiresAt: null,
  });
  assert.equal(
    (await reloaded.load()).beliefs.length,
    1,
    "Explicit null clears expiry",
  );
  await state.manage({
    action: "UPDATE_BELIEF",
    beliefId: correction.mutatedBeliefId,
    status: "INVALIDATED",
  });
  assert.equal((await reloaded.load()).beliefs.length, 0);
  await state.manage({
    action: "DELETE_BELIEF",
    beliefId: correction.mutatedBeliefId,
  });
  assert.equal(
    (await reloaded.load()).beliefs.length,
    0,
    "Deleting a correction does not reactivate its predecessor",
  );

  const fill = mapFill(
    KalshiFillSchema.parse({
      fill_id: "fixture-fill",
      order_id: "fixture-order",
      ticker: "fixture-market",
      outcome_side: "yes",
      book_side: "bid",
      side: "yes",
      action: "buy",
      count_fp: "2",
      yes_price_dollars: "0.4",
      no_price_dollars: "0.6",
      is_taker: true,
      fee_cost: "0.01",
      created_time: timestamp,
    }),
  );
  assert.equal(fill.orderId, "fixture-order");
  assert.equal(fill.fillId, "fixture-fill");
  assert.equal(
    fill.realizedPnl,
    undefined,
    "A fill without exchange-reported realized PnL is not a known zero outcome",
  );
  const settlement = mapResolution(
    KalshiSettlementSchema.parse({
      ticker: "fixture-resolved-market",
      yes_count_fp: "2",
      no_count_fp: "0",
      yes_total_cost_dollars: "0.8",
      no_total_cost_dollars: "0",
      revenue: 200,
      fee_cost: "0.01",
      settled_time: timestamp,
    }),
  );
  assert.equal(settlement.payoutAmount.toFixed(), "2");
  assert.equal(
    settlement.payoutState,
    "UNKNOWN",
    "Resolution revenue alone does not prove paid cash",
  );
  const knownFlat = {
    ...fill,
    tradeId: "fixture-flat",
    fillId: "fixture-flat",
    orderId: null,
    realizedPnl: decimal(0),
  };
  const unmatched = {
    ...fill,
    tradeId: "fixture-unmatched",
    fillId: null,
    orderId: null,
  };
  const position = {
    marketId: { exchange: "kalshi", value: "fixture-market" },
    marketSlug: "fixture-market",
    side: "YES",
    quantity: decimal(2),
    availableQuantity: decimal(2),
    costBasis: decimal("0.8"),
    realizedPnl: decimal(0),
    expired: true,
  };
  const account = {
    observedAt: now(),
    currentBalance: decimal(10),
    buyingPower: decimal(10),
    assetNotional: decimal(0),
    assetAvailable: decimal(0),
    openOrderValue: decimal(0),
    unsettledFunds: decimal(0),
    marginRequirement: decimal(0),
    positions: [position],
    openOrders: [],
    recentActivities: [fill, knownFlat, unmatched, settlement],
  };
  const valuation = {
    exchangeReportedValue: decimal(10),
    arenaAccountValue: decimal(10),
    riskEquity: decimal(10),
    spendableCapital: decimal(10),
    positions: [],
    warnings: [],
  };
  const attempt = {
    intentId: "fixture-cycle:1",
    validated: {
      order: {
        marketSlug: "fixture-market",
        side: "YES",
        action: "BUY",
        quantity: decimal(2),
        canonicalLimitPrice: decimal("0.4"),
        executionPolicy: "IOC",
      },
    },
    result: {
      status: "FILLED",
      orderId: "fixture-order",
      filledQuantity: decimal(2),
      fees: decimal("0.01"),
      finalState: "FILLED",
    },
  };
  const input = {
    runId: "fixture-run",
    cycleId: "fixture-cycle",
    mode: "observe",
    exchangeId: "kalshi",
    startedAt: now(),
    completedAt: now(),
    accountBefore: { ...account, recentActivities: [] },
    accountAfter: account,
    valuationBefore: valuation,
    valuationAfter: valuation,
    agentStateAfter: await state.load(),
    marketDiscovery: {
      catalogued: 0,
      surfaced: 0,
      inspected: 0,
      preloadedHeld: 0,
      preloadedOpportunities: 0,
      categories: {},
    },
    provider: "synthetic",
    model: "synthetic",
    marketDiscoveryCount: 0,
    webSearchCount: 0,
    evidenceSourceReadCount: 0,
    successfulEvidenceSourceReadCount: 0,
    marketDetailCount: 0,
    marketAnalysisCount: 0,
    tradePreviewCount: 0,
    noteOperationCount: 0,
    stateOperationCount: 0,
    candidateFunnel: { counts: {}, passResearchGate: {}, candidates: [] },
    decision: {
      cycleSummary: "Synthetic offline accounting check.",
      proposals: [],
    },
    validation: { accepted: [], rejected: [], committedCycleSpend: decimal(0) },
    execution: { attempts: [attempt], stoppedForAmbiguity: false },
  };
  const report = buildCycleReport(input);
  assert.equal(report.exchangeObservedActivity.after.realizedPnlTradeCount, 1);
  assert.equal(
    report.exchangeObservedActivity.after.closedTradeCount,
    1,
    "Only authoritative known PnL participates in the legacy closed-trade alias",
  );
  assert.equal(report.accountAfter.performance.flatOutcomeCount, 1);
  assert.equal(
    report.exchangeObservedActivity.after.settlements[0].payoutState,
    "UNKNOWN",
  );
  assert.equal(report.accountAfter.positions[0].lifecycleState, "EXPIRED");
  assert.equal(report.accountAfter.positions[0].payoutState, "UNKNOWN");
  assert.deepEqual(report.exchangeObservedActivity.exactOrderMatches, [
    {
      intentId: "fixture-cycle:1",
      orderId: "fixture-order",
      tradeIds: ["fixture-fill"],
      fillIds: ["fixture-fill"],
    },
  ]);
  const ambiguous = buildCycleReport({
    ...input,
    execution: {
      attempts: [attempt, { ...attempt, intentId: "fixture-cycle:2" }],
      stoppedForAmbiguity: false,
    },
  });
  assert.deepEqual(
    ambiguous.exchangeObservedActivity.exactOrderMatches,
    [],
    "Ambiguous intent ownership cannot be joined",
  );
  const history = await persistCrossCycleHistory({
    rootDirectory: temporaryDirectory,
    accountScope: "fixture-account",
    report,
  });
  assert.equal(history.persisted, true);
  const index = JSON.parse(
    await readFile(
      join(
        temporaryDirectory,
        "history",
        "kalshi",
        "fixture-account",
        "index.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    index.entries[0].exchangeObservedActivity.exactOrderMatches,
    report.exchangeObservedActivity.exactOrderMatches,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
