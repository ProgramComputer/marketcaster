import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Decimal } from "decimal.js";
import {
  buildTerminalDecisionRepairFeedback,
  isRepairableRiskRejection,
} from "../dist/src/agent/decision-repair.js";
import { discoverMarketCatalog } from "../dist/src/agent/discovery.js";
import { RepositoryConfigSchema } from "../dist/src/config/schema.js";
import { PolymarketUsExchange } from "../dist/src/exchanges/polymarket-us/adapter.js";
import { validateProposals } from "../dist/src/risk/validate.js";

// Synthetic listings replayed through the real adapter; no network access.
const snapshot = { positions: [] };
const base = Date.parse("2026-01-01T00:00:00.000Z");
const raw = (index, category = index % 3 === 0 ? "group-a" : "group-b") => ({
  id: String(index + 1),
  slug: `synthetic-${index}`,
  title: `Synthetic market ${index}`,
  settlementRules: "YES if the synthetic condition is met; otherwise NO.",
  priceTick: "0.01",
  minimumTradeQuantity: "1",
  active: true,
  closed: false,
  archived: false,
  category,
  endDate: new Date(base + index * 3_600_000).toISOString(),
});

function scripted(respond) {
  const requests = [];
  const exchange = new PolymarketUsExchange({
    client: {
      markets: {
        list: async (params) => {
          const key = JSON.stringify({ ...params, limit: undefined });
          const call = requests.filter((r) => r.key === key).length;
          requests.push({ key, ...params });
          return respond(params, call);
        },
      },
    },
    targetRequestsPerSecond: 1_000_000,
  });
  return { exchange, requests };
}

const TOTAL = 23;
const universe = Array.from({ length: TOTAL }, (_, index) => raw(index));
const page = (rows, { offset, limit }) => rows.slice(offset, offset + limit);
// Stable order by id; the volume order repeats some rows and skips others.
const stable = (params) =>
  page(
    universe.filter(
      (row) =>
        params.categories === undefined ||
        params.categories.includes(row.category),
    ),
    params,
  );
// Page k starts one row before offset k*limit, so each boundary row repeats,
// and the list ends early with a short page: eight markets are never listed.
const unstableVolume = ({ offset, limit }) => {
  const start = offset - offset / limit;
  return universe
    .slice()
    .reverse()
    .slice(start, start + (offset >= 15 ? 3 : limit));
};

const load = (exchange, options = {}) =>
  discoverMarketCatalog(exchange, snapshot, {
    pageSize: 5,
    maximumConcurrentPages: 4,
    verificationDelaysMilliseconds: [0, 0, 0],
    membershipOrder: { orderBy: ["id"], orderDirection: "asc" },
    rankingOrder: { orderBy: ["volume"], orderDirection: "desc" },
    ...options,
  });

test("an unstable ranking order cannot drop members", async () => {
  const { exchange } = scripted((params) =>
    params.orderBy?.[0] === "volume" ? unstableVolume(params) : stable(params),
  );
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, TOTAL);
  assert.equal(new Set(catalog.markets.map((m) => m.slug)).size, TOTAL);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
  // Ranked members come first, in ranking order.
  assert.equal(catalog.markets[0].slug, `synthetic-${TOTAL - 1}`);
  assert.equal(catalog.exchangeRanks.get(`synthetic-${TOTAL - 1}`), 1);
  const ranking = catalog.acquisition.segments.find(
    (s) => s.kind === "RANKING",
  );
  assert.equal(ranking.affectsCoverage, false);
  assert.equal(ranking.coverage, "DEGRADED");
  assert(catalog.warnings.some((w) => w.startsWith("CATALOG_RANKING_PARTIAL")));
  assert(!catalog.warnings.some((w) => w.startsWith("CATALOG_COVERAGE")));
  assert.equal(catalog.exchangeRankingBasis, "VOLUME_DESC");
});

test("membership churn within tolerance is recovered from the ranking list", async () => {
  // A market closes mid-scan: the next page shifts, repeating one row and
  // skipping synthetic-10, which the ranking list still returns.
  const churned = universe.filter((row) => row.slug !== "synthetic-10");
  const { exchange } = scripted((params) => {
    if (params.orderBy?.[0] === "volume") return page(universe, params);
    return params.offset < 10
      ? page(universe, params)
      : churned.slice(params.offset - 1, params.offset - 1 + params.limit);
  });
  const catalog = await load(exchange);
  assert.equal(catalog.acquisition.duplicateRowCount, 1);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
  assert(catalog.bySlug.has("synthetic-10"));
  const ranking = catalog.acquisition.segments.find(
    (s) => s.kind === "RANKING",
  );
  assert.equal(ranking.addedMarketCount, 1);
  assert(
    catalog.warnings.some((w) =>
      w.startsWith("CATALOG_LISTING_CHANGED_DURING_SCAN"),
    ),
  );
});

