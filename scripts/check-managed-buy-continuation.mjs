import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { executeValidatedOrders } from "../src/execution/executor.ts";
import { buildCycleReport } from "../src/reporting/build-report.ts";

// Synthetic fixtures only. No real adapter, credentials, files, or network.
globalThis.fetch = () => {
  throw new Error("Network is forbidden in this test");
};
const D = (value = 0) => new Decimal(value);
const now = new Date("2030-01-01T12:00:00Z");
const expires = new Date("2030-01-01T12:05:00Z");
const active = (order) => ["OPEN", "PARTIALLY_FILLED"].includes(order.state);

function candidate(slug, side = "YES", target = true) {
  const market = {
    id: { exchange: "polymarket-us", value: slug },
    slug,
    active: true,
    closed: false,
    archived: false,
    priceTick: D("0.01"),
    minimumTradeQuantity: D(1),
  };
  const price = D(side === "YES" ? "0.4" : "0.6");
  const order = {
    marketId: market.id,
    marketSlug: slug,
    action: "BUY",
    side,
    quantity: D(10),
    canonicalLimitPrice: price,
    executionPolicy: "GTD",
    restUntil: expires,
  };
  const proposal = {
    marketSlug: slug,
    action: "BUY",
    side,
    estimatedProbability: D("0.95"),
    probabilityLowerBound: D("0.95"),
    probabilityUpperBound: D("0.98"),
    maximumEntryPrice: price,
    maximumRiskUsd: D(10),
    confidence: "HIGH",
    thesis: "Synthetic",
    settlementVerification: "Synthetic",
    invalidationConditions: "Synthetic",
    evidence: [],
    ...(target
      ? {
          portfolioTargetPlan: {
            targetCostBasisUsd: D(10),
            baselineCostBasisUsd: D(0),
            baselineQuantity: D(0),
            baselineAvailableQuantity: D(0),
            baselineOppositeCostBasisUsd: D(0),
            baselineOppositeQuantity: D(0),
          },
        }
      : {}),
  };
  return {
    market,
    order,
    proposal,
    authorizationProbability: D("0.95"),
    conservativeFeeReserve: D("0.2"),
    maximumExecutionSpend: price.mul(10).plus("0.2"),
    minimumExecutionSpend: price.plus("0.02"),
    estimatedFees: D("0.2"),
    expectedSpend: price.mul(10),
    riskBudget: D(10),
  };
}

