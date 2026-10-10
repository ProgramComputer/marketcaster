// Live, read-only checks against the public Polymarket US gateway (no account
// keys). Markets are chosen at run time from the open catalog, and the engine's
// side labels, asset-price terms and model view are compared with the
// exchange's own market records and quotes.
const { default: assert } = await import("node:assert/strict");
const { log } = await import("node:console");
const { PolymarketUsExchange } =
  await import("../dist/src/exchanges/polymarket-us/adapter.js");
const { canonicalOrderToPolymarket } =
  await import("../dist/src/exchanges/polymarket-us/side-conversion.js");
const { buildMarketDetailContext } =
  await import("../dist/src/agent/context-builder.js");
const { fromModelSide, toModelView } =
  await import("../dist/src/agent/model-view.js");
const { Decimal } = await import("decimal.js");

const GATEWAY = "https://gateway.polymarket.us/v1";
const exchange = new PolymarketUsExchange({});
const pause = (milliseconds) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

// The public gateway rate-limits bursts; wait and retry instead of failing.
async function paced(read) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const limited = error?.status === 429 || error?.code === "RATE_LIMITED";
      if (attempt >= 4 || !limited) throw error;
      await pause(15_000 * attempt);
    }
  }
}

async function gateway(path) {
  return paced(async () => {
    const response = await globalThis.fetch(`${GATEWAY}${path}`);
    if (response.status === 429) {
      throw Object.assign(new Error(`${path} rate-limited`), { status: 429 });
    }
    assert.ok(response.ok, `${path} answered ${response.status}`);
    return response.json();
  });
}

const listed = await gateway(
  "/markets?limit=500&offset=0&active=true&closed=false&archived=false&orderBy=volume&orderDirection=desc",
);
const rawMarkets = listed.markets ?? listed.data?.markets ?? listed;
assert.ok(rawMarkets.length > 0, "The exchange lists open markets");

const crypto = await gateway(
  "/markets?limit=500&offset=0&active=true&closed=false&archived=false&categories=crypto",
);
const rawCrypto = crypto.markets ?? crypto.data?.markets ?? crypto;
const priced = rawCrypto.filter((market) => market.assetPriceTerms);

const labels = (market) =>
  (market.marketSides ?? []).map((side) => side.description);
const isYesNo = (market) =>
  labels(market).every((label) => label === "Yes" || label === "No");
const picks = [
  rawMarkets.find((market) => labels(market).length === 2 && isYesNo(market)),
  rawMarkets.find((market) => labels(market).length === 2 && !isYesNo(market)),
  priced.find(
    (market) =>
      market.assetPriceTerms.marketType === "ASSET_PRICE_MARKET_TYPE_UP_DOWN",
  ) ?? priced[0],
].filter((market) => market !== undefined);
assert.ok(
  picks.length >= 2,
  "Open markets include at least two kinds of side labels or price terms",
);
if (priced.length === 0) log("No open market carries asset-price terms.");

for (const pick of new Map(picks.map((m) => [m.slug, m])).values()) {
  const raw = (await gateway(`/market/slug/${encodeURIComponent(pick.slug)}`))
    .market;
  const longSide = raw.marketSides.find((side) => side.long);
  const shortSide = raw.marketSides.find((side) => !side.long);
  await pause(1_500);
  const market = await paced(() => exchange.getMarketBySlug(pick.slug));

  assert.deepEqual(
    market.sideLabels,
    {
      long: longSide.description.trim(),
      short: shortSide.description.trim(),
    },
    `${pick.slug} keeps the exchange's side labels by its long flag`,
  );
  if (raw.assetPriceTerms) {
    const terms = Object.fromEntries(
      Object.entries(raw.assetPriceTerms).filter(([key]) => key !== "chart"),
    );
    assert.deepEqual(
      market.assetPriceTerms,
      terms,
      `${pick.slug} keeps the exchange's asset-price terms`,
    );
  } else {
    assert.equal(
      market.assetPriceTerms,
      undefined,
      `${pick.slug} has no price terms`,
    );
  }

  const bbo = await paced(() => exchange.getBbo(market.id));
  const book = await paced(() => exchange.getOrderBook(market.id));
  const detail = buildMarketDetailContext({
    market,
    bbo,
    book,
    held: false,
    // No account keys: the read-only check holds no positions.
    account: { positions: [] },
  });
  const view = toModelView(detail);
  const text = JSON.stringify(view);
  assert.doesNotMatch(
    text,
    /"(yesBid|yesAsk|noBid|noAsk|sideLabels|session\w*YesPrice)"/u,
    `${pick.slug} model view has no yes/no quote fields`,
  );
  const quote = (value) =>
    value === undefined ? undefined : new Decimal(value).toFixed();
  assert.deepEqual(
    view.sides.map((side) => ({
      position: side.position,
      label: side.label,
      bid: quote(side.bid),
      ask: quote(side.ask),
    })),
    [
      {
        position: "LONG",
        label: longSide.description.trim(),
        bid: bbo.yes.bid?.toFixed(),
        ask: bbo.yes.ask?.toFixed(),
      },
      {
        position: "SHORT",
        label: shortSide.description.trim(),
        bid: bbo.no.bid?.toFixed(),
        ask: bbo.no.ask?.toFixed(),
      },
    ],
    `${pick.slug} model view shows each exchange side with its own quote`,
  );
  if (book.openPrice !== undefined) {
    assert.equal(
      quote(view.sessionOpenLongPrice),
      book.openPrice.toFixed(),
      `${pick.slug} session prices are named for the long side`,
    );
  }
  assert.equal(
    canonicalOrderToPolymarket({
      side: fromModelSide("LONG"),
      action: "BUY",
      canonicalLimitPrice: new Decimal("0.5"),
    }).intent,
    "ORDER_INTENT_BUY_LONG",
    "A model LONG buy reaches the exchange as a long buy",
  );
  assert.equal(
    canonicalOrderToPolymarket({
      side: fromModelSide("SHORT"),
      action: "BUY",
      canonicalLimitPrice: new Decimal("0.5"),
    }).intent,
    "ORDER_INTENT_BUY_SHORT",
    "A model SHORT buy reaches the exchange as a short buy",
  );
  log(
    `${pick.slug}: LONG "${longSide.description}", SHORT "${shortSide.description}"${raw.assetPriceTerms ? `, terms ${raw.assetPriceTerms.marketType}` : ""}`,
  );
}

log(
  "Live market sides: exchange labels, price terms and model view match the exchange.",
);
