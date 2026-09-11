import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { retainPositionReductionRequests } from "../dist/src/agent/decision-repair.js";
import { RepositoryConfigSchema } from "../dist/src/config/schema.js";
import { loadRuntimeConfiguration } from "../dist/src/config/runtime-overrides.js";
import { executeValidatedOrders } from "../dist/src/execution/executor.js";
import { canonicalOrderToPolymarket } from "../dist/src/exchanges/polymarket-us/side-conversion.js";
import { reconcilePortfolioTargets } from "../dist/src/portfolio/target-reconciliation.js";
import { buildCycleReport } from "../dist/src/reporting/build-report.js";
import { buildShadowLedgerCandidates } from "../dist/src/reporting/shadow-ledger.js";
import { validateProposals } from "../dist/src/risk/validate.js";

// Every exchange method below is an in-memory stub. No adapter is instantiated.
const now = new Date("2026-01-01T12:00:00.000Z");
const D = (value) => new Decimal(value);
const code = "POSITION_REDUCTION_DISABLED";
const rawDefaults = JSON.parse(await readFile("config/default.json", "utf8"));
const defaults = RepositoryConfigSchema.parse(rawDefaults);
assert.equal(defaults.risk.allowPositionReductions, true);

function policy(overrides = {}) {
  return {
    ...defaults.risk,
    maximumPositionCostBasisFraction: D("0.5"),
    maximumCycleSpendFraction: D("0.5"),
    maximumExecutionSpread: D("0.1"),
    kellyFraction: D(1),
    minimumIndependentSources: 1,
    emergencyExitEnabled: false,
    ...overrides,
  };
}

function position(marketSlug, side, overrides = {}) {
  return {
    marketId: { exchange: "polymarket-us", value: marketSlug },
    marketSlug,
    side,
    quantity: D(20),
    availableQuantity: D(20),
    costBasis: D(10),
    realizedPnl: D(0),
    expired: false,
    ...overrides,
  };
}

function snapshot(positions = [], buyingPower = 100) {
  return {
    observedAt: now,
    currentBalance: D(buyingPower),
    buyingPower: D(buyingPower),
    assetNotional: D(0),
    assetAvailable: D(0),
    openOrderValue: D(0),
    unsettledFunds: D(0),
    marginRequirement: D(0),
    positions,
    openOrders: [],
    recentActivities: [],
  };
}

function valuation() {
  return {
    exchangeReportedValue: D(100),
    arenaAccountValue: D(100),
    riskEquity: D(100),
    spendableCapital: D(100),
    positions: [],
    warnings: [],
  };
}

function fixture(account, overrides = {}) {
  const calls = { placements: [], previews: 0, marketReads: 0 };
  const exchange = {
    id: "polymarket-us",
    async getMarketBySlug(slug) {
      calls.marketReads += 1;
      return {
        id: { exchange: "polymarket-us", value: slug },
        slug,
        title: `Synthetic ${slug}`,
        description: "Synthetic fixture.",
        settlementRules: "Resolves from the synthetic fixture.",
        active: true,
        closed: false,
        archived: false,
        minimumTradeQuantity: D(1),
        priceTick: D("0.01"),
      };
    },
    async getBbo(marketId) {
      const quote = { bid: D("0.49"), ask: D("0.51"), spread: D("0.02") };
      return { marketId, yes: quote, no: quote, observedAt: now };
    },
    async getOrderBook(marketId) {
      return {
        marketId,
        yesBids: [{ price: D("0.49"), quantity: D(1000) }],
        yesAsks: [{ price: D("0.51"), quantity: D(1000) }],
        observedAt: now,
      };
    },
    async createImmediateOrderFeeReserveEstimator() {
      return () => D(0);
    },
    async getOpenOrders() {
      return account.openOrders;
    },
    async getPositions() {
      return account.positions;
    },
    async getActivities() {
      return { items: [] };
    },
    async getAccountSnapshot() {
      return account;
    },
    async previewImmediateOrder() {
      calls.previews += 1;
      return {
        accepted: true,
        estimatedFees: D(0),
        warnings: [],
        rejectionReasons: [],
      };
    },
    async placeImmediateOrder(order) {
      calls.placements.push({ ...order, ...canonicalOrderToPolymarket(order) });
      return {
        status: "REJECTED",
        finalState: "REJECTED",
        filledQuantity: D(0),
        fees: D(0),
      };
    },
    ...overrides,
  };
  return { exchange, calls };
}