async function scenario(options = {}) {
  const candidates = options.candidates ?? [
    candidate("synthetic-a"),
    candidate("synthetic-b", "NO"),
    candidate("synthetic-c"),
  ];
  const sent = [];
  const orders = new Map();
  const reads = new Map();
  const start = D(options.start ?? 100);
  let raced = false;
  let canceled = 0;
  function changeB(quantity, state = "PARTIALLY_FILLED") {
    const b = orders.get("order-2");
    orders.set(b.id, {
      ...b,
      filledQuantity: D(quantity),
      remainingQuantity: active({ state }) ? b.quantity.minus(quantity) : D(0),
      fees: D(quantity).mul("0.01"),
      state,
    });
  }
  function account() {
    let currentBalance = start;
    let buyingPower = start;
    let marginRequirement = D(0);
    let locked = D(0);
    const positions = [];
    for (const order of orders.values()) {
      const principal = order.filledQuantity.mul(
        order.id === "order-2" && options.roundedAverage
          ? (options.actualPrice ?? "0.574")
          : order.averageFillPrice,
      );
      const cost = principal.plus(order.fees);
      buyingPower = buyingPower.minus(cost);
      currentBalance = currentBalance
        .minus(cost)
        .plus(order.side === "NO" ? order.filledQuantity : 0);
      if (order.side === "NO")
        marginRequirement = marginRequirement.plus(order.filledQuantity);
      if (order.filledQuantity.gt(0))
        positions.push({
          marketId: order.marketId,
          marketSlug: order.marketSlug,
          side: order.side,
          quantity: order.filledQuantity,
          availableQuantity: order.filledQuantity,
          costBasis: principal,
          realizedPnl: D(0),
          expired: false,
        });
      if (options.exchangeLocks && active(order))
        locked = locked
          .plus(order.remainingQuantity.mul(order.canonicalPrice))
          .plus("0.1");
    }
    const openOrders = [...orders.values()].filter(active);
    if (sent.length >= 2 && options.unknownOrder)
      openOrders.push({ ...orders.get("order-2"), id: "external-order" });
    if (sent.length >= 2 && options.externalCash)
      currentBalance = currentBalance.minus(1);
    if (sent.length >= 2 && options.externalPosition)
      positions.push({ ...positions[0], marketSlug: "external-market" });
    return {
      observedAt: now,
      currentBalance,
      buyingPower:
        sent.length >= 2 && options.noBuyingPower
          ? D("0.1")
          : buyingPower.minus(locked),
      assetNotional: D(0),
      assetAvailable: D(0),
      openOrderValue: locked,
      unsettledFunds: D(0),
      marginRequirement,
      positions,
      openOrders,
      recentActivities: [],
    };
  }
  const snapshot = account();
  const exchange = {
    id: "polymarket-us",
    memoryScope: "synthetic",
    async getOpenOrders() {
      return account().openOrders;
    },
    async getPositions() {
      return account().positions;
    },
    async getActivities() {
      return { items: [], eof: true };
    },
    async getAccountSnapshot() {
      return account();
    },
    async getMarketBySlug(slug) {
      return candidates.find((entry) => entry.market.slug === slug).market;
    },
    async getBbo() {
      return {
        yes: { bid: D("0.39"), ask: D("0.4") },
        no: { bid: D("0.59"), ask: D("0.6") },
      };
    },
    async getOrderBook() {
      return {
        yesBids: [{ price: D("0.4"), quantity: D(100) }],
        yesAsks: [{ price: D("0.4"), quantity: D(100) }],
      };
    },
    async previewImmediateOrder(order) {
      if (options.race === "after-check" && sent.length === 2 && !raced) {
        raced = true;
        changeB(10, "FILLED");
      }
      return {
        accepted: true,
        estimatedFees: D("0.2"),
        estimatedPrincipal: order.quantity.mul(order.canonicalLimitPrice),
        warnings: [],
        rejectionReasons: [],
      };
    },
    async placeImmediateOrder(order) {
      sent.push(order.marketSlug);
      const working =
        (sent.length === 1 && options.firstWorking) ||
        (sent.length === 2 &&
          options.bStatus !== "FILLED" &&
          options.bStatus !== "PARTIAL") ||
        (sent.length === 3 && options.cWorking);
      const filled = working
        ? D(options.bFilled ?? 5)
        : options.bStatus === "PARTIAL" && sent.length === 2
          ? D(5)
          : order.quantity;
      const state = working
        ? "PARTIALLY_FILLED"
        : filled.eq(order.quantity)
          ? "FILLED"
          : "CANCELED";
      const stored = {
        id: `order-${sent.length}`,
        ...order,
        canonicalPrice: order.canonicalLimitPrice,
        state,
        filledQuantity: filled,
        remainingQuantity: working ? order.quantity.minus(filled) : D(0),
        averageFillPrice:
          sent.length === 2 && options.roundedAverage
            ? D("0.57")
            : order.canonicalLimitPrice,
        fees: filled.mul("0.01"),
      };
      orders.set(stored.id, stored);
      return {
        orderId: stored.id,
        status:
          options.ambiguous && sent.length === 2
            ? "AMBIGUOUS"
            : working
              ? "WORKING"
              : filled.eq(order.quantity)
                ? "FILLED"
                : "PARTIAL",
        filledQuantity: filled,
        remainingQuantity: stored.remainingQuantity,
        averageFillPrice: stored.averageFillPrice,
        fees: stored.fees,
        finalState: state,
      };
    },
    async getOrder(id) {
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      if (id === "order-2" && count >= 2 && options.continuousRace)
        changeB(orders.get(id).filledQuantity.plus("0.1"));
      if (options.ambiguous && id === "order-2")
        return { ...orders.get(id), marketSlug: "mismatched" };
      if (id === "order-2" && count >= 2 && options.mismatch)
        return { ...orders.get(id), quantity: D(99) };
      if (id === "order-2" && count >= 2 && options.regress)
        return {
          ...orders.get(id),
          filledQuantity: D(1),
          remainingQuantity: D(9),
          fees: D("0.01"),
        };
      if (id === "order-2" && count >= 2 && options.missingFees)
        return { ...orders.get(id), fees: undefined };
      if (
        id === "order-2" &&
        count >= 2 &&
        !raced &&
        options.race &&
        options.race !== "after-check"
      ) {
        raced = true;
        const old = orders.get(id);
        changeB(
          options.race === "terminal" ? 10 : 7,
          options.race === "terminal" ? "FILLED" : "PARTIALLY_FILLED",
        );
        return options.race === "during-read" ? old : orders.get(id);
      }
      return orders.get(id);
    },
    async cancelOrder() {
      canceled += 1;
      assert.fail("Continuation must not cancel managed orders");
    },
  };
  const execution = await executeValidatedOrders({
    exchange,
    mode: options.mode ?? "live",
    snapshot,
    riskEquity: D(100),
    validated: candidates,
    now: () => now,
    managedRestingBuyOrders: { enabled: true, maximumLifetimeMinutes: 5 },
    policy: {
      allowPositionReductions: false,
      maximumCycleSpendFraction: D(options.cycleFraction ?? "0.5"),
      duplicateWindowMinutes: 1,
      maximumExecutionSpread: D("0.1"),
      emergencyExitEnabled: false,
    },
  });
  return {
    execution,
    sent,
    orders,
    reads,
    canceled,
    candidates,
    snapshot,
    after: account(),
  };
}

