import assert from "node:assert/strict";
import process from "node:process";
import { Decimal } from "decimal.js";
import {
  buildAgentContext,
  buildMarketDetailContext,
} from "../dist/src/agent/context-builder.js";
import {
  buildTerminalDecisionRepairFeedback,
  isRepairableRiskRejection,
  retainPositionReductionRequests,
} from "../dist/src/agent/decision-repair.js";
import { buildDecisionPrompt } from "../dist/src/agent/prompt-builder.js";
import { AdvisoryTradePreviewResolver } from "../dist/src/agent/trade-preview.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";

const d = (value) => new Decimal(value);
const now = new Date("2026-01-01T12:00:00Z");
const contextInput = {
  observedAt: now,
  exchangeId: "polymarket-us",
  exchangeName: "Synthetic exchange",
  account: {
    observedAt: now,
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
  },
  marketCatalog: { count: 0, categoryCounts: {} },
  preloadedMarkets: [],
  riskConstraints: {
    maximumPositionCostBasisFraction: d("0.2"),
    maximumCycleSpendFraction: d("0.1"),
    maximumExecutionSpread: d("0.1"),
    kellyFraction: d("0.25"),
    uncertaintyBoundWeight: d("0.5"),
    duplicateWindowMinutes: 5,
    minimumIndependentSources: 0,
    allowNakedShorts: false,
    emergencyExitEnabled: true,
    managedRestingBuyOrders: { enabled: false, maximumLifetimeMinutes: 5 },
  },
};
const context = (value) =>
  buildAgentContext({
    ...contextInput,
    riskConstraints: {
      ...contextInput.riskConstraints,
      ...(value === undefined ? {} : { allowPositionReductions: value }),
    },
  });
assert.deepEqual(context(undefined), context(true));
assert.equal(context(false).riskConstraints.allowPositionReductions, false);
const customPrompt = buildDecisionPrompt(context(false), {
  system: "Synthetic custom instructions.",
  user: "Custom context follows:\n{{CYCLE_CONTEXT}}",
});
assert.match(customPrompt.user, /"allowPositionReductions": false/u);
assert.match(customPrompt.user, /canonical SELL YES and SELL NO are disabled/u);
assert.match(customPrompt.user, /POSITION_REDUCTION_DISABLED/u);
const customLearning = {
  ...context(true).criticalLearning,
  positionManagementReminders: ["Synthetic custom policy reminder."],
};
const customPolicyContext = (allowPositionReductions) =>
  buildAgentContext({
    ...contextInput,
    criticalLearningPolicy: () => customLearning,
    riskConstraints: {
      ...contextInput.riskConstraints,
      allowPositionReductions,
    },
  });
assert.equal(customPolicyContext(true).criticalLearning, customLearning);
assert.equal(
  customPolicyContext(false).criticalLearning.positionManagementReminders[0],
  customLearning.positionManagementReminders[0],
);
assert.match(
  customPolicyContext(false).criticalLearning.positionManagementReminders.join(
    "\n",
  ),
  /POSITION_REDUCTION_DISABLED/u,
);

const market = {
  id: { exchange: "polymarket-us", value: "synthetic-market" },
  slug: "synthetic-market",
  title: "Synthetic market",
  description: "Synthetic test fixture.",
  settlementRules: "Settles from a synthetic result.",
  active: true,
  closed: false,
  archived: false,
  minimumTradeQuantity: d(1),
  priceTick: d("0.01"),
};
const previewCalls = [];
const exchange = {
  getOrderBook: async () => ({
    marketId: market.id,
    observedAt: now,
    yesBids: [{ price: d("0.45"), quantity: d(100) }],
    yesAsks: [{ price: d("0.55"), quantity: d(100) }],
  }),
  previewImmediateOrder: async (order) => {
    previewCalls.push(order);
    return {
      accepted: true,
      estimatedFees: d(0),
      warnings: [],
      rejectionReasons: [],
    };
  },
  createImmediateOrderFeeReserveEstimator: async () => () => d(0),
};
for (const allow of [undefined, true, false]) {
  const resolver = new AdvisoryTradePreviewResolver(
    exchange,
    new Map([[market.slug, market]]),
    allow,
  );
  for (const side of ["YES", "NO"]) {
    for (const action of ["BUY", "SELL"]) {
      const count = previewCalls.length;
      const request = {
        marketSlug: market.slug,
        side,
        action,
        quantity: d(1),
        limitPrice: d(action === "BUY" ? "0.6" : "0.4"),
      };
      if (allow === false && action === "SELL") {
        await assert.rejects(resolver.preview(request), {
          code: "POSITION_REDUCTION_DISABLED",
        });
        assert.equal(previewCalls.length, count);
      } else {
        const result = await resolver.preview(request);
        assert.equal(result.feePreview.accepted, true);
        assert.equal(result.action, action);
        assert.equal(result.side, side);
        assert.equal(previewCalls.length, count + 1);
      }
    }
  }
}

