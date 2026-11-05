import assert from "node:assert/strict";
import { log } from "node:console";
import { Decimal } from "decimal.js";
import { validateDecisionCoverage } from "../src/agent/decision-coverage.ts";
import {
  buildBuyLiquidityReassessmentFeedback,
  buildReviewedLiquidityBaselines,
  buyLiquidityKey,
  collectBuyLiquidityBaselines,
  detectBuyLiquidityDeterioration,
  mergeBuyLiquidityReassessment,
  stripAffectedBuys,
} from "../src/agent/liquidity-reassessment.ts";

const d = (value) => new Decimal(value);
const observedAt = new Date("2030-01-01T00:00:00.000Z");
const market = (slug = "synthetic-a", exchange = "kalshi") => ({
  id: { exchange, value: `id-${slug}` },
  slug,
  title: "Synthetic contract",
  description: "Synthetic contract description",
  settlementRules: "Synthetic settlement rule",
  active: true,
  closed: false,
  archived: false,
  minimumTradeQuantity: d(1),
  priceTick: d("0.01"),
});
const a = market();
const b = market("synthetic-b");
const marketsBySlug = new Map([
  [a.slug, a],
  [b.slug, b],
]);
const target = (m = a) => ({
  marketSlug: m.slug,
  side: "YES",
  targetCostBasisFraction: d("0.2"),
  maximumEntryPrice: d("0.4"),
  estimatedProbability: d("0.8"),
  probabilityLowerBound: d("0.7"),
  probabilityUpperBound: d("0.9"),
  confidence: "MEDIUM",
  thesis: "Synthetic forecast",
  settlementVerification: "Synthetic rules verified",
  invalidationConditions: "Synthetic invalidation",
  evidence: [],
});
const proposal = (m = a) => {
  const fields = Object.fromEntries(
    Object.entries(target(m)).filter(
      ([key]) => key !== "targetCostBasisFraction",
    ),
  );
  return { ...fields, action: "BUY", maximumRiskUsd: d(20) };
};
const book = (m = a, quantity = 5, levels) => ({
  marketId: m.id,
  observedAt: new Date(observedAt.getTime() + 1_000),
  yesAsks: levels ?? [{ price: d("0.4"), quantity: d(quantity) }],
  yesBids: [{ price: d("0.35"), quantity: d(quantity) }],
});
const snapshot = (m = a, quantity = 5, overrides = {}) => ({
  proposal: proposal(m),
  market: m,
  bbo: {
    marketId: m.id,
    observedAt: new Date(observedAt.getTime() + 1_000),
    yes: { bid: d("0.35"), ask: d("0.4") },
    no: { bid: d("0.6"), ask: d("0.65") },
  },
  book: book(m, quantity),
  ...overrides,
});
const preview = (m = a, capacity = 200, overrides = {}) => ({
  marketId: m.id,
  preview: {
    readOnly: true,
    authoritativeForExecution: false,
    marketSlug: m.slug,
    side: "YES",
    action: "BUY",
    quantity: "100",
    limitPrice: "0.4",
    bookObservedAt: observedAt.toISOString(),
    bookObservationBasis: "EXCHANGE_TIMESTAMP",
    depth: {
      maximumImmediatelyFillableQuantity: String(capacity),
      requestedFillableQuantity: "100",
      fullyFillable: true,
      principal: "40",
      vwap: "0.4",
    },
    feePreview: {
      accepted: true,
      basis: "LOCAL_CONSERVATIVE",
      estimatedFees: "0",
      warnings: [],
      rejectionReasons: [],
    },
    costs: {
      expectedBookSpend: "40",
      conservativeFeeReserve: "0",
      maximumSpendAtLimit: "40",
    },
    warnings: [],
    ...overrides,
  },
});
const accepted = (s, overrides = {}) => ({
  ...s,
  authorizationProbability: d("0.7"),
  order: {
    marketId: s.market.id,
    marketSlug: s.market.slug,
    action: "BUY",
    side: s.proposal.side,
    canonicalLimitPrice: d("0.4"),
    quantity: d(5),
  },
  depth: {
    fillableQuantity: d(5),
    fullyFillable: true,
    principal: d(2),
    vwap: d("0.4"),
    worstPrice: d("0.4"),
  },
  estimatedFees: d(0),
  expectedSpend: d(2),
  conservativeFeeReserve: d(0),
  minimumExecutionSpend: d("0.4"),
  maximumExecutionSpend: d(2),
  riskBudget: d(20),
  ...overrides,
});
const validation = (acceptedItems = [], rejected = []) => ({
  accepted: acceptedItems,
  rejected,
  committedCycleSpend: d(0),
});
const detect = (s = snapshot(), v = validation([accepted(s)]), extras = {}) =>
  detectBuyLiquidityDeterioration({
    previews: [preview()],
    snapshots: [s],
    validation: v,
    maximumRetainedLiquidityFraction: d("0.3"),
    ...extras,
  });
