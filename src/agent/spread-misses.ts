import type { Decimal } from "decimal.js";
import type { MarketBbo } from "../domain/market.js";
import type { OutcomeSide } from "../domain/primitives.js";
import type { AgentDecision } from "./decision-schema.js";

/**
 * Where a market met a spread limit: the starting list dropped it, the model
 * saw it and did not target it, or validation rejected its target.
 */
export type SpreadMissStage = "STARTING_LIST" | "MODEL" | "TRADE";

export interface SpreadMiss {
  readonly stage: SpreadMissStage;
  readonly marketSlug: string;
  readonly side: OutcomeSide | null;
  readonly bid: string | null;
  readonly ask: string | null;
  readonly spread: string | null;
  readonly quoteObservedAt: string | null;
  readonly reasonCode?: string;
  readonly reason?: string;
}

const MAXIMUM_REASON_LENGTH = 240;

function twoSidedSpread(
  bbo: MarketBbo | undefined,
  side: OutcomeSide,
): { bid: Decimal; ask: Decimal; spread: Decimal } | undefined {
  const quote = side === "YES" ? bbo?.yes : bbo?.no;
  if (quote?.bid === undefined || quote.ask === undefined) return undefined;
  const spread = quote.ask.minus(quote.bid);
  return spread.lt(0) ? undefined : { bid: quote.bid, ask: quote.ask, spread };
}

function quoteFields(
  bbo: MarketBbo | undefined,
  quote: ReturnType<typeof twoSidedSpread>,
) {
  return {
    bid: quote?.bid.toFixed() ?? null,
    ask: quote?.ask.toFixed() ?? null,
    spread: quote?.spread.toFixed() ?? null,
    quoteObservedAt: bbo?.observedAt.toISOString() ?? null,
  };
}

/**
 * Lists markets kept out of trading by a spread limit, from quotes the cycle
 * already fetched. One-sided books are omitted: they fail the missing-quote
 * check whatever the spread limit is.
 */
export function collectSpreadMisses(input: {
  readonly quotesBySlug: ReadonlyMap<string, MarketBbo>;
  readonly startingListQuotedSlugs: ReadonlySet<string>;
  readonly startingListSlugs: ReadonlySet<string>;
  readonly startingListMaximumSpread: Decimal;
  readonly inspectedMarketSlugs: ReadonlySet<string>;
  readonly decision: AgentDecision;
  readonly tradeMaximumSpread: Decimal;
  readonly tradeRejections: readonly {
    readonly marketSlug: string;
    readonly code: string;
    readonly message: string;
  }[];
}): readonly SpreadMiss[] {
  const misses: SpreadMiss[] = [];

  // The starting list checks the YES quote, so this must too.
  for (const marketSlug of [...input.startingListQuotedSlugs].sort()) {
    if (input.startingListSlugs.has(marketSlug)) continue;
    const bbo = input.quotesBySlug.get(marketSlug);
    const quote = twoSidedSpread(bbo, "YES");
    if (
      quote === undefined ||
      quote.spread.lte(input.startingListMaximumSpread)
    )
      continue;
    misses.push({
      stage: "STARTING_LIST",
      marketSlug,
      side: null,
      ...quoteFields(bbo, quote),
    });
  }

  const targetSlugs = new Set(
    [...input.decision.portfolioTargets, ...input.decision.proposals].map(
      (item) => item.marketSlug,
    ),
  );
  const dispositions = new Map(
    input.decision.candidateDispositions.map(
      (disposition) => [disposition.marketSlug, disposition] as const,
    ),
  );
  const modelSlugs = new Set([
    ...input.inspectedMarketSlugs,
    ...dispositions.keys(),
  ]);
  for (const marketSlug of [...modelSlugs].sort()) {
    if (targetSlugs.has(marketSlug)) continue;
    const disposition = dispositions.get(marketSlug);
    const side = disposition?.side ?? null;
    const bbo = input.quotesBySlug.get(marketSlug);
    const quote = twoSidedSpread(bbo, side ?? "YES");
    if (quote === undefined || quote.spread.lte(input.tradeMaximumSpread))
      continue;
    misses.push({
      stage: "MODEL",
      marketSlug,
      side,
      ...quoteFields(bbo, quote),
      ...(disposition === undefined
        ? {}
        : {
            reasonCode: disposition.reasonCode,
            reason: disposition.rationale.slice(0, MAXIMUM_REASON_LENGTH),
          }),
    });
  }

  const targetSides = new Map(
    [...input.decision.portfolioTargets, ...input.decision.proposals].map(
      (item) => [item.marketSlug, item.side] as const,
    ),
  );
  for (const rejection of input.tradeRejections) {
    if (rejection.code !== "SPREAD_TOO_WIDE") continue;
    const side = targetSides.get(rejection.marketSlug) ?? null;
    const bbo = input.quotesBySlug.get(rejection.marketSlug);
    misses.push({
      stage: "TRADE",
      marketSlug: rejection.marketSlug,
      side,
      ...quoteFields(bbo, twoSidedSpread(bbo, side ?? "YES")),
      reasonCode: rejection.code,
      reason: rejection.message.slice(0, MAXIMUM_REASON_LENGTH),
    });
  }
  return misses;
}