const disabledPreview = new AdvisoryTradePreviewResolver(
  exchange,
  new Map([[market.slug, market]]),
  false,
);
const prompts = await loadPromptBundle();
const researchTools = new DecisionResearchTools({
  prompts: prompts.research,
  marketDetails: [
    buildMarketDetailContext({
      market,
      held: true,
      account: contextInput.account,
    }),
  ],
  tradePreviewHandler: (request, signal) =>
    disabledPreview.preview(request, signal),
});
const session = researchTools.createSession(DEFAULT_DECISION_LIMITS);
for (const side of ["YES", "NO"]) {
  const result = await session.execute(
    "preview_trade",
    {
      marketSlug: market.slug,
      side,
      action: "SELL",
      quantity: "1",
      limitPrice: "0.4",
    },
    new globalThis.AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, "POSITION_REDUCTION_DISABLED");
  assert.equal(JSON.parse(result.content).code, "POSITION_REDUCTION_DISABLED");
}
assert.equal(researchTools.previewedMarketSlugs.size, 0);

const target = {
  marketSlug: market.slug,
  side: "NO",
  targetCostBasisFraction: d(0),
  estimatedProbability: d("0.2"),
  probabilityLowerBound: d("0.1"),
  probabilityUpperBound: d("0.3"),
  minimumExitPrice: d("0.1"),
  evidence: [],
  evidenceBundleIds: ["retained-bundle"],
};
const original = {
  cycleSummary: "Requested exit and independent buy.",
  portfolioTargets: [target],
  proposals: [],
  candidateDispositions: [],
  evidenceBundles: [
    { id: "retained-bundle", familyKey: "synthetic", sources: [] },
  ],
};
const independent = {
  ...target,
  marketSlug: "synthetic-independent",
  targetCostBasisFraction: d("0.05"),
  evidenceBundleIds: [],
};
const replacements = [[], [{ ...target, targetCostBasisFraction: d("0.2") }]];
for (const portfolioTargets of replacements) {
  const replacement = {
    ...original,
    portfolioTargets: [independent, ...portfolioTargets],
    candidateDispositions: [
      { marketSlug: market.slug, outcome: "HOLD_UNCHANGED" },
    ],
    evidenceBundles: [],
  };
  const retained = retainPositionReductionRequests(
    replacement,
    original,
    new Set([market.slug]),
  );
  assert.equal(
    retained.portfolioTargets.find((item) => item.marketSlug === market.slug),
    target,
  );
  assert.equal(retained.portfolioTargets[0], independent);
  assert.equal(retained.candidateDispositions.length, 0);
  assert.deepEqual(retained.evidenceBundles, original.evidenceBundles);
}
assert.equal(
  retainPositionReductionRequests(original, undefined, new Set()),
  original,
);

const sell = { marketSlug: market.slug, side: "NO", action: "SELL" };
const buy = { marketSlug: independent.marketSlug, side: "YES", action: "BUY" };
const materialized = { ...original, proposals: [sell, buy] };
const policyRejection = {
  proposal: sell,
  code: "POSITION_REDUCTION_DISABLED",
  reason: "Position reductions disabled.",
};
const feedback = (rejected) =>
  buildTerminalDecisionRepairFeedback(
    materialized,
    [sell, buy],
    {
      accepted: [],
      rejected,
    },
    0,
  );
assert.equal(isRepairableRiskRejection("POSITION_REDUCTION_DISABLED"), false);
assert.equal(isRepairableRiskRejection("EXCHANGE_ERROR"), false);
assert.equal(isRepairableRiskRejection("INSUFFICIENT_SOURCES"), true);
const policyOnly = feedback([policyRejection]);
assert.equal(
  policyOnly.rejectedProposals.some((item) => item.repairable),
  false,
);
const mixed = feedback([
  policyRejection,
  {
    proposal: buy,
    code: "INSUFFICIENT_SOURCES",
    reason: "Synthetic independent evidence issue.",
  },
]);
assert.deepEqual(
  mixed.rejectedProposals.map((item) => item.repairable),
  [false, true],
);
assert.match(
  mixed.instructions.join("\n"),
  /do not replace the blocked reduction with a hold/u,
);

const legacy = { ...original, portfolioTargets: [], proposals: [sell] };
const retainedLegacy = retainPositionReductionRequests(
  { ...legacy, proposals: [buy] },
  legacy,
  new Set([market.slug]),
);
assert.deepEqual(retainedLegacy.proposals, [buy, sell]);
process.stdout.write(
  "Position reduction context, custom prompt, preview, and repair-preservation checks passed.\n",
);