const account = (positions = []) => ({
  observedAt,
  currentBalance: d(100),
  buyingPower: d(100),
  assetNotional: d(0),
  positions,
  openOrders: [],
  recentActivity: [],
});
const key = buyLiquidityKey({
  marketId: a.id,
  marketSlug: a.slug,
  side: "YES",
});
const affectedKeys = new Set([key]);
const decision = (
  targets = [target()],
  proposals = [],
  candidateDispositions = [],
) => ({
  cycleSummary: "Synthetic summary",
  portfolioTargets: targets,
  proposals,
  candidateDispositions,
});

const s = snapshot();
assert.equal(
  detect().length,
  1,
  "Material depth loss constrains the actual risk-sized BUY",
);
assert.equal(detect()[0].intendedQuantity.toFixed(), "50");
assert.equal(
  detect(s, validation([accepted(s, { riskBudget: d(2) })])).length,
  0,
  "An intentionally small allocation is fully executable",
);
assert.equal(
  detect(s, validation([accepted(s, { riskBudget: d("2.3") })])).length,
  0,
  "A sub-lot cash remainder is not liquidity binding",
);
assert.equal(
  detect(
    s,
    validation([
      accepted(s, { riskBudget: d("3.5"), conservativeFeeReserve: d("1.5") }),
    ]),
  ).length,
  0,
  "Conservative fees reduce actual intended size",
);
assert.equal(
  detect(s, validation([accepted(s)]), { previews: [] }).length,
  0,
  "No preview means no deterioration baseline",
);
assert.equal(
  detect(s, validation([accepted(s)]), { consumedKeys: affectedKeys }).length,
  0,
  "Consumed keys cannot request another response",
);
assert.equal(
  detect(s, validation([accepted(s)]), {
    maximumRetainedLiquidityFraction: d("0.02"),
  }).length,
  0,
);
assert.equal(
  detect(s, validation([accepted(s)]), {
    maximumRetainedLiquidityFraction: d("0.025"),
  }).length,
  1,
  "Exact materiality boundary is inclusive",
);
assert.throws(
  () =>
    detect(s, validation([accepted(s)]), {
      maximumRetainedLiquidityFraction: d("1.01"),
    }),
  RangeError,
);
assert.throws(
  () =>
    detect(s, validation([accepted(s)]), {
      maximumRetainedLiquidityFraction: d(0),
    }),
  RangeError,
);
assert.throws(
  () =>
    detect(s, validation([accepted(s)]), {
      maximumRetainedLiquidityFraction: d(1),
    }),
  RangeError,
);
const invalidQuantity = snapshot(a, 5, {
  proposal: { ...proposal(), maximumQuantity: d("NaN") },
});
assert.equal(
  detect(invalidQuantity, validation([accepted(invalidQuantity)])).length,
  0,
);

