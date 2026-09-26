// check-null-quotes.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { Decimal } = await import("decimal.js");
  const { PolymarketUsExchange } =
    await import("../dist/src/exchanges/polymarket-us/adapter.js");
  const { ExchangeError } = await import("../dist/src/exchanges/exchange.js");
  // Synthetic SDK responses only; exercise the adapter's schema and mapper together.
  const market = {
    id: "123",
    slug: "synthetic-quote-market",
    title: "Synthetic quote market",
    settlementRules: "Resolve YES if the synthetic condition occurs.",
    active: true,
    closed: false,
    archived: false,
    priceTick: "0.01",
    minimumTradeQuantity: "1",
  };
  const marketId = { exchange: "polymarket-us", value: market.id };
  const observedAt = new Date("2026-01-01T00:00:00Z");
  const amount = (value) => ({ value, currency: "USD" });
  const decimal = (value) => new Decimal(value);
  let rawBbo;
  let marketReads = 0;
  const exchange = new PolymarketUsExchange({
    client: {
      markets: {
        retrieve: async (id) => {
          assert.equal(id, Number(market.id));
          marketReads += 1;
          return market;
        },
        bbo: async (slug) => {
          assert.equal(slug, market.slug);
          return rawBbo;
        },
      },
    },
    now: () => observedAt,
    targetRequestsPerSecond: 1_000_000,
  });

  for (const wrapper of [
    undefined,
    "marketData",
    "marketDataLite",
    "bbo",
    "data",
  ]) {
    for (const { sides, yes, no } of [
      { sides: {}, yes: {}, no: {} },
      { sides: { bestBid: null, bestAsk: null }, yes: {}, no: {} },
      {
        sides: { bestBid: null, bestAsk: amount("0.64") },
        yes: { ask: decimal("0.64") },
        no: { bid: decimal("0.36") },
      },
      {
        sides: { bestBid: amount("0.42"), bestAsk: null },
        yes: { bid: decimal("0.42") },
        no: { ask: decimal("0.58") },
      },
      {
        sides: { bestBid: amount("0.42"), bestAsk: amount("0.64") },
        yes: {
          bid: decimal("0.42"),
          ask: decimal("0.64"),
          spread: decimal("0.22"),
        },
        no: {
          bid: decimal("0.36"),
          ask: decimal("0.58"),
          spread: decimal("0.22"),
        },
      },
      {
        sides: { bestBid: amount("0"), bestAsk: amount("1") },
        yes: { bid: decimal(0), ask: decimal(1), spread: decimal(1) },
        no: { bid: decimal(0), ask: decimal(1), spread: decimal(1) },
      },
    ]) {
      const payload = { marketSlug: market.slug, ...sides };
      rawBbo = wrapper === undefined ? payload : { [wrapper]: payload };
      assert.deepEqual(await exchange.getBbo(marketId), {
        marketId,
        yes,
        no,
        observedAt,
      });
    }
  }

  // A null opposite side must never hide an invalid price or currency.
  for (const side of ["bestBid", "bestAsk"]) {
    const opposite = side === "bestBid" ? "bestAsk" : "bestBid";
    for (const invalid of [
      amount("-0.01"),
      amount("1.01"),
      amount("not-a-price"),
      amount("Infinity"),
      amount(null),
      {},
      { value: "0.5" },
      { value: "0.5", currency: "EUR" },
    ]) {
      rawBbo = {
        marketDataLite: {
          marketSlug: market.slug,
          [side]: invalid,
          [opposite]: null,
        },
      };
      await assert.rejects(
        exchange.getBbo(marketId),
        (error) => error instanceof ExchangeError && error.code === "SCHEMA",
      );
    }
  }

  for (const invalid of [
    { marketSlug: "", bestBid: null, bestAsk: null },
    { marketSlug: "another-synthetic-market", bestBid: null, bestAsk: null },
    { bestBid: null, bestAsk: null },
    {
      marketSlug: market.slug,
      bestBid: amount("0.7"),
      bestAsk: amount("0.3"),
    },
  ]) {
    rawBbo = { marketDataLite: invalid };
    await assert.rejects(
      exchange.getBbo(marketId),
      (error) => error instanceof ExchangeError && error.code === "SCHEMA",
    );
  }
  assert.equal(marketReads, 1, "Quotes retain their validated market identity");
})();