const complete = await scenario();
assert.deepEqual(complete.sent, ["synthetic-a", "synthetic-b", "synthetic-c"]);
assert.deepEqual(
  complete.execution.attempts.map((attempt) => attempt.result.status),
  ["FILLED", "WORKING", "FILLED"],
);
assert.equal(complete.execution.completion.processedAll, true);
assert.equal(complete.execution.stoppedForAmbiguity, false);
assert.equal(complete.orders.get("order-2").remainingQuantity.toFixed(), "5");
assert.equal(complete.canceled, 0);
assert.equal(
  (await scenario({ roundedAverage: true })).sent.length,
  3,
  "Rounded order averages must not replace actual position cost",
);
assert.equal(
  (await scenario({ roundedAverage: true, actualPrice: "0.55" })).sent.length,
  2,
  "Cost inconsistent with reported price precision stops continuation",
);
assert.equal(
  (await scenario({ firstWorking: true })).sent.length,
  3,
  "Continuation also works when A remains working",
);
assert.equal(
  (await scenario({ bFilled: 0 })).sent.length,
  3,
  "A verified zero-fill working order retains its full reservation",
);

for (const race of ["before-read", "during-read", "terminal", "after-check"]) {
  const run = await scenario({ race });
  assert.equal(
    run.sent.length,
    3,
    `${race}: a verified fill must not starve C`,
  );
  assert.equal(run.execution.stoppedForAmbiguity, false);
  assert.equal(run.orders.get("order-3").quantity.toFixed(), "10");
  if (race === "terminal")
    assert.equal(run.execution.attempts[1].result.status, "FILLED");
  if (race === "during-read")
    assert.ok(run.reads.get("order-2") >= 5, "Racing reads are retried");
}

const multi = await scenario({
  cWorking: true,
  candidates: [
    candidate("synthetic-a"),
    candidate("synthetic-b", "NO"),
    candidate("synthetic-c"),
    candidate("synthetic-d", "NO"),
  ],
});
assert.equal(multi.sent.length, 4, "Multiple known working BUYs may coexist");
assert.equal(multi.execution.managedOrderChecks.length, 2);

