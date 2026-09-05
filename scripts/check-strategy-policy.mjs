import { log } from "node:console";
const { AbortController } = globalThis;
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import { nearTouchBuyNotional } from "../dist/src/execution/depth.js";
import { allocateBatchBudget } from "../dist/src/risk/batch-allocation.js";
import {
  loadStrategyPolicy,
  assertStrategyPolicy,
  refreshPolicyForecasts,
} from "../dist/src/strategy/policy.js";

const book = {
  yesAsks: [
    { price: new Decimal("0.4"), quantity: new Decimal(3) },
    { price: new Decimal("0.7"), quantity: new Decimal(9) },
  ],
  yesBids: [{ price: new Decimal("0.6"), quantity: new Decimal(4) }],
};
assert.equal(
  nearTouchBuyNotional(book, "YES", new Decimal(0)).toString(),
  "1.2",
);
assert.equal(
  nearTouchBuyNotional(book, "NO", new Decimal(0)).toString(),
  "1.6",
);
assert.equal(
  nearTouchBuyNotional(
    book,
    "YES",
    new Decimal("0.4"),
    new Decimal("0.5"),
  ).toString(),
  "1.2",
);
assert.throws(() => nearTouchBuyNotional(book, "YES", new Decimal(-1)));
const candidate = {
  id: "synthetic",
  conservativeNetEdge: new Decimal("0.02"),
  minimumSpend: new Decimal(1),
  maximumSpend: new Decimal(3),
};
const input = { cycleBudget: new Decimal(2), candidates: [candidate] };
assert.equal(allocateBatchBudget(input).committedSpend.toString(), "0");
const result = allocateBatchBudget({
  ...input,
  allocationPolicy: () => [{ id: candidate.id, spend: new Decimal("1.5") }],
});
assert.equal(result.committedSpend.toString(), "1.5");
assert.equal(result.unallocatedSpend.toString(), "0.5");
assert.equal(result.allocations[0].candidate, candidate);
for (const instructions of [
  [{ id: "unknown", spend: new Decimal(1) }],
  [{ id: candidate.id, spend: new Decimal("0.5") }],
  [{ id: candidate.id, spend: new Decimal(3) }],
  [{ id: candidate.id, spend: new Decimal("NaN") }],
  [
    { id: candidate.id, spend: new Decimal(1) },
    { id: candidate.id, spend: new Decimal(1) },
  ],
])
  assert.throws(() =>
    allocateBatchBudget({ ...input, allocationPolicy: () => instructions }),
  );
assert.throws(() =>
  allocateBatchBudget({ ...input, candidates: [candidate, candidate] }),
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "marketcaster-policy-"),
);
try {
  await assert.rejects(
    loadStrategyPolicy(join(temporaryDirectory, "missing.mjs")),
  );
  const invalid = join(temporaryDirectory, "invalid.mjs");
  await writeFile(invalid, "export default () => ({apiVersion: 999});\n");
  await assert.rejects(loadStrategyPolicy(invalid), /version 1/);
  const valid = join(temporaryDirectory, "valid.mjs");
  await writeFile(
    valid,
    "export default api => ({apiVersion:1, selection:{buildOpportunityBoard:()=>[], buildEnrichedOpportunityBoard:async()=>[], selectRequiredMarketSlugs:()=>[]}, allocation:()=>[], passAuditMinimumEdge:new api.Decimal(0)});\n",
  );
  const strategy = await loadStrategyPolicy(valid);
  assert.equal(strategy.apiVersion, 1);
  assert.equal(strategy.allocation(input).length, 0);
  for (const invalid of [
    { ...strategy, selection: { ...strategy.selection, allowWebSearch: 7 } },
    {
      ...strategy,
      selection: { ...strategy.selection, depthPriceBand: new Decimal(-1) },
    },
    {
      ...strategy,
      selection: { ...strategy.selection, experimentDefinition: {} },
    },
    { ...strategy, executionCooldownMilliseconds: { NO_FILL: -1 } },
    { ...strategy, reconciliationTolerance: 7 },
  ])
    assert.throws(() => assertStrategyPolicy(invalid));
  const requests = [{ marketSlug: "synthetic", side: "YES" }];
  for (const point of [
    new Decimal("NaN"),
    new Decimal("Infinity"),
    new Decimal(-1),
    new Decimal(2),
  ]) {
    await assert.rejects(
      refreshPolicyForecasts(
        {
          refreshForecasts: async () => ({
            requiredMarketSlugs: new Set(["synthetic"]),
            selectedSideProbabilityByMarketSlug: new Map([
              ["synthetic", point],
            ]),
          }),
        },
        requests,
        new Map(),
        new Date(),
        new AbortController().signal,
      ),
      /finite probabilities/,
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
log("Strategy loader and allocation boundary checks passed");