const deeper = snapshot(a, 5, {
  book: book(a, 5, [
    { price: d("0.4"), quantity: d(5) },
    { price: d("0.5"), quantity: d(100) },
  ]),
});
assert.equal(
  detect(
    deeper,
    validation([
      accepted(deeper, {
        order: { ...accepted(deeper).order, canonicalLimitPrice: d("0.5") },
      }),
    ]),
  ).length,
  0,
  "Current authorized depth can satisfy the actual intended order after a limit change",
);
const rejected = (code) =>
  validation(
    [],
    [{ proposal: s.proposal, code, reason: "Synthetic rejection" }],
  );
assert.equal(detect(s, rejected("NO_DEPTH")).length, 1);
assert.equal(detect(s, rejected("PRICE_LIMIT_EXCEEDED")).length, 1);
assert.equal(detect(s, rejected("INSUFFICIENT_BUDGET")).length, 0);
assert.equal(detect(s, rejected("NON_POSITIVE_EDGE")).length, 0);
assert.equal(
  detect(
    s,
    validation(
      [],
      [
        { proposal: s.proposal, code: "NO_DEPTH", reason: "Synthetic depth" },
        {
          proposal: s.proposal,
          code: "BUYING_POWER",
          reason: "Synthetic budget",
        },
      ],
    ),
  ).length,
  0,
  "A separate risk failure cannot be repaired as liquidity",
);
const plenty = snapshot(a, 100);
assert.equal(
  detect(
    plenty,
    validation(
      [],
      [
        {
          proposal: plenty.proposal,
          code: "NO_DEPTH",
          reason: "Synthetic notional gate",
        },
      ],
    ),
    { previews: [preview(a, 400)] },
  ).length,
  0,
  "A notional gate alone does not prove quantity binding",
);
const invalidProbability = snapshot(a, 5, {
  proposal: { ...proposal(), probabilityLowerBound: d("0.95") },
});
assert.equal(
  detect(invalidProbability, validation([accepted(invalidProbability)])).length,
  0,
);
const wrongIdentity = snapshot(market(a.slug, "polymarket-us"));
assert.equal(
  detect(wrongIdentity, validation([accepted(wrongIdentity)])).length,
  0,
  "Exchange identity matters despite an identical slug",
);
const stale = snapshot(a, 5, {
  book: { ...book(), observedAt: new Date(observedAt.getTime() - 1) },
});
assert.equal(detect(stale, validation([accepted(stale)])).length, 0);
const malformed = snapshot(a, 5, {
  book: book(a, 5, [{ price: d("0.4"), quantity: d(-1) }]),
});
assert.equal(detect(malformed, validation([accepted(malformed)])).length, 0);

const baseline = collectBuyLiquidityBaselines([
  preview(a, 200),
  preview(a, 180),
  preview(a, 999, {
    feePreview: { ...preview().preview.feePreview, accepted: false },
  }),
  preview(a, 0),
  preview(a, 999, { quantity: "0" }),
]);
assert.equal(baseline.length, 1);
assert.equal(
  baseline[0].availableQuantity.toFixed(),
  "180",
  "Latest successful positive preview wins",
);
assert.equal(
  collectBuyLiquidityBaselines([preview(a, 1, { limitPrice: "NaN" })]).length,
  0,
);

