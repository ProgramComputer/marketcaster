import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { PolymarketUsExchange } from "../dist/src/exchanges/polymarket-us/adapter.js";
import { ExchangeError } from "../dist/src/exchanges/exchange.js";

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
