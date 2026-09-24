/* global AbortController, console */
import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { auditNoPositiveEdgePasses } from "../dist/src/agent/pass-edge-audit.js";

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