for (const bStatus of ["FILLED", "PARTIAL"])
  assert.equal((await scenario({ bStatus })).sent.length, 3);
assert.equal((await scenario({ mode: "observe" })).sent.length, 0);

const reserved = await scenario({ start: 13, bFilled: 1 });
assert.equal(
  reserved.sent.length,
  2,
  "Pending NO quantity must remain reserved even if the venue omits the lock",
);
assert.match(reserved.execution.attempts[2].skippedReason, /buying power/u);
assert.equal(
  (await scenario({ start: 20, exchangeLocks: true })).sent.length,
  3,
  "Do not subtract an exchange reservation twice",
);
assert.equal((await scenario({ noBuyingPower: true })).sent.length, 2);
const capped = await scenario({ cycleFraction: "0.12" });
assert.equal(capped.sent.length, 2);
assert.match(capped.execution.attempts[2].skippedReason, /cycle spend/u);

for (const option of [
  "unknownOrder",
  "externalCash",
  "externalPosition",
  "mismatch",
  "missingFees",
  "ambiguous",
  "regress",
  "continuousRace",
]) {
  const run = await scenario({
    [option]: true,
    candidates: [
      candidate("synthetic-a"),
      candidate("synthetic-b", "NO"),
      candidate("synthetic-c"),
      candidate("synthetic-d"),
    ],
  });
  assert.equal(run.sent.length, 2, `${option}: must stop before C`);
  assert.equal(run.execution.stoppedForAmbiguity, true, option);
  assert.equal(run.execution.completion.processedAll, false);
  assert.ok(
    run.execution.completion.unattempted.some(
      (entry) => entry.marketSlug === "synthetic-d",
    ),
  );
}

const conflict = await scenario({
  candidates: [
    candidate("synthetic-a"),
    candidate("synthetic-b", "NO"),
    candidate("synthetic-b", "NO"),
    candidate("synthetic-d"),
  ],
});
assert.deepEqual(conflict.sent, ["synthetic-a", "synthetic-b", "synthetic-d"]);
assert.match(
  conflict.execution.attempts[2].skippedReason,
  /independent market/u,
);
const legacy = await scenario({
  candidates: [
    candidate("synthetic-a", "YES", false),
    candidate("synthetic-b", "NO", false),
    candidate("synthetic-c", "YES", false),
  ],
});
assert.equal(
  legacy.sent.length,
  3,
  "Legacy proposals also refresh buying power",
);

function report(run) {
  const valuation = {
    exchangeReportedValue: D(100),
    arenaAccountValue: D(100),
    riskEquity: D(100),
    spendableCapital: D(100),
    positions: [],
    warnings: [],
  };
  return buildCycleReport({
    runId: "synthetic",
    cycleId: "synthetic",
    mode: "live",
    exchangeId: "polymarket-us",
    startedAt: now,
    completedAt: now,
    accountBefore: run.snapshot,
    accountAfter: run.after,
    valuationBefore: valuation,
    valuationAfter: valuation,
    marketDiscovery: {
      catalogued: 3,
      surfaced: 3,
      inspected: 3,
      preloadedHeld: 0,
      preloadedOpportunities: 3,
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
      cycleSummary: "Synthetic",
      proposals: run.candidates.map((entry) => entry.proposal),
    },
    validation: {
      accepted: run.candidates,
      rejected: [],
      committedCycleSpend: D(0),
    },
    execution: run.execution,
  });
}
const successReport = report(complete);
assert.equal(successReport.outcome, "ORDER_WORKING");
assert.match(
  successReport.completionReason,
  /All accepted proposals were processed/u,
);
assert.equal(successReport.currentCycleExecutions.length, 3);
const stopped = await scenario({ unknownOrder: true });
const stoppedReport = report(stopped);
assert.equal(stoppedReport.outcome, "AMBIGUOUS");
assert.match(stoppedReport.completionReason, /Execution stopped/u);
assert.equal(stoppedReport.executionCompletion.processedAll, false);