const ladder = Array.from({ length: 7 }, (_, index) => ({
  price: d("0.4").plus(d("0.01").mul(index)),
  quantity: d(index === 6 ? 1000 : 1),
}));
const ladderSnapshot = snapshot(a, 1, { book: book(a, 1, ladder) });
const ladderAffected = detect(
  ladderSnapshot,
  validation([accepted(ladderSnapshot)]),
);
const feedback = buildBuyLiquidityReassessmentFeedback(ladderAffected);
assert.equal(feedback[0].freshBook.levels.length, 5);
assert.equal(feedback[0].originalPreview.maximumAvailableQuantity, "200");
assert.equal(feedback[0].currentExecution.riskBudgetUsd, "20");
assert.equal(JSON.stringify(feedback).includes("positions"), false);
assert.equal(JSON.stringify(feedback).includes("rawStatus"), false);
const reviewed = buildReviewedLiquidityBaselines(
  ladderAffected,
  decision([{ ...target(), maximumEntryPrice: d("0.9") }]),
  marketsBySlug,
);
assert.equal(
  reviewed[0].availableQuantity.toFixed(),
  "5",
  "Revised baseline uses only the five supplied ladder levels",
);
assert.equal(reviewed[0].source, "REASSESSMENT_BOOK");
const zeroReviewed = buildReviewedLiquidityBaselines(
  ladderAffected,
  decision([{ ...target(), maximumEntryPrice: d("0.3") }]),
  marketsBySlug,
);
assert.equal(
  zeroReviewed.length,
  0,
  "A zero-depth revised limit has no review authorization",
);
const later = snapshot(a, 1, {
  book: { ...book(a, 1), observedAt: new Date(observedAt.getTime() + 2_000) },
});
assert.equal(
  detect(later, validation([accepted(later)]), {
    previews: [],
    baselines: reviewed,
  }).length,
  1,
  "Renewed material loss is measured against the response's own book",
);
assert.equal(
  buyLiquidityKey({ marketId: a.id, marketSlug: a.slug, side: "YES" }),
  key,
);
assert.notEqual(
  buyLiquidityKey({ marketId: a.id, marketSlug: a.slug, side: "NO" }),
  key,
);

const sell = {
  ...proposal(b),
  action: "SELL",
  maximumEntryPrice: undefined,
  minimumExitPrice: d("0.3"),
};
const original = decision([target(), target(b)], [sell]);
const merge = (replacement, extra = {}) =>
  mergeBuyLiquidityReassessment({
    original,
    replacement,
    affectedKeys,
    snapshot: account(),
    marketsBySlug,
    riskEquity: d(100),
    ...extra,
  });
