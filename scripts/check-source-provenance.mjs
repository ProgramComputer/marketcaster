import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { buildMarketDetailContext } from "../dist/src/agent/context-builder.js";
import { fetchEvidencePage } from "../dist/src/agent/evidence-provenance.js";
import { MarketFamilyResolver } from "../dist/src/agent/market-family-resolver.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import {
  DecisionResearchTools,
  selectEvidenceSourceText,
} from "../dist/src/llm/research-tools.js";
import { PolymarketMarketSchema } from "../dist/src/exchanges/polymarket-us/schemas.js";
import { mapMarket as mapPolymarketMarket } from "../dist/src/exchanges/polymarket-us/mappers.js";
import { KalshiMarketSchema } from "../dist/src/exchanges/kalshi/schemas.js";
import { mapMarket as mapKalshiMarket } from "../dist/src/exchanges/kalshi/mappers.js";

// Wholly synthetic responses; these checks never connect to a source or exchange.
const url = "https://example.com/synthetic-source";
const published = "2040-01-01T05:00:00Z";
const modified = "2040-01-01T06:00:00Z";
const source = `<meta content="${published}" property="article:published_time">
<script type="application/ld+json">{"dateModified":"${modified}"}</script>
<time datetime="2040-01-02T08:00:00Z">An event time, not publication</time>
<time datetime="2040-01-02T09:00:00">A time with no zone</time>
<pre>Item | Value | Unit\nalpha | 12 | widgets\nbeta | 17 | widgets</pre>`;
const options = (body) => ({
  lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchImplementation: async () =>
    new globalThis.Response(body, {
      headers: {
        "content-type": "text/html",
        "last-modified": "Sun, 01 Jan 2040 06:30:00 GMT",
      },
    }),
});
const page = await fetchEvidencePage(url, options(source));
assert.equal(page.publishedAt, "2040-01-01T05:00:00.000Z");
assert.equal(
  page.sourceTimestamps.find((entry) => entry.role === "MODIFICATION")
    .timestamp,
  "2040-01-01T06:00:00.000Z",
);
assert.equal(
  page.sourceTimestamps.find(
    (entry) => entry.rawValue === "2040-01-02T09:00:00",
  ).timestamp,
  undefined,
);
assert.equal(
  page.sourceTimestamps.find((entry) => entry.field === "time.datetime").role,
  "UNSPECIFIED",
);
assert.ok(
  Date.parse(page.retrieval.fetchedAt) >=
    Date.parse(page.retrieval.fetchStartedAt),
);
assert.equal(page.retrieval.requestedUrl, url);
assert.equal(
  page.retrieval.decodedBodySha256,
  createHash("sha256").update(source).digest("hex"),
);
assert.equal(
  page.retrieval.extractedTextSha256,
  createHash("sha256").update(page.text).digest("hex"),
);
const generic = await fetchEvidencePage(
  url,
  options('<time datetime="2040-01-02T08:00:00Z">Event</time>'),
);
assert.equal(
  generic.publishedAt,
  undefined,
  "A generic time element cannot authorize a publication-date claim",
);
assert.notEqual(
  generic.retrieval.fetchId,
  page.retrieval.fetchId,
  "Separate fetches have distinct identities, even at the same URL",
);

const prompts = await loadPromptBundle();
let reads = 0;
const tools = new DecisionResearchTools({
  prompts: prompts.research,
  evidencePageReader: async () => {
    reads += 1;
    return page;
  },
});
const session = tools.createSession({
  ...DEFAULT_DECISION_LIMITS,
  maximumEvidenceSourceReadRequests: 1,
});
const discoveredAt = "2039-12-31T00:00:00Z";
tools.recordProviderEvidenceSources([
  {
    url,
    title: "Synthetic source",
    observedAt: discoveredAt,
    provider: "CLIENT_WEB_SEARCH",
  },
]);
for (const [index, find] of ["alpha", "beta"].entries()) {
  const result = await session.execute(
    "read_evidence_source",
    { url, find },
    new globalThis.AbortController().signal,
  );
  assert.equal(result.isError, false);
  const content = JSON.parse(result.content);
  assert.equal(content.discoveredAt, "2039-12-31T00:00:00.000Z");
  assert.deepEqual(
    content.retrieval,
    page.retrieval,
    "Cached selection retains the original fetch identity and time",
  );
  assert.deepEqual(content.sourceTimestamps, page.sourceTimestamps);
  assert.equal(content.reusedSnapshot, index > 0);
}
assert.equal(reads, 1);
assert.deepEqual(tools.observedEvidenceSources[0].retrieval, page.retrieval);

