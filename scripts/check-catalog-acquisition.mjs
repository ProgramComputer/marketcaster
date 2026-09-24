import assert from "node:assert/strict";
import test from "node:test";
import { discoverMarketCatalog } from "../dist/src/agent/discovery.js";
import { PolymarketUsExchange } from "../dist/src/exchanges/polymarket-us/adapter.js";

// Synthetic recorded response sequences replayed through the real adapter.
const snapshot = { positions: [] };
const raw = (index) => ({
  id: String(index + 1),
  slug: `synthetic-${index}`,
  title: `Synthetic market ${index}`,
  settlementRules: "YES if the synthetic condition is met; otherwise NO.",
  priceTick: "0.01",
  minimumTradeQuantity: "1",
  active: true,
  closed: false,
  archived: false,
});

function scripted(respond) {
  const requests = [];
  const exchange = new PolymarketUsExchange({
    client: {
      markets: {
        list: async (params) => {
          const call = requests.filter(
            (r) => r.offset === params.offset,
          ).length;
          requests.push({ offset: params.offset, limit: params.limit });
          return respond(params, call);
        },
      },
    },
    targetRequestsPerSecond: 1_000_000,
  });
  return { exchange, requests };
}

const rows = (from, to) =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => raw(from + i));
// A catalogue of `total` rows served in exchange order, without an end marker.
const catalogue =
  (total, { cap = Number.POSITIVE_INFINITY, transient = new Set() } = {}) =>
  ({ offset, limit }, call) =>
    offset >= cap || (transient.has(offset) && call === 0)
      ? []
      : rows(offset, Math.min(total, offset + limit));

const load = (exchange, options = {}) =>
  discoverMarketCatalog(exchange, snapshot, {
    pageSize: 5,
    maximumConcurrentPages: 4,
    ...options,
  });

test("adapter records whether the end came from the response or a short page", async () => {
  for (const [body, expected] of [
    [rows(0, 5), { eof: false }],
    [rows(0, 2), { eof: true, eofSource: "SHORT_PAGE" }],
    [
      { markets: rows(0, 5), eof: true },
      { eof: true, eofSource: "RESPONSE" },
    ],
    [
      { markets: [], eof: true },
      { eof: true, eofSource: "RESPONSE" },
    ],
  ]) {
    const { exchange } = scripted(() => body);
    const page = await exchange.listMarkets({ limit: 5, offset: 0 });
    assert.equal(page.eof, expected.eof);
    assert.equal(page.eofSource, expected.eofSource);
  }
});

test("a complete scan ending on a short page is COMPLETE", async () => {
  const { exchange, requests } = scripted(catalogue(17));
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 17);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
  assert.equal(catalog.acquisition.stopReason, "SHORT_PAGE");
  assert.deepEqual(catalog.acquisition.diagnostics, []);
  assert.equal(requests.length, 4);
  assert(!catalog.warnings.some((w) => w.startsWith("CATALOG_COVERAGE")));
  assert.deepEqual(
    catalog.acquisition.pages.map((p) => [p.offset, p.returnedCount, p.eof]),
    [
      [0, 5, false],
      [5, 5, false],
      [10, 5, false],
      [15, 2, true],
    ],
  );
});

test("an upstream stop at a batch boundary is verified and reported, not silent", async () => {
  // Four full pages, then an empty page with no end marker at a batch boundary.
  const { exchange, requests } = scripted(catalogue(40, { cap: 20 }));
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 20);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.deepEqual(
    catalog.acquisition.diagnostics.map((d) => d.code),
    ["EMPTY_TERMINAL_PAGE_AT_PAGE_BOUNDARY"],
  );
  assert.equal(catalog.acquisition.stopReason, "EMPTY_PAGE");
  assert.equal(requests.filter((r) => r.offset === 20).length, 2);
  assert.equal(requests.length, 9);
  const verification = catalog.acquisition.pages.at(-1);
  assert.equal(verification.verification, true);
  assert.equal(verification.offset, 20);
  assert.equal(verification.eofSource, "SHORT_PAGE");
  assert(
    catalog.warnings.some((w) => w.startsWith("CATALOG_COVERAGE_DEGRADED")),
  );
});

test("a transient empty boundary page is recovered on verification", async () => {
  const { exchange } = scripted(catalogue(23, { transient: new Set([20]) }));
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 23);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
  assert.equal(catalog.acquisition.stopReason, "SHORT_PAGE");
});

test("an early end before later rows keeps every row and is reported", async () => {
  const { exchange } = scripted(catalogue(38, { transient: new Set([20]) }));
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 38);
  assert.deepEqual([...new Set(catalog.markets.map((m) => m.slug))].length, 38);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.deepEqual(
    catalog.acquisition.diagnostics.map((d) => d.code),
    ["END_OF_CATALOG_BEFORE_NONEMPTY_PAGE"],
  );
});

test("rows repeated across pages are reported as a coverage risk", async () => {
  const { exchange } = scripted(({ offset, limit }) =>
    // The order shifted by one row between the first and second pages.
    offset === 5 ? rows(4, 9) : rows(offset, Math.min(12, offset + limit)),
  );
  const catalog = await load(exchange);
  assert.equal(catalog.acquisition.duplicateRowCount, 1);
  assert.equal(catalog.acquisition.pages[1].duplicateCount, 1);
  assert.deepEqual(
    catalog.acquisition.diagnostics.map((d) => d.code),
    ["DUPLICATE_ROWS_ACROSS_PAGES"],
  );
});

test("a list ending exactly on a page boundary is re-read once and stays flagged", async () => {
  // Indistinguishable from truncation without an explicit end marker.
  const { exchange, requests } = scripted(catalogue(20));
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 20);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.equal(requests.filter((r) => r.offset === 20).length, 2);
});

test("an explicit end marker after full pages is trusted without a repeat", async () => {
  const { exchange, requests } = scripted(({ offset, limit }) =>
    offset >= 20
      ? { markets: [], eof: true }
      : { markets: rows(offset, offset + limit) },
  );
  const catalog = await load(exchange);
  assert.equal(catalog.markets.length, 20);
  assert.equal(catalog.acquisition.coverage, "COMPLETE");
  assert.equal(catalog.acquisition.stopReason, "EXCHANGE_EOF");
  assert.equal(requests.filter((r) => r.offset === 20).length, 1);
});

test("an endless list still stops at the page guard", async () => {
  const { exchange } = scripted(({ offset, limit }) =>
    rows(offset, offset + limit),
  );
  await assert.rejects(load(exchange, { maximumPages: 6 }), /6-page guard/);
});

test("sequential pagination applies the same verification", async () => {
  const { exchange, requests } = scripted(catalogue(40, { cap: 20 }));
  const catalog = await load(exchange, { maximumConcurrentPages: 1 });
  assert.equal(catalog.markets.length, 20);
  assert.equal(catalog.acquisition.coverage, "DEGRADED");
  assert.equal(requests.length, 6);
  assert.deepEqual(
    catalog.acquisition.pages.map((p) => [p.cursor, p.verification]),
    [
      [undefined, false],
      ["5", false],
      ["10", false],
      ["15", false],
      ["20", false],
      ["20", true],
    ],
  );
});