// check-discovery-timeout.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { readFile } = await import("node:fs/promises");
  const { default: test } = await import("node:test");
  const { RepositoryConfigSchema } =
    await import("../dist/src/config/schema.js");
  const { StageTimeoutError, withStageTimeout } =
    await import("../dist/src/utilities/time.js");
  const defaults = JSON.parse(await readFile("config/default.json", "utf8"));

  test("only discovery can omit its independent deadline", () => {
    const original = RepositoryConfigSchema.parse(defaults);
    assert.equal(original.cycle.stageBudgetsSeconds.marketDiscovery, 60);

    const input = globalThis.structuredClone(defaults);
    input.cycle.stageBudgetsSeconds.marketDiscovery = null;
    // An uncapped discovery stage can share the overall deadline even when the
    // remaining finite stage limits add up to less than the overall allowance.
    input.cycle.timeoutSeconds = 2_000;
    const parsed = RepositoryConfigSchema.parse(input);
    assert.equal(parsed.cycle.stageBudgetsSeconds.marketDiscovery, null);
    assert.equal(parsed.cycle.timeoutSeconds, 2_000);

    input.cycle.stageBudgetsSeconds.marketDiscovery = 120;
    assert.equal(RepositoryConfigSchema.safeParse(input).success, false);
    input.cycle.timeoutSeconds = defaults.cycle.timeoutSeconds;
    for (const invalid of [0, -1, 1.5, "null", undefined]) {
      input.cycle.stageBudgetsSeconds.marketDiscovery = invalid;
      assert.equal(RepositoryConfigSchema.safeParse(input).success, false);
    }
    input.cycle.stageBudgetsSeconds.marketDiscovery = null;
    for (const stage of [
      "agentResearch",
      "validationExecution",
      "reconciliationReporting",
    ]) {
      const invalid = globalThis.structuredClone(input);
      invalid.cycle.stageBudgetsSeconds[stage] = null;
      assert.equal(RepositoryConfigSchema.safeParse(invalid).success, false);
    }
  });

  test("uncapped discovery can complete beyond the former deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = withStageTimeout(
      "market-discovery",
      null,
      async (signal) => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 180_000));
        signal.throwIfAborted();
        return "complete catalog";
      },
    );
    t.mock.timers.tick(180_000);
    assert.equal(await result, "complete catalog");
  });

  test("uncapped discovery still observes the overall cycle deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const parent = new globalThis.AbortController();
    const reason = new Error("Synthetic overall cycle deadline");
    globalThis.setTimeout(() => parent.abort(reason), 200_000);
    let discoverySignal;
    const result = withStageTimeout(
      "market-discovery",
      null,
      (signal) => {
        discoverySignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      parent.signal,
    );
    t.mock.timers.tick(120_001);
    assert.equal(discoverySignal.aborted, false);
    t.mock.timers.tick(79_999);
    await assert.rejects(result, (error) => error === reason);
  });

  test("an expired overall deadline prevents a new stage from starting", async () => {
    for (const budget of [null, 120_000]) {
      const parent = new globalThis.AbortController();
      const reason = new Error("Synthetic already-expired cycle");
      parent.abort(reason);
      let called = false;
      await assert.rejects(
        withStageTimeout(
          "market-discovery",
          budget,
          async () => {
            called = true;
          },
          parent.signal,
        ),
        (error) => error === reason,
      );
      assert.equal(called, false);
    }
  });

  test("finite stage deadlines still abort with their original reason", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = withStageTimeout("synthetic-stage", 50, (signal) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    t.mock.timers.tick(50);
    await assert.rejects(
      result,
      (error) =>
        error instanceof StageTimeoutError && error.stage === "synthetic-stage",
    );
  });
})();

