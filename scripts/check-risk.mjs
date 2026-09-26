// check-risk-edge.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { Decimal } = await import("decimal.js");
  const { validateProposals } = await import("../dist/src/risk/validate.js");
  const { calculateKellyBudget } = await import("../dist/src/risk/kelly.js");
  const { executeValidatedOrders } =
    await import("../dist/src/execution/executor.js");
  const {
    calculateNetEdge,
    estimatePolymarketUsTakerFeeUpperBound,
    estimateExchangeTakerFeePerContract,
    feeForEdgeEvaluation,
  } = await import("../dist/src/risk/edge.js");
  const quantity = new Decimal(1);
  const price = new Decimal("0.98");
  const probability = new Decimal("0.995");
  const priceSpecificFee = estimateExchangeTakerFeePerContract(
    "polymarket-us",
    price,
  );
  const cashReserve = estimatePolymarketUsTakerFeeUpperBound(
    quantity,
    price,
    "BUY",
  );

  assert.equal(priceSpecificFee.toFixed(6), "0.001362");
  assert.equal(cashReserve.toFixed(3), "0.020");
  assert.equal(
    feeForEdgeEvaluation(
      "polymarket-us",
      priceSpecificFee,
      cashReserve,
    ).toFixed(6),
    "0.001362",
  );
  assert.equal(
    calculateNetEdge(probability, price, priceSpecificFee).toFixed(6),
    "0.013638",
  );
  assert.equal(
    feeForEdgeEvaluation("kalshi", priceSpecificFee, cashReserve).toFixed(3),
    "0.020",
  );

  // Synthetic exchange only. No credentials, network, or real orders are used.
  const d = (value = 0) => new Decimal(value);
  const now = () => new Date("2026-01-02T00:00:00Z");
  const market = {
    id: { exchange: "polymarket-us", value: "synthetic-market" },
    slug: "synthetic-market",
    active: true,
    closed: false,
    archived: false,
    priceTick: d("0.01"),
    minimumTradeQuantity: d(1),
  };
  const bbo = {
    observedAt: now(),
    yes: { bid: d("0.97"), ask: d("0.98") },
    no: { bid: d("0.02"), ask: d("0.03") },
  };
  const book = {
    observedAt: now(),
    yesBids: [{ price: d("0.97"), quantity: d(100) }],
    yesAsks: [{ price: d("0.98"), quantity: d(100) }],
  };
  const snapshot = {
    observedAt: now(),
    currentBalance: d(100),
    buyingPower: d(100),
    assetNotional: d(0),
    assetAvailable: d(0),
    openOrderValue: d(0),
    unsettledFunds: d(0),
    marginRequirement: d(0),
    positions: [],
    openOrders: [],
    recentActivities: [],
  };
  const policy = {
    maximumPositionCostBasisFraction: d(1),
    maximumCycleSpendFraction: d(1),
    maximumExecutionSpread: d("0.1"),
    kellyFraction: d("0.25"),
    uncertaintyBoundWeight: d("0.25"),
    minimumIndependentSources: 0,
    duplicateWindowMinutes: 1,
    emergencyExitEnabled: false,
  };
  const proposal = {
    marketSlug: market.slug,
    side: "YES",
    action: "BUY",
    estimatedProbability: probability,
    probabilityLowerBound: probability,
    probabilityUpperBound: probability,
    maximumEntryPrice: price,
    maximumRiskUsd: d(10),
    evidence: [],
  };
  const exchange = {
    id: market.id.exchange,
    getMarketBySlug: async () => market,
    getBbo: async () => bbo,
    getOrderBook: async () => book,
    createImmediateOrderFeeReserveEstimator: async (order) => (quantity) =>
      estimatePolymarketUsTakerFeeUpperBound(
        quantity,
        order.canonicalLimitPrice,
        "BUY",
      ),
  };
  const input = {
    exchange,
    snapshot,
    valuation: { riskEquity: d(100) },
    policy,
    proposals: [proposal],
    now,
    allocationPolicy: ({ candidates }) =>
      candidates.map(({ id, maximumSpend }) => ({ id, spend: maximumSpend })),
  };

  for (const resting of [false, true]) {
    const result = await validateProposals({
      ...input,
      managedRestingBuyOrders: { enabled: resting, maximumLifetimeMinutes: 5 },
    });
    assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
    assert.equal(result.accepted.length, 1);
    const accepted = result.accepted[0];
    assert.equal(accepted.order.quantity.toString(), "10");
    assert.equal(accepted.estimatedFees.toString(), "0.01");
    assert.equal(accepted.conservativeFeeReserve.toString(), "0.17");
    assert.equal(accepted.maximumExecutionSpend.toString(), "9.97");
    assert.equal(accepted.netEdge.toString(), "0.014");
    assert.ok(accepted.maximumExecutionSpend.lte(accepted.riskBudget));
    assert.ok(
      accepted.maximumExecutionSpend.lte(
        calculateKellyBudget(
          probability,
          price.plus(priceSpecificFee),
          d(100),
          policy.kellyFraction,
        ),
      ),
    );
  }

  const kellyLimited = await validateProposals({
    ...input,
    proposals: [{ ...proposal, maximumRiskUsd: d(100) }],
  });
  assert.equal(kellyLimited.accepted.length, 1);
  assert.ok(kellyLimited.accepted[0].maximumExecutionSpend.lt(20));
  assert.ok(kellyLimited.accepted[0].maximumExecutionSpend.gt(10));

  // An explained policy omission is final; an unexplained one stays a budget miss.
  const omitted = (extra) =>
    validateProposals({
      ...input,
      allocationPolicy: Object.assign(() => [], extra),
    });
  const explainedOmission = await omitted({
    omissionReason: () => "synthetic policy exclusion",
  });
  assert.deepEqual(
    explainedOmission.rejected.map(({ code, reason }) => [code, reason]),
    [
      [
        "POLICY_UNFUNDED",
        "Allocation policy leaves this candidate unfunded at any size this cycle: synthetic policy exclusion",
      ],
    ],
  );
  assert.equal((await omitted({})).rejected[0].code, "CYCLE_SPEND");

  // Budgeting still includes the larger reserve, even when economic edge is positive.
  for (const patch of [
    { snapshot: { ...snapshot, buyingPower: d("0.99") } },
    { policy: { ...policy, maximumCycleSpendFraction: d("0.0099") } },
    { proposals: [{ ...proposal, maximumRiskUsd: d("0.99") }] },
  ]) {
    const result = await validateProposals({ ...input, ...patch });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
  }
  const negativeEdge = await validateProposals({
    ...input,
    proposals: [
      {
        ...proposal,
        estimatedProbability: d("0.98"),
        probabilityLowerBound: d("0.98"),
      },
    ],
  });
  assert.equal(negativeEdge.rejected[0].code, "NON_POSITIVE_EDGE");
  const kalshiMarket = { ...market, id: { ...market.id, exchange: "kalshi" } };
  const kalshi = await validateProposals({
    ...input,
    exchange: {
      ...exchange,
      id: "kalshi",
      getMarketBySlug: async () => kalshiMarket,
    },
  });
  assert.equal(
    kalshi.accepted.length,
    0,
    "Kalshi retains conservative reserve-based authorization",
  );
  assert.equal(kalshi.rejected[0].code, "NON_POSITIVE_EDGE");

  const validated = {
    market,
    proposal,
    order: {
      marketId: market.id,
      marketSlug: market.slug,
      side: "YES",
      action: "BUY",
      quantity: d(1),
      canonicalLimitPrice: price,
      executionPolicy: "IOC",
    },
    authorizationProbability: probability,
    conservativeFeeReserve: cashReserve,
    maximumExecutionSpend: price.plus(cashReserve),
    riskBudget: d(2),
  };
  async function previewCase(previewPatch = {}, inputPatch = {}) {
    let placements = 0;
    const fakeExchange = {
      ...exchange,
      getOpenOrders: async () => [],
      getPositions: async () => [],
      getActivities: async () => ({ items: [], eof: true }),
      getAccountSnapshot: async () => snapshot,
      previewImmediateOrder: async () => ({
        accepted: true,
        estimatedFees: d(0),
        warnings: [],
        rejectionReasons: [],
        ...previewPatch,
      }),
      placeImmediateOrder: async () => {
        placements += 1;
        return {
          status: "NO_FILL",
          filledQuantity: d(0),
          fees: d(0),
          finalState: "CANCELED",
        };
      },
    };
    const result = await executeValidatedOrders({
      mode: "live",
      exchange: fakeExchange,
      snapshot,
      riskEquity: d(100),
      validated: [validated],
      policy,
      now,
      ...inputPatch,
    });
    return { result, placements };
  }
  assert.equal(
    (await previewCase()).placements,
    1,
    "Missing preview principal uses limit and local economic fee",
  );
  assert.equal(
    (await previewCase({ estimatedPrincipal: d("0.97") })).placements,
    1,
  );
  for (const [preview, patch, expected] of [
    [
      { estimatedPrincipal: d("0.97"), estimatedFees: d("0.02") },
      {},
      /limit price and fees/,
    ],
    [{ estimatedFees: d("0.03") }, {}, /preview price and fees/],
    [{ estimatedPrincipal: d("NaN") }, {}, /invalid principal/],
    [{ estimatedFees: d(-1) }, {}, /invalid principal/],
    [{ estimatedPrincipal: d("1.01") }, {}, /invalid effective price/],
    [
      {},
      { validated: [{ ...validated, riskBudget: d("0.99") }] },
      /risk budget/,
    ],
    [{}, { snapshot: { ...snapshot, buyingPower: d("0.99") } }, /buying power/],
    [
      {},
      { policy: { ...policy, maximumCycleSpendFraction: d("0.0099") } },
      /cycle spend/,
    ],
  ]) {
    const { placements, result } = await previewCase(preview, patch);
    assert.equal(placements, 0, "Rejected previews never reach placement");
    assert.match(result.attempts[0].skippedReason, expected);
  }
})();