function proposal(marketSlug, side, action, overrides = {}) {
  const probability = D(action === "BUY" ? "0.9" : "0.1");
  return {
    marketSlug,
    side,
    action,
    estimatedProbability: probability,
    probabilityLowerBound: probability,
    probabilityUpperBound: probability,
    maximumEntryPrice: D("0.60"),
    minimumExitPrice: D("0.40"),
    maximumRiskUsd: D(20),
    confidence: "HIGH",
    thesis: "Synthetic contract valuation.",
    settlementVerification: "Synthetic settlement source.",
    invalidationConditions: "Synthetic fixture changes.",
    evidence: [
      {
        title: "Synthetic evidence",
        url: "https://example.com/synthetic",
        relevance: "Fixture evidence.",
      },
    ],
    ...overrides,
  };
}

function validate(proposals, account, risk, extra = {}) {
  return validateProposals({
    proposals,
    snapshot: account,
    valuation: valuation(),
    exchange: fixture(account).exchange,
    policy: risk,
    // Synthetic candidate-order allocation exercises the assessed budget without
    // relying on deployment policy or the reference strategy's empty plan.
    allocationPolicy: ({ cycleBudget, candidates }) => {
      let remaining = cycleBudget;
      return candidates.flatMap((candidate) => {
        const spend = Decimal.min(remaining, candidate.maximumSpend);
        if (spend.lt(candidate.minimumSpend)) return [];
        remaining = remaining.minus(spend);
        return [{ id: candidate.id, spend }];
      });
    },
    now,
    ...extra,
  });
}

function execute(validated, account, risk, exchange, extra = {}) {
  return executeValidatedOrders({
    mode: "live",
    snapshot: account,
    riskEquity: D(100),
    validated,
    policy: risk,
    exchange,
    now: () => now,
    ...extra,
  });
}

