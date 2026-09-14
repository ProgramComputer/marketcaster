import assert from "node:assert/strict";
import { log } from "node:console";
const { AbortController } = globalThis;
import { Decimal } from "decimal.js";
import { reviewResolvedTargets } from "../dist/src/strategy/resolution-review.js";
import { applyFreshForecastProbability } from "../dist/src/risk/validate.js";

const now = () => new Date("2026-01-02T12:00:00Z");
const target = {
  marketSlug: "synthetic-market",
  side: "YES",
  targetCostBasisFraction: new Decimal("0.1"),
};
const details = new Map([
  [target.marketSlug, { id: "synthetic-id", slug: target.marketSlug }],
]);
let reviews = 0;
const policy = {
  selectMarketSlugs: () => [target.marketSlug],
  reviewTarget: ({ resolution }) => {
    reviews++;
    assert.equal(resolution.kind, "AUTHORITATIVE_RESOLUTION");
    return "Synthetic deployment requests review";
  },
};
const base = {
  policy,
  targets: [target],
  details,
  now,
  signal: new AbortController().signal,
  forecasts: {
    requiredMarketSlugs: new Set([target.marketSlug]),
    selectedSideProbabilityByMarketSlug: new Map([
      [target.marketSlug, new Decimal(0)],
    ]),
  },
};
const final = {
  marketId: { exchange: "polymarket-us", value: "synthetic-id" },
  state: "SETTLED_NO",
  settlementPrice: new Decimal(0),
  settledAt: new Date("2026-01-02T11:00:00Z"),
};
for (const status of [
  { ...final, state: "OPEN" },
  { ...final, state: "VOID", settlementPrice: new Decimal("0.5") },
  { ...final, settlementPrice: new Decimal(1) },
  { ...final, marketId: { ...final.marketId, value: "other-id" } },
  { ...final, marketId: { ...final.marketId, exchange: "kalshi" } },
  { ...final, settledAt: new Date("2026-01-03T00:00:00Z") },
]) {
  const result = await reviewResolvedTargets({
    ...base,
    exchange: { id: "polymarket-us", getSettlement: async () => status },
  });
  assert.equal(result.issues.length, 0);
  assert.equal(result.observations[0].kind, "UNCONFIRMED");
}
assert.equal(
  reviews,
  0,
  "A forecast of zero or inconsistent settlement must never invoke resolution policy",
);
const result = await reviewResolvedTargets({
  ...base,
  exchange: { id: "polymarket-us", getSettlement: async () => final },
});
assert.equal(reviews, 1);
assert.equal(result.issues.length, 1);
assert.deepEqual(result.observations[0].resolution.source, {
  exchange: "polymarket-us",
  operation: "getSettlement",
});
assert.equal(result.observations[0].resolution.marketId, "synthetic-id");
assert.equal(result.observations[0].resolution.observedAt, now().toISOString());
const unavailable = await reviewResolvedTargets({
  ...base,
  exchange: {
    id: "polymarket-us",
    getSettlement: async () => {
      throw new Error("Synthetic unavailable");
    },
  },
});
assert.equal(unavailable.observations[0].kind, "UNCONFIRMED");
assert.equal(reviews, 1);
await assert.rejects(
  reviewResolvedTargets({
    ...base,
    policy: { ...policy, selectMarketSlugs: () => ["other"] },
    exchange: { id: "polymarket-us" },
  }),
  /untargeted/u,
);
const controller = new AbortController();
controller.abort();
await assert.rejects(
  reviewResolvedTargets({
    ...base,
    signal: controller.signal,
    exchange: { id: "polymarket-us" },
  }),
);
const fresh = applyFreshForecastProbability(
  {
    estimatedProbability: new Decimal("0.4"),
    probabilityLowerBound: new Decimal("0.2"),
    probabilityUpperBound: new Decimal("0.8"),
  },
  new Decimal(0),
);
assert(
  fresh.probabilityUpperBound.eq("0.8"),
  "A fresh zero estimate must not collapse uncertainty to settlement certainty",
);
log(
  "Resolution identity, timestamp, source, forecast separation and unavailable-state checks passed.",
);