const reduced = {
  ...target(),
  maximumEntryPrice: d("0.45"),
  targetCostBasisFraction: d("0.1"),
  thesis: "Synthetic liquidity revision",
};
const merged = merge(decision([target(b), reduced], []));
assert.equal(merged.acknowledgedKeys.has(key), true);
assert.equal(merged.rejectedKeys.size, 0);
assert.equal(merged.decision.portfolioTargets[0], reduced);
assert.equal(merged.decision.portfolioTargets[1], original.portfolioTargets[1]);
assert.equal(
  merged.decision.proposals[0],
  sell,
  "SELLs survive omission or reordering in the response",
);
assert.equal(
  merge(decision([target()])).acknowledgedKeys.has(key),
  true,
  "Explicitly accepting the original target acknowledges the smaller executable size",
);
for (const change of [
  { side: "NO" },
  { estimatedProbability: d("0.81") },
  { probabilityLowerBound: d("0.69") },
  { probabilityUpperBound: d("0.91") },
  { confidence: "HIGH" },
  { settlementVerification: "Changed synthetic rule" },
  { invalidationConditions: "Changed synthetic invalidation" },
  {
    evidence: [
      {
        title: "Fabricated",
        url: "https://example.test/source",
        relevance: "Synthetic",
        evidenceClass: "CURRENT_REPORT",
      },
    ],
  },
  { targetCostBasisFraction: d("0.21") },
]) {
  const result = merge(decision([{ ...target(), ...change }, target(b)]));
  assert.equal(
    result.rejectedKeys.has(key),
    true,
    `Unsafe revision rejected: ${Object.keys(change)[0]}`,
  );
  assert.equal(
    result.decision.portfolioTargets.some((item) => item.marketSlug === a.slug),
    false,
  );
  assert.equal(
    result.decision.portfolioTargets[0],
    original.portfolioTargets[1],
    "An invalid affected replacement does not block an independent target",
  );
  assert.equal(result.decision.proposals[0], sell);
}
const unrelated = { ...target(b), estimatedProbability: d("0.85") };
const unrelatedResult = merge(
  decision([reduced, unrelated, { ...target(), marketSlug: "synthetic-new" }]),
);
assert.equal(unrelatedResult.acknowledgedKeys.has(key), true);
assert.equal(
  unrelatedResult.decision.portfolioTargets[1],
  original.portfolioTargets[1],
);
assert.equal(unrelatedResult.decision.portfolioTargets.length, 2);
assert.equal(unrelatedResult.issues.length, 2);
const bundleChange = merge({
  ...decision([reduced]),
  evidenceBundles: [{ id: "new-synthetic", evidence: [] }],
});
assert.equal(bundleChange.rejectedKeys.has(key), true);
const autoTarget = { ...target(), maximumEntryPrice: undefined };
const autoOriginal = decision([autoTarget, target(b)]);
const autoAcknowledged = mergeBuyLiquidityReassessment({
  original: autoOriginal,
  replacement: decision([autoTarget, target(b)]),
  affectedKeys,
  snapshot: account(),
  marketsBySlug,
  riskEquity: d(100),
  currentExecutionLimitByKey: new Map([[key, d("0.43")]]),
});
assert.equal(autoAcknowledged.acknowledgedKeys.has(key), true);
assert.equal(
  autoAcknowledged.decision.portfolioTargets[0].maximumEntryPrice.toFixed(),
  "0.43",
  "Unchanged automatic-price acknowledgement freezes the disclosed current execution limit",
);
assert.equal(
  buildReviewedLiquidityBaselines(
    detect(),
    autoAcknowledged.decision,
    marketsBySlug,
  )[0].limitPrice.toFixed(),
  "0.43",
);
const removedExplicitLimit = merge(
  decision([{ ...target(), maximumEntryPrice: undefined }]),
  {
    currentExecutionLimitByKey: new Map([[key, d("0.43")]]),
  },
);
assert.equal(
  removedExplicitLimit.rejectedKeys.has(key),
  true,
  "An explicit original limit cannot be deleted to reopen automatic pricing",
);
const zeroTarget = merge(
  decision([{ ...target(), targetCostBasisFraction: d(0) }, target(b)]),
);
assert.equal(zeroTarget.acknowledgedKeys.has(key), true);
assert.equal(
  zeroTarget.decision.portfolioTargets.length,
  1,
  "A reduction to zero becomes a PASS instead of a blocked unheld exit target",
);
assert.equal(zeroTarget.decision.candidateDispositions[0].outcome, "PASS");

const pass = {
  marketSlug: a.slug,
  side: "YES",
  outcome: "PASS",
  reasonCode: "MARKET_STRUCTURE",
  rationale: "Synthetic book has less size",
  evidence: [],
};
const passed = merge(decision([target(b)], [], [pass]));
assert.equal(passed.acknowledgedKeys.has(key), true);
assert.equal(
  passed.decision.candidateDispositions[0].reasonCode,
  "MARKET_STRUCTURE",
);
assert.equal(passed.decision.portfolioTargets.length, 1);
assert.equal(
  merge(decision([target(b)])).rejectedKeys.has(key),
  true,
  "Omission alone is not acknowledgement",
);
assert.equal(
  merge(
    decision([target(b)], [], [{ ...pass, estimatedProbability: d("0.81") }]),
  ).rejectedKeys.has(key),
  true,
);

