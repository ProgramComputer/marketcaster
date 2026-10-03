// Live, read-only checks against the public Polymarket US gateway (no account
// keys). Events are chosen at run time from the exchange's open events, and the
// engine's answers are compared with the exchange's own event records.
const { default: assert } = await import("node:assert/strict");
const { log } = await import("node:console");
const { PolymarketUS } = await import("polymarket-us");
const { PolymarketUsExchange } =
  await import("../dist/src/exchanges/polymarket-us/adapter.js");
const { MarketFamilyResolver } =
  await import("../dist/src/agent/market-family-resolver.js");

const EVENTS_CHECKED = 5;
const sdk = new PolymarketUS({});
const exchange = new PolymarketUsExchange({});
const isOpen = (market) =>
  market.active !== false && market.closed !== true && market.archived !== true;
const openSlugs = (event) =>
  (event.markets ?? []).filter(isOpen).map((market) => market.slug);

const listed = await sdk.events.list({
  active: true,
  closed: false,
  archived: false,
  limit: 50,
  offset: 0,
});
const events = (listed.events ?? [])
  .filter((event) => {
    const count = openSlugs(event).length;
    return count >= 2 && count <= 30;
  })
  .slice(0, EVENTS_CHECKED);
assert.equal(
  events.length,
  EVENTS_CHECKED,
  "The exchange lists enough open events",
);

async function eventMembers(value) {
  const items = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await exchange.listMarketGroupMembers({
      kind: "EVENT",
      value,
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...result.items);
    if (result.eof) return items;
    cursor = result.nextCursor;
  }
  throw new Error(`Event ${value} did not finish paging`);
}

for (const event of events) {
  const expected = openSlugs(event);
  assert.deepEqual(
    await eventMembers(event.slug),
    expected,
    `EVENT members of ${event.slug} are the event's open markets`,
  );
  const market = await exchange.getMarketBySlug(expected[0]);
  assert.equal(
    market.eventId,
    String(event.id),
    `${market.slug} carries its event ID`,
  );
  assert.equal(
    market.eventSlug,
    event.slug,
    `${market.slug} carries its event slug`,
  );
}

assert.deepEqual(
  await exchange.listMarketGroupMembers({
    kind: "EVENT",
    value: `${events[0].slug}-not-an-event`,
  }),
  { items: [], eof: true },
  "An unknown event has no members instead of unrelated markets",
);

const [event] = events;
const expected = openSlugs(event);
const catalogMarkets = event.markets.map((market) => ({
  id: { exchange: "polymarket-us", value: String(market.id) },
  slug: market.slug,
  title: market.title ?? market.slug,
}));
const family = await new MarketFamilyResolver(exchange, {
  markets: catalogMarkets,
  bySlug: new Map(catalogMarkets.map((market) => [market.slug, market])),
  heldSlugs: new Set(),
}).resolve(expected[1]);
assert.equal(family.family.key, `event:${event.id}`);
assert.equal(family.membershipCompleteness, "EXCHANGE_GROUP_ENUMERATED");
assert.equal(
  family.members[0].market.slug,
  expected[1],
  "The seed comes first",
);
assert.deepEqual(
  family.members.map((member) => member.market.slug).sort(),
  [...expected].sort(),
  `The family of ${expected[1]} is every open market of ${event.slug}`,
);

log(
  `Live Polymarket US family checks passed on ${events.length} open events: ` +
    events
      .map((item) => `${item.slug} (${openSlugs(item).length} markets)`)
      .join(", ") +
    `; family of ${expected[1]}: ${family.members.length} members, ` +
    `${family.members.filter((member) => member.bbo !== undefined).length} with live quotes`,
);