const longSource = `HEADER | UNITS\n${"Unrelated context\n".repeat(1200)}needle | 31 | items${"\nFooter context".repeat(1200)}`;
const selection = selectEvidenceSourceText(longSource, "needle");
assert.equal(selection.textCoverage, "PARTIAL_EXTRACTED_TEXT");
assert.ok(
  selection.textRanges[0].start > 0,
  "A query excerpt must not imply coverage of the header",
);
assert.equal(
  selection.text,
  selection.textRanges
    .map(({ start, end }) => longSource.slice(start, end))
    .join("\n...\n"),
);
assert.equal(
  selectEvidenceSourceText("small source", null).textCoverage,
  "FULL_EXTRACTED_TEXT",
);

const rawMarket = {
  id: "101",
  slug: "synthetic-item-a",
  title: "Synthetic item A",
  description: "Description fallback.",
  active: true,
  closed: false,
  archived: false,
  priceTick: "0.01",
  minimumTradeQuantity: "1",
};
const map = (extra = {}) =>
  mapPolymarketMarket(PolymarketMarketSchema.parse({ ...rawMarket, ...extra }));
const fallback = map();
assert.deepEqual(fallback.settlementRulesProvenance, {
  sourceFields: ["description"],
  origin: "DESCRIPTION_FALLBACK",
  completeness: "UNKNOWN",
});
const disclaimer = map({ rulesDisclaimer: "Auxiliary disclaimer." });
assert.equal(
  disclaimer.settlementRulesProvenance.origin,
  "DISCLAIMER_FALLBACK",
);
const explicit = map({
  settlementRules: "Primary rule.",
  resolutionRules: "Other rule.",
});
assert.equal(explicit.settlementRules, "Primary rule.");
assert.deepEqual(explicit.settlementRulesProvenance.sourceFields, [
  "settlementRules",
]);
assert.equal(explicit.settlementRulesProvenance.completeness, "UNKNOWN");
const detail = buildMarketDetailContext({
  market: fallback,
  held: false,
  account: { positions: [] },
});
assert.deepEqual(
  detail.settlementRulesProvenance,
  fallback.settlementRulesProvenance,
);
const detailTools = new DecisionResearchTools({
  prompts: prompts.research,
  marketDetailsHandler: async () => detail,
});
const detailSession = detailTools.createSession(DEFAULT_DECISION_LIMITS);
const detailResult = await detailSession.execute(
  "get_market_details",
  { marketSlug: fallback.slug },
  new globalThis.AbortController().signal,
);
assert.equal(detailResult.isError, false);
assert.deepEqual(
  JSON.parse(detailResult.content).market.settlementRulesProvenance,
  fallback.settlementRulesProvenance,
  "Rule origin survives the adapter, context builder and strict tool-result schema",
);
const kalshi = mapKalshiMarket(
  KalshiMarketSchema.parse({
    ticker: "SYNTHETIC-A",
    event_ticker: "SYNTHETIC",
    market_type: "binary",
    status: "open",
    rules_primary: "Primary rule.",
    rules_secondary: "Secondary rule.",
    early_close_condition: "Auxiliary condition.",
  }),
);
assert.deepEqual(kalshi.settlementRulesProvenance.sourceFields, [
  "rules_primary",
  "rules_secondary",
  "early_close_condition",
]);

