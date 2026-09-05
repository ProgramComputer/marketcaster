import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { fetchEvidencePage } from "../src/agent/evidence-provenance.ts";
import { reconcilePortfolioTargets } from "../src/portfolio/target-reconciliation.ts";

// Offline responses only. A recognized source hostname must not trigger a
// second, unrequested fetch or combine another response with this URL's text.
const requestedUrl = "https://tabletennis.setkacup.com/fixture-page";
const requests = [];
const page = await fetchEvidencePage(requestedUrl, {
  lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchImplementation: async (url) => {
    requests.push(String(url));
    return new globalThis.Response(
      "<html><body>Synthetic original page claim.</body></html>",
      {
        headers: { "content-type": "text/html" },
      },
    );
  },
});
assert.deepEqual(requests, [requestedUrl]);
assert.equal(page.finalUrl, requestedUrl);
assert.equal(page.text, "Synthetic original page claim.");

const explicitUrl = "https://example.test/fixture-feed";
const explicitRequests = [];
const direct = await fetchEvidencePage(explicitUrl, {
  lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchImplementation: async (url) => {
    explicitRequests.push(String(url));
    return new globalThis.Response(
      '{"observation":"Synthetic explicit response"}',
      {
        headers: { "content-type": "application/json" },
      },
    );
  },
});
assert.deepEqual(explicitRequests, [explicitUrl]);
assert.equal(direct.finalUrl, explicitUrl);
assert.equal(direct.text, '{"observation":"Synthetic explicit response"}');

const decimal = (value = 0) => new Decimal(value);
const target = {
  marketSlug: "fixture-market",
  side: "YES",
  targetCostBasisFraction: decimal("0.1001"),
  estimatedProbability: decimal("0.5"),
  probabilityLowerBound: decimal("0.4"),
  probabilityUpperBound: decimal("0.6"),
  confidence: "LOW",
  thesis: "Synthetic target",
  settlementVerification: "Synthetic rules",
  invalidationConditions: "Synthetic condition",
  evidence: [],
};
const position = {
  marketId: { exchange: "kalshi", value: "fixture-market" },
  marketSlug: "fixture-market",
  side: "YES",
  quantity: decimal(20),
  availableQuantity: decimal(20),
  costBasis: decimal(10),
  realizedPnl: decimal(0),
  expired: false,
};
const input = {
  targets: [target],
  riskEquity: decimal(100),
  snapshot: { positions: [position] },
};
assert.equal(
  reconcilePortfolioTargets(input).dispositions[0].reason,
  "INCREASE_TO_TARGET",
  "No policy tolerance is assumed",
);
assert.equal(
  reconcilePortfolioTargets({
    ...input,
    targetRoundingToleranceUsd: decimal("0.01"),
  }).dispositions[0].reason,
  "TARGET_REACHED",
  "A supplied tolerance applies at exact equality",
);
assert.equal(
  reconcilePortfolioTargets({
    ...input,
    targetRoundingToleranceUsd: decimal("0.009"),
  }).dispositions[0].reason,
  "INCREASE_TO_TARGET",
);
assert.equal(
  reconcilePortfolioTargets({
    ...input,
    targets: [{ ...target, targetCostBasisFraction: decimal(0) }],
    targetRoundingToleranceUsd: decimal(100),
  }).dispositions[0].reason,
  "EXIT_TO_ZERO",
  "Tolerance never suppresses an explicit zero-target exit",
);
assert.throws(
  () =>
    reconcilePortfolioTargets({
      ...input,
      targetRoundingToleranceUsd: decimal(-1),
    }),
  /targetRoundingToleranceUsd/u,
);
assert.throws(
  () =>
    reconcilePortfolioTargets({
      ...input,
      targetRoundingToleranceUsd: decimal(Infinity),
    }),
  /targetRoundingToleranceUsd/u,
);
