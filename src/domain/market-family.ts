import type { Market } from "./market.js";

export type NativeMarketFamilyKind = "EVENT" | "SERIES" | "MARKET";

export type NativeMarketFamilySource =
  "EVENT_ID" | "EVENT_SLUG" | "SERIES_ID" | "SERIES_SLUG" | "MARKET_SLUG";

export interface MarketFamilySeed {
  readonly marketSlug: string;
  readonly eventId?: string;
  readonly eventSlug?: string;
  readonly seriesId?: string;
  readonly seriesSlug?: string;
}

export interface NativeMarketFamily {
  /** Stable, case-insensitive identity suitable for maps and risk grouping. */
  readonly key: string;
  readonly kind: NativeMarketFamilyKind;
  /** Trimmed native identifier selected according to the source precedence. */
  readonly value: string;
  readonly source: NativeMarketFamilySource;
}

export interface NativeMarketFamilyGroupSelector {
  readonly kind: "EVENT" | "SERIES";
  readonly value: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalized(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

/**
 * Derives the narrowest native grouping that the exchange supplied. Event
 * identifiers take precedence over series identifiers because a series can
 * contain many separately settling events.
 */
export function deriveNativeMarketFamily(
  seed: MarketFamilySeed,
): NativeMarketFamily {
  const eventId = nonEmpty(seed.eventId);
  if (eventId !== undefined) {
    return {
      key: `event:${normalized(eventId)}`,
      kind: "EVENT",
      value: eventId,
      source: "EVENT_ID",
    };
  }

  const eventSlug = nonEmpty(seed.eventSlug);
  if (eventSlug !== undefined) {
    return {
      key: `event:${normalized(eventSlug)}`,
      kind: "EVENT",
      value: eventSlug,
      source: "EVENT_SLUG",
    };
  }

  const seriesId = nonEmpty(seed.seriesId);
  if (seriesId !== undefined) {
    return {
      key: `series:${normalized(seriesId)}`,
      kind: "SERIES",
      value: seriesId,
      source: "SERIES_ID",
    };
  }

  const seriesSlug = nonEmpty(seed.seriesSlug);
  if (seriesSlug !== undefined) {
    return {
      key: `series:${normalized(seriesSlug)}`,
      kind: "SERIES",
      value: seriesSlug,
      source: "SERIES_SLUG",
    };
  }

  const marketSlug = nonEmpty(seed.marketSlug);
  if (marketSlug === undefined) {
    throw new RangeError("marketSlug must be non-empty");
  }
  return {
    key: `market:${normalized(marketSlug)}`,
    kind: "MARKET",
    value: marketSlug,
    source: "MARKET_SLUG",
  };
}

export function nativeMarketFamilyKey(seed: MarketFamilySeed): string {
  return deriveNativeMarketFamily(seed).key;
}

/**
 * Returns the selector accepted by the exchange group API. Slugs are preferred
 * here even when the stable key uses an ID: Polymarket's EVENT and SERIES
 * endpoints are slug-addressed, while Kalshi maps its ticker into both fields.
 */
export function nativeMarketFamilyGroupSelector(
  seed: MarketFamilySeed,
): NativeMarketFamilyGroupSelector | undefined {
  const family = deriveNativeMarketFamily(seed);
  if (family.kind === "EVENT") {
    return {
      kind: "EVENT",
      value: nonEmpty(seed.eventSlug) ?? family.value,
    };
  }
  if (family.kind === "SERIES") {
    return {
      kind: "SERIES",
      value: nonEmpty(seed.seriesSlug) ?? family.value,
    };
  }
  return undefined;
}

function sameOptionalIdentifier(
  left: string | undefined,
  right: string | undefined,
): boolean | undefined {
  const normalizedLeft = nonEmpty(left);
  const normalizedRight = nonEmpty(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) {
    return undefined;
  }
  return normalized(normalizedLeft) === normalized(normalizedRight);
}

/**
 * Matches catalog rows defensively. Native IDs are authoritative when both
 * rows contain them; otherwise matching slugs can bridge partially populated
 * catalog metadata.
 */
export function isInNativeMarketFamily(
  seed: MarketFamilySeed,
  candidate: MarketFamilySeed,
): boolean {
  const family = deriveNativeMarketFamily(seed);
  if (family.kind === "EVENT") {
    const idMatch = sameOptionalIdentifier(seed.eventId, candidate.eventId);
    if (idMatch !== undefined) return idMatch;
    return sameOptionalIdentifier(seed.eventSlug, candidate.eventSlug) ?? false;
  }
  if (family.kind === "SERIES") {
    const idMatch = sameOptionalIdentifier(seed.seriesId, candidate.seriesId);
    if (idMatch !== undefined) return idMatch;
    return (
      sameOptionalIdentifier(seed.seriesSlug, candidate.seriesSlug) ?? false
    );
  }
  return sameOptionalIdentifier(seed.marketSlug, candidate.marketSlug) ?? false;
}

export function marketFamilySeed(market: Market): MarketFamilySeed {
  return {
    marketSlug: market.slug,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
  };
}