// check-catalog-acquisition.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { default: test } = await import("node:test");
  const { discoverMarketCatalog } =
    await import("../dist/src/agent/discovery.js");
  const { PolymarketUsExchange } =
    await import("../dist/src/exchanges/polymarket-us/adapter.js");
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
      verificationDelaysMilliseconds: [0, 0, 0],
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
    assert.equal(requests.filter((r) => r.offset === 20).length, 4);
    assert.equal(requests.length, 11);
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

  test("an early end before later rows is re-read and recovered", async () => {
    const { exchange } = scripted(catalogue(38, { transient: new Set([20]) }));
    const catalog = await load(exchange);
    assert.equal(catalog.markets.length, 38);
    assert.deepEqual(
      [...new Set(catalog.markets.map((m) => m.slug))].length,
      38,
    );
    assert.equal(catalog.acquisition.coverage, "COMPLETE");
    assert(
      catalog.acquisition.pages.some((p) => p.offset === 20 && p.verification),
    );
  });

  test("an early end before later rows that stays empty is reported", async () => {
    const { exchange } = scripted(({ offset, limit }) =>
      offset === 20 ? [] : rows(offset, Math.min(38, offset + limit)),
    );
    const catalog = await load(exchange);
    assert.equal(catalog.markets.length, 33);
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

  test("a list ending exactly on a page boundary is re-read three times and stays flagged", async () => {
    // Indistinguishable from truncation without an explicit end marker.
    const { exchange, requests } = scripted(catalogue(20));
    const catalog = await load(exchange);
    assert.equal(catalog.markets.length, 20);
    assert.equal(catalog.acquisition.coverage, "DEGRADED");
    assert.equal(requests.filter((r) => r.offset === 20).length, 4);
  });

  test("an empty boundary page that persists for two re-reads is still recovered", async () => {
    // Offset 20 opens the second batch; the whole batch is empty at first.
    const { exchange } = scripted(({ offset, limit }, call) =>
      offset >= 20 && call < 3
        ? []
        : rows(offset, Math.min(22, offset + limit)),
    );
    const catalog = await load(exchange);
    assert.equal(catalog.markets.length, 22);
    assert.equal(catalog.acquisition.coverage, "COMPLETE");
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
    assert.equal(requests.length, 8);
    assert.deepEqual(
      catalog.acquisition.pages.map((p) => [p.cursor, p.verification]),
      [
        [undefined, false],
        ["5", false],
        ["10", false],
        ["15", false],
        ["20", false],
        ["20", true],
        ["20", true],
        ["20", true],
      ],
    );
  });
})();

// check-catalog-coverage-policy.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { readFile } = await import("node:fs/promises");
  const { default: test } = await import("node:test");
  const { Decimal } = await import("decimal.js");
  const { buildTerminalDecisionRepairFeedback, isRepairableRiskRejection } =
    await import("../dist/src/agent/decision-repair.js");
  const { discoverMarketCatalog } =
    await import("../dist/src/agent/discovery.js");
  const { RepositoryConfigSchema } =
    await import("../dist/src/config/schema.js");
  const { PolymarketUsExchange } =
    await import("../dist/src/exchanges/polymarket-us/adapter.js");
  const { validateProposals } = await import("../dist/src/risk/validate.js");
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
      params.orderBy?.[0] === "volume"
        ? unstableVolume(params)
        : stable(params),
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
    assert(
      catalog.warnings.some((w) => w.startsWith("CATALOG_RANKING_PARTIAL")),
    );
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
    assert.equal(
      requests.filter((r) => r.orderBy?.[0] === "end_date").length,
      4,
    );
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
})();
