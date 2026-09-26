import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { validateProposals } from "../dist/src/risk/validate.js";
import { calculateKellyBudget } from "../dist/src/risk/kelly.js";
import { executeValidatedOrders } from "../dist/src/execution/executor.js";
import {
  calculateNetEdge,
  estimatePolymarketUsTakerFeeUpperBound,
  estimateExchangeTakerFeePerContract,
  feeForEdgeEvaluation,
} from "../dist/src/risk/edge.js";

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
  feeForEdgeEvaluation("polymarket-us", priceSpecificFee, cashReserve).toFixed(
    6,
  ),
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
  [{}, { validated: [{ ...validated, riskBudget: d("0.99") }] }, /risk budget/],
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