const catalog = (markets) => ({
  markets,
  bySlug: new Map(markets.map((market) => [market.slug, market])),
  heldSlugs: new Set(),
});
const exchange = (markets, group) => ({
  getMarketBySlug: async (slug) => {
    const market = markets.find((item) => item.slug === slug);
    if (market === undefined) throw new Error("Synthetic missing member");
    return market;
  },
  getBbo: async () => {
    throw new Error("Synthetic unavailable quote");
  },
  ...(group === undefined ? {} : { listMarketGroupMembers: group }),
});
const seedOnly = await new MarketFamilyResolver(
  exchange([fallback]),
  catalog([fallback]),
).resolve(fallback);
assert.equal(seedOnly.family.source, "MARKET_SLUG");
assert.equal(
  seedOnly.membershipCompleteness,
  "UNKNOWN",
  "Seed-only fallback does not establish independent-event coverage",
);
const seed = map({ eventId: "synthetic-event" });
const member = map({
  id: "102",
  slug: "synthetic-item-b",
  eventId: "synthetic-event",
});
const complete = await new MarketFamilyResolver(
  exchange([seed, member], async () => ({
    items: [seed.slug, member.slug],
    eof: true,
  })),
  catalog([seed]),
).resolve(seed);
assert.equal(complete.membershipCompleteness, "EXCHANGE_GROUP_ENUMERATED");
const partial = await new MarketFamilyResolver(
  exchange([seed], async () => ({
    items: [seed.slug, member.slug],
    eof: true,
  })),
  catalog([seed]),
).resolve(seed);
assert.equal(
  partial.membershipCompleteness,
  "PARTIAL",
  "A failed detail read makes membership coverage partial despite EOF",
);
const cursorMissing = await new MarketFamilyResolver(
  exchange([seed], async () => ({ items: [seed.slug], eof: false })),
  catalog([seed]),
).resolve(seed);
assert.equal(cursorMissing.membershipCompleteness, "PARTIAL");

const groupingMarkets = [
  seed,
  member,
  map({
    id: "103",
    slug: "synthetic-series-member",
    seriesId: "synthetic-series",
  }),
  map({ id: "106", slug: "synthetic-fallback-a" }),
  map({ id: "104", slug: "synthetic-fallback-b" }),
  map({
    id: "105",
    slug: "synthetic-alias-member",
    eventId: "synthetic-event",
  }),
];
const groupingTools = new DecisionResearchTools({
  prompts: prompts.research,
  candidateFamilies: groupingMarkets.map((market) => ({
    marketSlug: market.slug,
    eventId: market.eventId,
    seriesId: market.seriesId,
  })),
  researchFamilyAliases: new Map([
    ["synthetic-alias-member", "scout:synthetic-alias"],
  ]),
  marketDetailsHandler: async (slug) =>
    buildMarketDetailContext({
      market: groupingMarkets.find((market) => market.slug === slug),
      held: false,
      account: { positions: [] },
    }),
  passResearchRequirements: {
    minimumDiscoveryRequests: 0,
    minimumDistinctDiscoveryModes: 0,
    minimumInspectedMarkets: 0,
    minimumDistinctEventFamilies: 5,
    minimumWebSearches: 0,
    minimumMarketAnalyses: 0,
    minimumTradePreviews: 0,
    maximumQualifiedSpread: new Decimal("0.1"),
  },
});
const groupingSession = groupingTools.createSession(DEFAULT_DECISION_LIMITS);
assert.equal(groupingTools.strictPassResearchReadiness.allowed, false);
for (const market of groupingMarkets) {
  const result = await groupingSession.execute(
    "get_market_details",
    { marketSlug: market.slug },
    new globalThis.AbortController().signal,
  );
  assert.equal(result.isError, false);
}
const readiness = groupingTools.strictPassResearchReadiness;
assert.equal(
  readiness.allowed,
  true,
  "The configured legacy research gate is unchanged",
);
assert.equal(readiness.requiredDistinctEventFamilies, 5);
assert.equal(readiness.inspectedDistinctEventFamilies, 5);
assert.equal(readiness.groupingDiagnostics.nativeEventGroups, 1);
assert.equal(readiness.groupingDiagnostics.nativeSeriesGroups, 1);
assert.equal(readiness.groupingDiagnostics.marketFallbackGroups, 2);
assert.equal(readiness.groupingDiagnostics.advisoryAliasGroups, 1);
assert.equal(readiness.groupingDiagnostics.inspectedMarkets.length, 6);
assert.equal(
  readiness.groupingDiagnostics.legacyGateCountBasis,
  "RESEARCH_GROUP_KEYS_NOT_INDEPENDENT_EVENTS",
);
globalThis.console.log(
  "Synthetic source, settlement-rule and native-family provenance checks passed",
);