test("membership repeats beyond tolerance still degrade coverage", async () => {
  // Every page restarts one row early: an unstable order, not churn.
  const large = Array.from({ length: 400 }, (_, index) => raw(index));
  const { exchange } = scripted(({ offset, limit, orderBy }) => {
    if (orderBy?.[0] === "volume") return page(large, { offset, limit });
    const start = Math.max(0, offset - offset / limit);
    return large.slice(start, Math.min(start + limit, 320));
  });
  const catalog = await load(exchange);
  assert(catalog.acquisition.duplicateRowCount > 50);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.deepEqual(
    catalog.acquisition.diagnostics.map((d) => d.code),
    ["DUPLICATE_ROWS_ACROSS_PAGES"],
  );
});

test("a ranking order requires a membership order", async () => {
  const { exchange } = scripted(stable);
  await assert.rejects(
    load(exchange, { membershipOrder: undefined }),
    /rankingOrder requires a stable membershipOrder/,
  );
});

test("a required category listing is merged and counted", async () => {
  // The membership list loses its last page; the category listing is intact.
  const { exchange } = scripted((params) =>
    params.categories === undefined && params.offset >= 20
      ? { markets: [], eof: true }
      : stable(params),
  );
  const catalog = await load(exchange, {
    rankingOrder: undefined,
    supplements: { categories: ["group-a"] },
  });
  const category = catalog.acquisition.segments.find(
    (s) => s.kind === "CATEGORY",
  );
  assert.equal(category.key, "group-a");
  assert.equal(category.coverage, "COMPLETE");
  assert.equal(category.addedMarketCount, 1);
  assert(catalog.bySlug.has("synthetic-21"));
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
});

test("a failed required listing degrades coverage without aborting discovery", async () => {
  const { exchange } = scripted((params) => {
    if (params.categories !== undefined) throw new Error("upstream failure");
    return stable(params);
  });
  const catalog = await load(exchange, {
    rankingOrder: undefined,
    supplements: { categories: ["group-a"] },
  });
  assert.equal(catalog.markets.length, TOTAL);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.deepEqual(
    catalog.acquisition.diagnostics.map((d) => d.code),
    ["CATALOG_SUPPLEMENT_INCOMPLETE"],
  );
  assert.equal(catalog.acquisition.segments[0].coverage, "FAILED");
  assert(
    catalog.warnings.some((w) => w.startsWith("CATALOG_COVERAGE_DEGRADED")),
  );
});

test("a close-time listing stops at its horizon", async () => {
  const { exchange, requests } = scripted(stable);
  const catalog = await load(exchange, {
    rankingOrder: undefined,
    supplements: {
      closingWithin: {
        hours: 7,
        now: new Date(base),
        order: { orderBy: ["end_date"], orderDirection: "asc" },
      },
    },
  });
  const closing = catalog.acquisition.segments.find(
    (s) => s.kind === "CLOSING_SOON",
  );
  assert.equal(closing.coverage, "COMPLETE");
  assert.equal(closing.stopReason, "HORIZON");
  // Rows close hourly; the third page of five lies wholly beyond seven hours.
  assert.equal(requests.filter((r) => r.orderBy?.[0] === "end_date").length, 4);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
});

test("a close-time listing out of order is degraded", async () => {
  const { exchange } = scripted((params) =>
    params.orderBy?.[0] === "end_date"
      ? page(universe.slice().reverse(), params)
      : stable(params),
  );
  const catalog = await load(exchange, {
    rankingOrder: undefined,
    supplements: {
      closingWithin: {
        hours: 30,
        now: new Date(base),
        order: { orderBy: ["end_date"], orderDirection: "asc" },
      },
    },
  });
  const closing = catalog.acquisition.segments.find(
    (s) => s.kind === "CLOSING_SOON",
  );
  assert.equal(closing.coverage, "DEGRADED");
  assert.deepEqual(
    closing.diagnostics.map((d) => d.code),
    ["LIST_ORDER_NOT_MONOTONIC"],
  );
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
});

test("an exchange without close-time ordering reports the supplement unsupported", async () => {
  const { exchange } = scripted(stable);
  const catalog = await load(exchange, {
    rankingOrder: undefined,
    supplements: { closingWithin: { hours: 7, now: new Date(base) } },
  });
  assert.equal(catalog.acquisition.segments[0].coverage, "UNSUPPORTED");
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
});