const heldPosition = {
  marketId: a.id,
  marketSlug: a.slug,
  side: "YES",
  quantity: d(10),
  availableQuantity: d(10),
  costBasis: d(5),
  realizedPnl: d(0),
  expired: false,
};
const heldAccount = account([heldPosition]);
const held = stripAffectedBuys({
  decision: original,
  affectedKeys,
  snapshot: heldAccount,
  marketsBySlug,
  riskEquity: d(100),
});
assert.equal(
  held.portfolioTargets.some((item) => item.marketSlug === a.slug),
  false,
  "A held position uses only a hold disposition, avoiding target/disposition overlap",
);
assert.equal(held.candidateDispositions[0].outcome, "HOLD_UNCHANGED");
assert.equal(held.proposals[0], sell);
const coverage = validateDecisionCoverage({
  decision: { ...held, proposals: [] },
  snapshot: heldAccount,
  qualifiedMarketSlugs: new Set([a.slug, b.slug]),
  seriouslyEvaluatedMarketSlugs: new Set([a.slug, b.slug]),
  inspectedMarketSlugs: new Set([a.slug, b.slug]),
  requiredPrioritySignalMarketSlugs: new Set(),
});
assert.equal(
  coverage.valid,
  true,
  "Held fallback keeps independent targets eligible through final coverage guards",
);
assert.equal(
  buildReviewedLiquidityBaselines(detect(), held, marketsBySlug).length,
  0,
  "An exact hold cannot restart entry review",
);
assert.equal(
  merge(decision([{ ...target(), targetCostBasisFraction: d("0.04") }]), {
    snapshot: heldAccount,
  }).rejectedKeys.has(key),
  true,
  "Reducing allocation cannot introduce a SELL",
);
assert.equal(
  merge(
    decision([], [], [{ ...pass, outcome: "HOLD_UNCHANGED" }]),
  ).rejectedKeys.has(key),
  true,
  "A new position cannot be called an unchanged hold",
);
assert.equal(
  merge(decision([], [], [{ ...pass, outcome: "HOLD_UNCHANGED" }]), {
    snapshot: heldAccount,
  }).acknowledgedKeys.has(key),
  true,
);

const legacyOriginal = decision([], [proposal(), sell]);
const legacy = mergeBuyLiquidityReassessment({
  original: legacyOriginal,
  replacement: decision(
    [],
    [{ ...proposal(), maximumRiskUsd: d(10), maximumEntryPrice: d("0.45") }],
  ),
  affectedKeys,
  snapshot: account(),
  marketsBySlug,
  riskEquity: d(100),
});
assert.equal(legacy.acknowledgedKeys.has(key), true);
assert.equal(legacy.decision.proposals[0].maximumRiskUsd.toFixed(), "10");
assert.equal(legacy.decision.proposals[1], sell);
const legacyIncreased = mergeBuyLiquidityReassessment({
  original: legacyOriginal,
  replacement: decision([], [{ ...proposal(), maximumRiskUsd: d(21) }]),
  affectedKeys,
  snapshot: account(),
  marketsBySlug,
  riskEquity: d(100),
});
assert.equal(legacyIncreased.rejectedKeys.has(key), true);
assert.deepEqual(legacyIncreased.decision.proposals, [sell]);

const zeroCostHold = stripAffectedBuys({
  decision: original,
  affectedKeys,
  snapshot: account([{ ...heldPosition, costBasis: d(0) }]),
  marketsBySlug,
  riskEquity: d(100),
});
assert.equal(
  zeroCostHold.portfolioTargets.some((item) => item.marketSlug === a.slug),
  false,
  "Zero-cost held exposure must not become an exit-to-zero target",
);
assert.equal(zeroCostHold.candidateDispositions[0].outcome, "HOLD_UNCHANGED");
const roundedHold = stripAffectedBuys({
  decision: decision([{ ...target(), targetCostBasisFraction: d("0.8") }]),
  affectedKeys,
  snapshot: account([{ ...heldPosition, costBasis: d(1) }]),
  marketsBySlug,
  riskEquity: d(3),
});
assert.equal(
  roundedHold.portfolioTargets.length,
  0,
  "A nonterminating fraction cannot accidentally materialize a rounded trim",
);
assert.equal(roundedHold.candidateDispositions[0].outcome, "HOLD_UNCHANGED");

log("liquidity reassessment checks passed");