// check-pass-edge-audit.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { Decimal } = await import("decimal.js");
  const { auditNoPositiveEdgePasses } =
    await import("../dist/src/agent/pass-edge-audit.js");
  /* global AbortController, console */

  // Synthetic quotes and forecasts only; the exchange has no order methods.
  const d = (value) => new Decimal(value);
  const market = {
    id: { exchange: "polymarket-us", value: "fixture-contract" },
    slug: "fixture-contract",
    priceTick: d("0.01"),
  };
  const bbo = {
    yes: { bid: d("0.49"), ask: d("0.5"), spread: d("0.01") },
    no: { bid: d("0.49"), ask: d("0.5"), spread: d("0.01") },
  };
  let quoteReads = 0;
  const exchange = {
    id: "polymarket-us",
    getBbo: async () => {
      quoteReads += 1;
      return bbo;
    },
  };
  const quoteCache = new Map();
  async function audit(point, minimumMaterialEdge = "0") {
    return auditNoPositiveEdgePasses({
      decision: {
        candidateDispositions: [
          {
            marketSlug: market.slug,
            outcome: "PASS",
            reasonCode: "NO_POSITIVE_EDGE",
            side: "YES",
            estimatedProbability: d(point),
            probabilityLowerBound: d(point),
            probabilityUpperBound: d(point),
          },
        ],
      },
      marketsBySlug: new Map([[market.slug, market]]),
      previewedMarketSlugs: new Set([market.slug]),
      exchange,
      maximumExecutionSpread: d("0.1"),
      minimumMaterialEdge: d(minimumMaterialEdge),
      uncertaintyBoundWeight: d("0.5"),
      quoteCache,
      signal: new AbortController().signal,
    });
  }

  for (const [point, edge, status, issueCount] of [
    ["0.507375", "-0.01", "NON_POSITIVE", 0],
    ["0.517375", "0", "NON_POSITIVE", 0],
    ["0.522375", "0.005", "POSITIVE_NOT_MATERIAL", 0],
    ["0.527375", "0.01", "POSITIVE_NOT_MATERIAL", 0],
    ["0.537375", "0.02", "MATERIAL_POSITIVE", 1],
  ]) {
    const report = await audit(point);
    const check = report.checks.find((row) => row.evaluatedSide === "YES");
    assert.equal(check.status, status);
    assert.equal(check.netEdgePerContract, edge);
    assert.equal(check.materialEdgeThreshold, "0.01");
    assert.equal(report.issues.length, issueCount);
  }

  const customThreshold = await audit("0.535", "0.03");
  assert.equal(customThreshold.checks[0].status, "POSITIVE_NOT_MATERIAL");
  assert.equal(customThreshold.checks[0].materialEdgeThreshold, "0.03");
  assert.equal(customThreshold.issues.length, 0);
  const opposite = await audit("0.465");
  assert.equal(opposite.checks[1].status, "MATERIAL_POSITIVE");
  assert.equal(opposite.issues.length, 1);
  assert.equal(quoteReads, 1, "repair uses the frozen quote for both sides");
  console.log(
    "Pass-edge diagnostics preserve strict materiality and frozen quotes.",
  );
})();

