import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { buildMarketDetailContext } from "../dist/src/agent/context-builder.js";
import { resolveFinalPassResearchGate } from "../dist/src/agent/cycle.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import { DecisionResearchTools } from "../dist/src/llm/research-tools.js";
import { selectResearchContinuationCandidates } from "../dist/src/agent/opportunity-board.js";

// In-memory synthetic contracts only. No exchange or provider is instantiated.
const prompts = await loadPromptBundle();
const signal = new globalThis.AbortController().signal;
const at = new Date("2040-01-01T12:00:00Z");
const D = (value) => new Decimal(value);
const plan = {
  cycleSummary: "Synthetic no-order plan",
  portfolioTargets: [],
  candidateDispositions: [],
};
const requirements = {
  minimumDiscoveryRequests: 0,
  minimumDistinctDiscoveryModes: 0,
  minimumInspectedMarkets: 1,
  minimumDistinctEventFamilies: 1,
  minimumWebSearches: 0,
  minimumMarketAnalyses: 0,
  minimumTradePreviews: 0,
  maximumQualifiedSpread: D("0.1"),
};
function detail(slug, qualified = false, eventId = slug) {
  const market = {
    id: { exchange: "kalshi", value: slug },
    slug,
    eventId,
    title: `Synthetic ${slug}`,
    description: "Synthetic contract.",
    settlementRules: "Resolves from the synthetic official result.",
    active: true,
    closed: false,
    archived: false,
    minimumTradeQuantity: D(1),
    priceTick: D("0.01"),
  };
  return buildMarketDetailContext({
    market,
    held: false,
    account: { positions: [] },
    ...(qualified
      ? {
          bbo: {
            marketId: market.id,
            observedAt: at,
            yes: { bid: D("0.4"), ask: D("0.45") },
            no: {},
          },
        }
      : {}),
  });
}
const supplied = ["synthetic-first", "synthetic-second", "synthetic-third"];
const board = supplied.map((slug) => ({ slug }));
assert.deepEqual(selectResearchContinuationCandidates({}, board), []);
assert.deepEqual(
  selectResearchContinuationCandidates(
    {
      selectResearchContinuationMarketSlugs: () => [
        supplied[1],
        supplied[0],
        supplied[1],
      ],
    },
    board,
  ),
  [supplied[1], supplied[0]],
);
for (const invalid of [
  undefined,
  null,
  {},
  "synthetic-first",
  ["unknown"],
  [7],
]) {
  assert.throws(
    () =>
      selectResearchContinuationCandidates(
        { selectResearchContinuationMarketSlugs: () => invalid },
        board,
      ),
    /supplied board market slugs/u,
  );
}
function fixture(options = {}, limits = {}) {
  const tools = new DecisionResearchTools({
    prompts: prompts.research,
    candidateFamilies: supplied.map((marketSlug) => ({
      marketSlug,
      eventId: marketSlug,
    })),
    researchContinuationMarketSlugs: supplied,
    marketDetailsHandler: async (slug) => detail(slug),
    passResearchRequirements: requirements,
    ...options,
  });
  const session = tools.createSession({
    ...DEFAULT_DECISION_LIMITS,
    ...limits,
  });
  session.observeRound(false);
  return { tools, session };
}
async function inspect(session, slug) {
  const result = await session.execute(
    "get_market_details",
    { marketSlug: slug },
    signal,
  );
  assert.equal(result.isError, false, result.content);
}
const first = fixture();
await inspect(first.session, supplied[0]);
assert.equal(first.tools.strictPassResearchReadiness.inspectedMarkets, 1);
assert.equal(first.tools.strictPassResearchReadiness.qualifiedCandidates, 0);
assert.deepEqual(
  first.tools.strictPassResearchReadiness.continuation.pendingMarketSlugs,
  supplied.slice(1),
);
const blocked = await first.session.execute("submit_trade_plan", plan, signal);
assert.equal(blocked.errorCode, "PASS_RESEARCH_REQUIRED");
assert.match(blocked.content, /synthetic-second/u);
// The continuation list is not an inspection allowlist.
await inspect(first.session, "synthetic-outside-board");
assert.ok(first.tools.inspectedMarketSlugs.has("synthetic-outside-board"));
await inspect(first.session, supplied[1]);
await inspect(first.session, supplied[2]);
assert.equal(
  first.tools.strictPassResearchReadiness.status,
  "NO_QUALIFIED_CANDIDATES",
);
assert.equal(
  (await first.session.execute("submit_trade_plan", plan, signal)).kind,
  "DECISION",
);