// The established JSON config path is the sole deployment control.
const directory = await mkdtemp(join(tmpdir(), "marketcaster-reductions-"));
try {
  const configPath = join(directory, "synthetic.json");
  for (const setting of [undefined, true, false]) {
    const config = JSON.parse(JSON.stringify(rawDefaults));
    delete config.risk.allowPositionReductions;
    if (setting !== undefined) config.risk.allowPositionReductions = setting;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const loaded = await loadRuntimeConfiguration({
      MARKETCASTER_CONFIG_PATH: configPath,
    });
    assert.equal(loaded.config.risk.allowPositionReductions, setting ?? true);
  }
  for (const setting of [null, "false", "true", 0, 1, [], {}]) {
    const config = JSON.parse(JSON.stringify(rawDefaults));
    config.risk.allowPositionReductions = setting;
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await assert.rejects(
      loadRuntimeConfiguration({ MARKETCASTER_CONFIG_PATH: configPath }),
      /allowPositionReductions/u,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

// Compatibility and the four canonical actions, including reversed NO sides.
for (const side of ["YES", "NO"]) {
  for (const action of ["BUY", "SELL"]) {
    const slug = `${side.toLowerCase()}-${action.toLowerCase()}`;
    const account = snapshot(action === "SELL" ? [position(slug, side)] : []);
    const requested = proposal(slug, side, action);
    const enabled = await validate([requested], account, policy());
    assert.equal(
      enabled.accepted.length,
      1,
      `${side} ${action}: ${JSON.stringify(enabled.rejected)}`,
    );
    const omittedPolicy = policy();
    delete omittedPolicy.allowPositionReductions;
    const omitted = await validate([requested], account, omittedPolicy);
    assert.deepEqual(
      omitted,
      enabled,
      "Omitted policy preserves sizing and risk results",
    );
    for (const compatiblePolicy of [policy(), omittedPolicy]) {
      const { exchange, calls } = fixture(account);
      const run = await execute(
        enabled.accepted,
        account,
        compatiblePolicy,
        exchange,
      );
      assert.equal(calls.placements.length, 1);
      assert.equal(run.stoppedForAmbiguity, false);
    }
    const disabledPolicy = policy({ allowPositionReductions: false });
    const disabled = await validate([requested], account, disabledPolicy);
    const { exchange, calls } = fixture(account);
    // Deliberately supply orders prevalidated under the permissive policy.
    const run = await execute(
      enabled.accepted,
      account,
      disabledPolicy,
      exchange,
    );
    const rawSide = canonicalOrderToPolymarket(
      enabled.accepted[0].order,
    ).orderSide;
    assert.equal(
      rawSide,
      (side === "YES") === (action === "BUY")
        ? "ORDER_SIDE_BUY"
        : "ORDER_SIDE_SELL",
    );
    if (action === "SELL") {
      assert.equal(disabled.accepted.length, 0);
      assert.equal(disabled.rejected[0].code, code);
      assert.equal(disabled.rejected[0].proposal, requested);
      assert.equal(disabled.committedCycleSpend.toFixed(), "0");
      assert.equal(run.attempts[0].skippedReason, code);
      assert.equal(run.attempts[0].result, undefined);
      assert.equal(calls.placements.length, 0);
      assert.equal(calls.previews, 0);
    } else {
      assert.deepEqual(disabled, enabled);
      assert.equal(calls.placements.length, 1);
      assert.equal(calls.placements[0].orderSide, rawSide);
    }
  }
}

const disabledPolicy = policy({ allowPositionReductions: false });
const heldAccount = snapshot([position("held", "YES")]);
const sell = proposal("held", "YES", "SELL");
const buy = proposal("new", "YES", "BUY");
const freshBlocked = await validate([sell], heldAccount, disabledPolicy, {
  requireFreshProbabilityMarketSlugs: new Set(["held"]),
  freshProbabilityByMarketSlug: new Map(),
});
assert.equal(freshBlocked.rejected[0].code, code);
assert.equal(freshBlocked.rejected[0].proposal, sell);

// A blocked exit contributes neither cash nor any released cost-basis headroom.
const noCash = snapshot(heldAccount.positions, 0);
const funded = await validate([buy, sell], noCash, policy());
assert.equal(
  funded.accepted.length,
  2,
  "Control: an enabled sale can finance a buy",
);
const unfunded = await validate([buy, sell], noCash, disabledPolicy);
assert.equal(unfunded.accepted.length, 0);
assert.deepEqual(
  unfunded.rejected.map((item) => item.code),
  ["BUYING_POWER", code],
);
assert.equal(unfunded.committedCycleSpend.toFixed(), "0");
const concentratedAccount = snapshot([
  position("held", "YES", { costBasis: D(50) }),
]);
const concentration = await validate(
  [sell, proposal("held", "YES", "BUY")],
  concentratedAccount,
  disabledPolicy,
);
assert.deepEqual(
  concentration.rejected.map((item) => item.code),
  [code, "CONCENTRATION"],
);
const cappedPolicy = policy({
  allowPositionReductions: false,
  maximumCycleSpendFraction: D("0.1"),
});
const buyOnly = await validate([buy], heldAccount, cappedPolicy);
const withBlockedSale = await validate([sell, buy], heldAccount, cappedPolicy);
assert.deepEqual(withBlockedSale.accepted, buyOnly.accepted);
assert.ok(withBlockedSale.committedCycleSpend.lte(10));
assert.equal(
  withBlockedSale.committedCycleSpend.toFixed(),
  buyOnly.committedCycleSpend.toFixed(),
);

// Requested trim/zero targets remain SELL intentions with explicit rejection in
// both human-facing cycle reports and forecast observations, including observe.
for (const side of ["YES", "NO"]) {
  for (const fraction of ["0.05", "0"]) {
    const account = snapshot([position("target", side)]);
    const target = {
      ...proposal("target", side, "SELL"),
      targetCostBasisFraction: D(fraction),
    };
    const reconciliation = reconcilePortfolioTargets({
      targets: [target],
      snapshot: account,
      riskEquity: D(100),
    });
    const result = await validate(
      reconciliation.proposals,
      account,
      disabledPolicy,
    );
    assert.equal(reconciliation.dispositions[0].kind, "PROPOSED");
    assert.equal(
      reconciliation.dispositions[0].reason,
      fraction === "0" ? "EXIT_TO_ZERO" : "TRIM_TO_TARGET",
    );
    assert.equal(
      reconciliation.proposals[0].maximumQuantity.toFixed(),
      fraction === "0" ? "20" : "10",
    );
    assert.equal(result.rejected[0].proposal, reconciliation.proposals[0]);
    assert.equal(result.rejected[0].code, code);
    const decision = {
      cycleSummary: "Synthetic reduction request.",
      portfolioTargets: [target],
      proposals: reconciliation.proposals,
      candidateDispositions: [],
    };
    const rewrittenHold = {
      ...decision,
      portfolioTargets: [{ ...target, targetCostBasisFraction: D("0.1") }],
      proposals: [],
    };
    const retained = retainPositionReductionRequests(
      rewrittenHold,
      decision,
      new Set(["target"]),
    );
    assert.equal(retained.portfolioTargets[0], target);
    const retainedReconciliation = reconcilePortfolioTargets({
      targets: retained.portfolioTargets,
      snapshot: account,
      riskEquity: D(100),
    });
    const retainedValidation = await validate(
      retainedReconciliation.proposals,
      account,
      disabledPolicy,
    );
    assert.equal(retainedReconciliation.dispositions[0].action, "SELL");
    assert.equal(retainedValidation.rejected[0].code, code);
    assert.equal(
      retainedValidation.rejected[0].proposal.portfolioTargetPlan.targetCostBasisUsd.toFixed(),
      fraction === "0" ? "0" : "5",
    );
    const observations = buildShadowLedgerCandidates({
      decision,
      reconciliation,
      validation: result,
    });
    assert.equal(observations[0].decisionAction, "SELL");
    assert.equal(observations[0].riskStatus, "REJECTED");
    assert.match(observations[0].riskReason, /POSITION_REDUCTION_DISABLED/u);
    for (const mode of ["live", "observe"]) {
      const report = buildCycleReport({
        runId: "synthetic",
        cycleId: "synthetic",
        mode,
        exchangeId: "polymarket-us",
        startedAt: now,
        completedAt: now,
        accountBefore: account,
        accountAfter: account,
        valuationBefore: valuation(),
        valuationAfter: valuation(),
        marketDiscovery: {
          catalogued: 1,
          surfaced: 1,
          inspected: 1,
          preloadedHeld: 1,
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
        decision,
        targetReconciliation: reconciliation,
        validation: result,
        execution: { attempts: [], stoppedForAmbiguity: false },
      });
      assert.equal(report.outcome, "ALL_REJECTED");
      assert.equal(
        report.agent.portfolioTargets[0].targetCostBasisFraction,
        fraction,
      );
      assert.equal(report.agent.targetReconciliations[0].action, "SELL");
      assert.equal(
        report.agent.targetReconciliations[0].targetCostBasisUsd,
        fraction === "0" ? "0" : "5",
      );
      assert.equal(report.risk.rejected[0].code, code);
      assert.deepEqual(report.currentCycleExecutions, []);
      assert.deepEqual(report.agent.candidateDispositions, []);
    }
  }
}

// Emergency spread/edge exceptions never override the reduction policy.
for (const side of ["YES", "NO"]) {
  const account = snapshot([position("emergency", side)]);
  const emergency = proposal("emergency", side, "SELL", {
    estimatedProbability: D("0.9"),
    probabilityLowerBound: D("0.9"),
    probabilityUpperBound: D("0.9"),
  });
  const emergencyPolicy = policy({
    emergencyExitEnabled: true,
    maximumExecutionSpread: D("0.001"),
  });
  const permitted = await validate([emergency], account, emergencyPolicy);
  assert.equal(
    permitted.accepted.length,
    1,
    "Control: existing emergency exception allows this exit",
  );
  const disabledEmergency = {
    ...emergencyPolicy,
    allowPositionReductions: false,
  };
  const blocked = await validate([emergency], account, disabledEmergency);
  assert.equal(blocked.rejected[0].code, code);
  const { exchange, calls } = fixture(account);
  const run = await execute(
    permitted.accepted,
    account,
    disabledEmergency,
    exchange,
  );
  assert.equal(run.attempts[0].skippedReason, code);
  assert.equal(calls.placements.length, 0);
}

// Guard the submitted order, even if a caller lies about its proposal action.
const acceptedSale = (await validate([sell], heldAccount, policy()))
  .accepted[0];
const spoofed = {
  ...acceptedSale,
  proposal: { ...acceptedSale.proposal, action: "BUY" },
};
const spoofFixture = fixture(heldAccount);
const spoofRun = await execute(
  [spoofed],
  heldAccount,
  disabledPolicy,
  spoofFixture.exchange,
);
assert.equal(spoofRun.attempts[0].skippedReason, code);
assert.equal(spoofFixture.calls.placements.length, 0);

// The last possible asynchronous seam must not bypass the independent guard.
const acceptedBuy = (await validate([buy], heldAccount, disabledPolicy))
  .accepted[0];
const changedOrder = { ...acceptedBuy, order: { ...acceptedBuy.order } };
const journalEvents = [];
const lateFixture = fixture(heldAccount);
const lateRun = await execute(
  [changedOrder],
  heldAccount,
  disabledPolicy,
  lateFixture.exchange,
  {
    journal: {
      async recordIntent() {
        changedOrder.order.action = "SELL";
      },
      async recordSubmissionOutcome(outcome) {
        journalEvents.push(outcome);
      },
      async recordReconciliationOutcome() {
        assert.fail("Blocked submission must not reconcile a mutation");
      },
      async recordAttempt() {
        assert.fail("Blocked submission must not record an executed attempt");
      },
    },
  },
);
assert.equal(lateFixture.calls.previews, 1);
assert.equal(lateFixture.calls.placements.length, 0);
assert.equal(lateRun.attempts[0].skippedReason, code);
assert.equal(lateRun.attempts[0].result, undefined);
assert.equal(lateRun.stoppedForAmbiguity, false);
assert.equal(journalEvents.length, 1);
assert.equal(journalEvents[0].kind, "NOT_SUBMITTED");
assert.equal(journalEvents[0].reason, code);

// BUY source, side, market, preview and open-order safeguards stay in force.
const noSources = await validate(
  [{ ...buy, evidence: [] }],
  heldAccount,
  disabledPolicy,
);
assert.equal(noSources.rejected[0].code, "INSUFFICIENT_SOURCES");
const wrongSide = await validate(
  [proposal("held", "NO", "BUY")],
  heldAccount,
  disabledPolicy,
);
assert.equal(wrongSide.rejected[0].code, "SIDE_MISMATCH");
const warningFixture = fixture(heldAccount, {
  async previewImmediateOrder() {
    return {
      accepted: true,
      estimatedFees: D(0),
      warnings: ["Synthetic warning"],
      rejectionReasons: [],
    };
  },
});
const warningRun = await execute(
  [acceptedBuy],
  heldAccount,
  disabledPolicy,
  warningFixture.exchange,
);
assert.match(warningRun.attempts[0].skippedReason, /fatal warnings/u);
assert.equal(warningFixture.calls.placements.length, 0);
const openAccount = { ...heldAccount, openOrders: [{}] };
await assert.rejects(
  execute(
    [acceptedSale],
    openAccount,
    disabledPolicy,
    fixture(openAccount).exchange,
  ),
  /Unexpected open orders/u,
);