test("configuration accepts supplements and the degraded-catalog policy", async () => {
  const defaults = JSON.parse(await readFile("config/default.json", "utf8"));
  const parsed = RepositoryConfigSchema.parse({
    ...defaults,
    marketSelection: {
      ...defaults.marketSelection,
      catalogSupplements: { categories: ["group-a"], closingWithinHours: 48 },
      degradedCatalogPolicy: "BLOCK_NEW_ENTRIES",
    },
  });
  assert.equal(
    parsed.marketSelection.degradedCatalogPolicy,
    "BLOCK_NEW_ENTRIES",
  );
  for (const marketSelection of [
    { catalogSupplements: { categories: [] } },
    { catalogSupplements: { categories: ["a", "a"] } },
    { catalogSupplements: { closingWithinHours: 0 } },
    { catalogSupplements: { unknown: true } },
    { degradedCatalogPolicy: "IGNORE" },
  ]) {
    assert.throws(() =>
      RepositoryConfigSchema.parse({
        ...defaults,
        marketSelection: { ...defaults.marketSelection, ...marketSelection },
      }),
    );
  }
  assert.equal(
    RepositoryConfigSchema.parse(defaults).marketSelection
      .degradedCatalogPolicy,
    undefined,
  );
});

// Minimal in-memory validation fixture.
const now = new Date("2026-01-01T12:00:00.000Z");
const D = (value) => new Decimal(value);
const account = (positions) => ({
  observedAt: now,
  currentBalance: D(100),
  buyingPower: D(100),
  assetNotional: D(0),
  assetAvailable: D(0),
  openOrderValue: D(0),
  unsettledFunds: D(0),
  marginRequirement: D(0),
  positions,
  openOrders: [],
  recentActivities: [],
});
const held = {
  marketId: { exchange: "polymarket-us", value: "held-market" },
  marketSlug: "held-market",
  side: "YES",
  quantity: D(10),
  availableQuantity: D(10),
  costBasis: D(5),
  realizedPnl: D(0),
  expired: false,
};
const fixtureExchange = {
  id: "polymarket-us",
  async getMarketBySlug(slug) {
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
  async previewImmediateOrder() {
    return {
      accepted: true,
      estimatedFees: D(0),
      warnings: [],
      rejectionReasons: [],
    };
  },
};
const proposal = (marketSlug) => ({
  marketSlug,
  side: "YES",
  action: "BUY",
  estimatedProbability: D("0.9"),
  probabilityLowerBound: D("0.9"),
  probabilityUpperBound: D("0.9"),
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
});
const defaults = RepositoryConfigSchema.parse(
  JSON.parse(await readFile("config/default.json", "utf8")),
);
const validate = (extra) =>
  validateProposals({
    proposals: [proposal("new-market"), proposal("held-market")],
    snapshot: account([held]),
    valuation: {
      exchangeReportedValue: D(100),
      arenaAccountValue: D(100),
      riskEquity: D(100),
      spendableCapital: D(100),
      positions: [],
      warnings: [],
    },
    exchange: fixtureExchange,
    policy: {
      ...defaults.risk,
      maximumPositionCostBasisFraction: D("0.5"),
      maximumCycleSpendFraction: D("0.5"),
      maximumExecutionSpread: D("0.1"),
      kellyFraction: D(1),
      minimumIndependentSources: 1,
      emergencyExitEnabled: false,
    },
    allocationPolicy: ({ candidates }) =>
      candidates.map((candidate) => ({
        id: candidate.id,
        spend: candidate.minimumSpend,
      })),
    now,
    ...extra,
  });

test("blocked new entries refuse only markets without a position", async () => {
  const reason = "catalog coverage is incomplete";
  const blocked = await validate({ newEntriesBlocked: { reason } });
  assert.deepEqual(
    blocked.rejected.map((r) => [r.proposal.marketSlug, r.code, r.reason]),
    [["new-market", "NEW_ENTRIES_BLOCKED", reason]],
  );
  assert.deepEqual(
    blocked.accepted.map((a) => a.proposal.marketSlug),
    ["held-market"],
  );
  const open = await validate({});
  assert(!open.rejected.some((r) => r.code === "NEW_ENTRIES_BLOCKED"));
  assert(open.accepted.some((a) => a.proposal.marketSlug === "new-market"));
});

test("blocked new entries are not a repair opportunity", async () => {
  assert.equal(isRepairableRiskRejection("NEW_ENTRIES_BLOCKED"), false);
  const proposals = [proposal("new-market")];
  const feedback = buildTerminalDecisionRepairFeedback(
    { proposals, portfolioTargets: [], candidateDispositions: [] },
    proposals,
    {
      accepted: [],
      rejected: [
        { proposal: proposals[0], code: "NEW_ENTRIES_BLOCKED", reason: "x" },
      ],
      committedCycleSpend: D(0),
    },
    1,
  );
  assert.equal(feedback, undefined);
});