// check-polymarket-fees.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { log } = await import("node:console");
  const { Decimal } = await import("decimal.js");
  const {
    estimateTakerFee,
    estimateExchangeTakerFee,
    estimateExchangeTakerFeePerContract,
    estimatePolymarketUsFillFee,
    estimatePolymarketUsTakerFeeUpperBound,
  } = await import("../dist/src/risk/edge.js");
  const { PolymarketUsExchange } =
    await import("../dist/src/exchanges/polymarket-us/adapter.js");
  const d = (v) => new Decimal(v);
  // Official schedule: https://docs.polymarket.us/fees (2026-09-17).
  for (const [price, taker, maker] of [
    ["0.01", "0.07", "-0.01"],
    ["0.10", "0.63", "-0.11"],
    ["0.25", "1.30", "-0.23"],
    ["0.50", "1.74", "-0.31"],
    ["0.75", "1.30", "-0.23"],
    ["0.90", "0.63", "-0.11"],
    ["0.99", "0.07", "-0.01"],
  ]) {
    assert.equal(
      estimateExchangeTakerFee("polymarket-us", d(100), d(price)).toFixed(2),
      taker,
    );
    assert.equal(
      estimatePolymarketUsFillFee(d(100), d(price), "MAKER").toFixed(2),
      maker,
    );
  }
  assert(
    estimateExchangeTakerFeePerContract("polymarket-us", d("0.5")).eq(
      "0.017375",
    ),
  );
  assert(
    estimateExchangeTakerFeePerContract("polymarket-us", d("0.5"))
      .div("0.5")
      .eq("0.03475"),
  );
  // Exact half-cent ties in both directions, including negative maker rebates.
  assert(estimatePolymarketUsFillFee(d(40), d("0.5"), "TAKER").eq("0.70")); // .695
  assert(estimatePolymarketUsFillFee(d(120), d("0.5"), "TAKER").eq("2.08")); // 2.085
  assert(estimatePolymarketUsFillFee(d(8), d("0.5"), "MAKER").eq("-0.02")); // -.025
  assert(estimatePolymarketUsFillFee(d("11.2"), d("0.5"), "MAKER").eq("-0.04")); // -.035
  assert(estimatePolymarketUsFillFee(d("0.01"), d("0.01"), "TAKER").isZero());
  assert(estimatePolymarketUsFillFee(d(0), d("0.5"), "TAKER").isZero());

  // Synthetic fragmented fills: independently rounded fees may exceed the cap.
  // Apply the published per-order adjustment and verify the adapter's reserve.
  for (const action of ["BUY", "SELL"]) {
    for (const limit of [
      "0.01",
      "0.10",
      "0.49",
      "0.5",
      "0.51",
      "0.90",
      "0.99",
    ]) {
      const estimate =
        await PolymarketUsExchange.prototype.createImmediateOrderFeeReserveEstimator.call(
          {},
          { action, canonicalLimitPrice: d(limit) },
        );
      for (const quantities of [
        [1],
        [1, 1, 1],
        ["0.01", "0.99", 8, 120],
        [100, 1000],
      ]) {
        let cumulativeExact = d(0);
        let collected = d(0);
        let totalQuantity = d(0);
        for (const [index, quantity] of quantities.entries()) {
          const price =
            action === "BUY"
              ? d(limit).mul(index % 2 ? "0.5" : 1)
              : d(limit).plus(
                  d(1)
                    .minus(limit)
                    .mul(index % 2 ? "0.5" : 0),
                );
          cumulativeExact = cumulativeExact.plus(
            estimateTakerFee(d(quantity), price),
          );
          const roundedFill = estimatePolymarketUsFillFee(
            d(quantity),
            price,
            "TAKER",
          );
          const cap = cumulativeExact.toDecimalPlaces(
            2,
            Decimal.ROUND_HALF_EVEN,
          );
          const adjusted = Decimal.min(roundedFill, cap.minus(collected));
          assert(adjusted.gte(0) && adjusted.lte(roundedFill));
          collected = collected.plus(adjusted);
          totalQuantity = totalQuantity.plus(quantity);
          assert(collected.lte(estimate(totalQuantity)));
        }
        assert(
          estimate(totalQuantity).eq(
            estimatePolymarketUsTakerFeeUpperBound(
              totalQuantity,
              d(limit),
              action,
            ),
          ),
        );
      }
    }
  }
  assert(
    estimatePolymarketUsTakerFeeUpperBound(d(1), d("0.99"), "BUY").eq("0.02"),
  );
  assert(
    estimatePolymarketUsTakerFeeUpperBound(d(1), d("0.99"), "SELL").isZero(),
  );
  // Other exchange rounding is unchanged.
  assert(estimateExchangeTakerFee("kalshi", d(100), d("0.5")).eq("1.76"));
  log(
    "Polymarket US rates, half-even rounding, maker rebates, and fragmented-fill adapter reserves passed.",
  );
})();