// A qualified candidate keeps continuation and the ordinary research gate.
const qualified = fixture({
  marketDetailsHandler: async (slug) => detail(slug, true),
  passResearchRequirements: {
    ...requirements,
    minimumMarketAnalyses: 1,
    minimumTradePreviews: 1,
  },
});
await inspect(qualified.session, supplied[0]);
assert.deepEqual(
  qualified.tools.strictPassResearchReadiness.continuation.pendingMarketSlugs,
  supplied.slice(1),
);
assert.equal(qualified.tools.strictPassResearchReadiness.allowed, false);
assert.ok(
  qualified.tools.strictPassResearchReadiness.unmet.some((item) =>
    item.includes("trade preview"),
  ),
);

for (const [finalRound, maximumMarketDetailRequests, reason] of [
  [false, 1, "DETAIL_BUDGET_EXHAUSTED"],
  [true, 4, "FINAL_ROUND"],
]) {
  const bounded = fixture({}, { maximumMarketDetailRequests });
  await inspect(bounded.session, supplied[0]);
  bounded.session.observeRound(finalRound);
  assert.equal(
    bounded.tools.strictPassResearchReadiness.continuation.stopReason,
    reason,
  );
  assert.equal(
    (await bounded.session.execute("submit_trade_plan", plan, signal)).kind,
    "DECISION",
  );
  const final = resolveFinalPassResearchGate(
    0,
    bounded.tools.strictPassResearchReadiness,
  );
  assert.equal(final.readiness.status, "INCOMPLETE_NO_ORDERS");
  assert.match(final.warning, /Research coverage is incomplete/u);
  assert.ok(final.warning.includes(reason));
  assert.equal(bounded.tools.totalCounts.marketDetailRequests, 1);
}

// A partial family snapshot only covers returned members, not every sibling.
const family = fixture({
  marketFamilyDetailsHandler: async ({ marketSlug }) => ({
    seedMarketSlug: marketSlug,
    family: {
      key: "event:synthetic-family",
      kind: "EVENT",
      value: "synthetic-family",
      source: "EVENT_ID",
    },
    members: [
      detail(supplied[0], false, "synthetic-family"),
      detail(supplied[1], false, "synthetic-family"),
    ],
    discoveryBasis: "CATALOG_METADATA",
    membershipCompleteness: "PARTIAL",
    truncated: true,
    warnings: [],
  }),
});
const familyResult = await family.session.execute(
  "get_market_family_details",
  { marketSlug: supplied[0] },
  signal,
);
assert.equal(familyResult.isError, false, familyResult.content);
assert.deepEqual(
  family.tools.strictPassResearchReadiness.continuation.pendingMarketSlugs,
  [supplied[2]],
);

const defaultBehavior = fixture({ researchContinuationMarketSlugs: undefined });
await inspect(defaultBehavior.session, supplied[0]);
assert.equal(
  defaultBehavior.tools.strictPassResearchReadiness.status,
  "NO_QUALIFIED_CANDIDATES",
);
assert.equal(
  defaultBehavior.tools.strictPassResearchReadiness.continuation,
  undefined,
);
const noCandidates = fixture({
  candidateFamilies: [],
  researchContinuationMarketSlugs: [],
});
assert.equal(
  noCandidates.tools.strictPassResearchReadiness.status,
  "NO_CANDIDATES",
);
const unavailable = fixture({
  marketDetailsHandler: undefined,
  passResearchRequirements: {
    ...requirements,
    minimumInspectedMarkets: 0,
    minimumDistinctEventFamilies: 0,
  },
});
assert.equal(
  unavailable.tools.strictPassResearchReadiness.continuation.stopReason,
  "DETAILS_UNAVAILABLE",
);
assert.equal(
  (await unavailable.session.execute("submit_trade_plan", plan, signal)).kind,
  "DECISION",
);
for (const invalid of [null, {}, "synthetic-first", ["unknown"], [7]]) {
  assert.throws(
    () => fixture({ researchContinuationMarketSlugs: invalid }),
    /supplied candidate market slugs/u,
  );
}
