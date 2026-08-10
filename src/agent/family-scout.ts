import type { Market } from "../domain/market.js";

export const MAXIMUM_SCOUT_FAMILIES = 100;
export const MAXIMUM_SCOUT_MEMBERS_PER_FAMILY = 30;

export interface EligibleRankedMarketRow {
  readonly market: Market;
  readonly exchangeRank: number;
}

export interface FamilyScoutOptions {
  readonly maximumFamilies: number;
  readonly maximumMembersPerFamily: number;
  readonly minimumFamilyMembers: number;
}

export type FamilyScoutKind = "EVENT" | "SERIES" | "INFERRED_EVENT";

export type FamilyScoutSource =
  | "NATIVE_EVENT_ID"
  | "NATIVE_EVENT_SLUG"
  | "NATIVE_SERIES_ID"
  | "NATIVE_SERIES_SLUG"
  | "POLYMARKET_US_SLUG_PREFIX";

export type FamilyScoutRecurrenceSource =
  "NATIVE_SERIES_ID" | "NATIVE_SERIES_SLUG" | "DATE_NORMALIZED_FAMILY";

export type FamilyScoutStructure = "LADDER" | "MULTI_OUTCOME";

export interface FamilyScoutMember {
  readonly market: Market;
  readonly exchangeRank: number;
}

/**
 * A discovery hint only. These inferred identities are deliberately distinct
 * from NativeMarketFamily and must never be used for settlement, risk, or
 * exposure deduplication.
 */
export interface FamilyScoutFamily {
  readonly advisoryOnly: true;
  readonly familyKey: string;
  readonly recurrenceKey: string;
  readonly kind: FamilyScoutKind;
  readonly source: FamilyScoutSource;
  readonly recurrenceSource: FamilyScoutRecurrenceSource;
  readonly structure: FamilyScoutStructure;
  readonly totalMemberCount: number;
  readonly recurrenceInstanceCount: number;
  readonly bestExchangeRank: number;
  readonly closesAt?: string;
  readonly sampledMembers: readonly FamilyScoutMember[];
}

interface ScoutIdentity {
  readonly familyKey: string;
  readonly recurrenceKey: string;
  readonly kind: FamilyScoutKind;
  readonly source: FamilyScoutSource;
  readonly recurrenceSource: FamilyScoutRecurrenceSource;
}

interface MutableScoutFamily extends ScoutIdentity {
  readonly members: EligibleRankedMarketRow[];
}

const YEAR_FIRST_DATE =
  /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/giu;
const MONTH_FIRST_DATE =
  /\b(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])-(?:19|20)\d{2}\b/giu;
const COMPACT_DATE =
  /\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/giu;
const TICKER_DATE =
  /\b\d{2}(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:0[1-9]|[12]\d|3[01])(?:\d{2,4})?\b/giu;
const NUMERIC_BUCKET =
  /(?:\d|\babove\b|\bbelow\b|\bunder\b|\bover\b|\bbetween\b|\bto\b|\bbps\b|[$%])/iu;
const TITLE_NUMBER = /[-+]?\$?(\d[\d,]*(?:\.\d+)?)/gu;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizeDates(value: string): string {
  return normalized(value)
    .replace(YEAR_FIRST_DATE, "{date}")
    .replace(MONTH_FIRST_DATE, "{date}")
    .replace(COMPACT_DATE, "{date}")
    .replace(TICKER_DATE, "{date}");
}

function nativeSeries(market: Market):
  | {
      readonly value: string;
      readonly source: "NATIVE_SERIES_ID" | "NATIVE_SERIES_SLUG";
    }
  | undefined {
  const seriesId = nonEmpty(market.seriesId);
  if (seriesId !== undefined) {
    return { value: seriesId, source: "NATIVE_SERIES_ID" };
  }
  const seriesSlug = nonEmpty(market.seriesSlug);
  return seriesSlug === undefined
    ? undefined
    : { value: seriesSlug, source: "NATIVE_SERIES_SLUG" };
}

function scoutIdentity(market: Market): ScoutIdentity | undefined {
  const series = nativeSeries(market);
  const eventId = nonEmpty(market.eventId);
  const eventSlug = nonEmpty(market.eventSlug);

  let familyValue: string;
  let kind: FamilyScoutKind;
  let source: FamilyScoutSource;
  if (eventId !== undefined) {
    familyValue = eventId;
    kind = "EVENT";
    source = "NATIVE_EVENT_ID";
  } else if (eventSlug !== undefined) {
    familyValue = eventSlug;
    kind = "EVENT";
    source = "NATIVE_EVENT_SLUG";
  } else if (series !== undefined) {
    familyValue = series.value;
    kind = "SERIES";
    source = series.source;
  } else {
    if (market.id.exchange !== "polymarket-us") return undefined;
    const slug = market.slug.trim();
    const separator = slug.lastIndexOf("-");
    if (separator <= 0 || separator === slug.length - 1) return undefined;
    familyValue = slug.slice(0, separator);
    // A one-token prefix (for example `market-123`) is too generic to be a
    // useful structural hint and creates large false families.
    if (!familyValue.includes("-")) return undefined;
    kind = "INFERRED_EVENT";
    source = "POLYMARKET_US_SLUG_PREFIX";
  }

  const familyNamespace =
    kind === "EVENT" ? "event" : kind === "SERIES" ? "series" : "slug-event";
  const familyKey = `scout:${familyNamespace}:${normalized(familyValue)}`;
  if (series !== undefined) {
    return {
      familyKey,
      recurrenceKey: `scout:recurrence:series:${normalized(series.value)}`,
      kind,
      source,
      recurrenceSource: series.source,
    };
  }
  return {
    familyKey,
    recurrenceKey: `scout:recurrence:family:${normalizeDates(familyValue)}`,
    kind,
    source,
    recurrenceSource: "DATE_NORMALIZED_FAMILY",
  };
}

/**
 * Returns the conservative discovery-only key used by the scout. Callers may
 * use this to preserve research equivalence for unsampled catalog siblings;
 * the key is never authoritative for risk, settlement, or execution.
 */
export function familyScoutResearchKey(market: Market): string | undefined {
  return scoutIdentity(market)?.familyKey;
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${field} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function validateOptions(options: FamilyScoutOptions): void {
  positiveBoundedInteger(
    options.maximumFamilies,
    MAXIMUM_SCOUT_FAMILIES,
    "maximumFamilies",
  );
  positiveBoundedInteger(
    options.maximumMembersPerFamily,
    MAXIMUM_SCOUT_MEMBERS_PER_FAMILY,
    "maximumMembersPerFamily",
  );
  positiveBoundedInteger(
    options.minimumFamilyMembers,
    MAXIMUM_SCOUT_MEMBERS_PER_FAMILY,
    "minimumFamilyMembers",
  );
}

function compareRows(
  left: EligibleRankedMarketRow,
  right: EligibleRankedMarketRow,
): number {
  const rankOrder = left.exchangeRank - right.exchangeRank;
  return rankOrder === 0
    ? left.market.slug.localeCompare(right.market.slug, "en-US")
    : rankOrder;
}

function assertUniqueRows(rows: readonly EligibleRankedMarketRow[]): void {
  const identities = new Map<string, string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.exchangeRank) || row.exchangeRank <= 0) {
      throw new RangeError("exchangeRank must be a positive safe integer");
    }
    const slug = normalized(row.market.slug);
    const existing = identities.get(slug);
    if (existing !== undefined) {
      throw new Error(
        existing === row.market.id.value
          ? `Duplicate family-scout market ${row.market.slug}`
          : `Conflicting identifiers for family-scout market ${row.market.slug}`,
      );
    }
    identities.set(slug, row.market.id.value);
  }
}

function structureOf(
  members: readonly EligibleRankedMarketRow[],
): FamilyScoutStructure {
  const numericMembers = members.filter(({ market }) =>
    NUMERIC_BUCKET.test(market.title),
  ).length;
  return numericMembers >= Math.min(2, members.length)
    ? "LADDER"
    : "MULTI_OUTCOME";
}

function numericTitleValue(title: string): number | undefined {
  const values = [...title.matchAll(TITLE_NUMBER)]
    .map((match) => Number(match[1]?.replaceAll(",", "")))
    .filter(
      (value) =>
        Number.isFinite(value) &&
        !(Number.isInteger(value) && value >= 1900 && value <= 2200),
    );
  return values.at(-1);
}

function sampleMembers(
  members: readonly EligibleRankedMarketRow[],
  structure: FamilyScoutStructure,
  maximum: number,
): readonly FamilyScoutMember[] {
  const ranked = [...members].sort(compareRows);
  if (ranked.length <= maximum) return Object.freeze(ranked);
  if (structure !== "LADDER") {
    return Object.freeze(ranked.slice(0, maximum));
  }

  const numeric = ranked
    .map((row) => ({ row, value: numericTitleValue(row.market.title) }))
    .filter(
      (entry): entry is { row: EligibleRankedMarketRow; value: number } =>
        entry.value !== undefined,
    )
    .sort((left, right) => {
      const valueOrder = left.value - right.value;
      return valueOrder === 0 ? compareRows(left.row, right.row) : valueOrder;
    });
  if (numeric.length === 0) return Object.freeze(ranked.slice(0, maximum));

  const sampled: EligibleRankedMarketRow[] = [];
  const seen = new Set<string>();
  const append = (row: EligibleRankedMarketRow | undefined): void => {
    if (row === undefined || sampled.length >= maximum) return;
    const key = normalized(row.market.slug);
    if (seen.has(key)) return;
    seen.add(key);
    sampled.push(row);
  };
  // Ladder scouts deliberately start in the informative middle. Extreme
  // endpoints are often near-certain contracts with little uncertainty and
  // were previously crowding out useful strikes.
  const center = (numeric.length - 1) / 2;
  const centerIndexes = numeric
    .map((_, index) => index)
    .toSorted((left, right) => {
      const distance = Math.abs(left - center) - Math.abs(right - center);
      if (distance !== 0) return distance;
      return left - right;
    });
  for (const index of centerIndexes) append(numeric[index]?.row);
  for (const row of ranked) append(row);
  return Object.freeze(sampled);
}

function earliestClose(
  members: readonly EligibleRankedMarketRow[],
): Date | undefined {
  let earliest: Date | undefined;
  for (const { market } of members) {
    const close = market.closesAt;
    if (close === undefined || Number.isNaN(close.getTime())) continue;
    if (earliest === undefined || close < earliest) earliest = close;
  }
  return earliest;
}

function compareFamilies(
  left: FamilyScoutFamily,
  right: FamilyScoutFamily,
): number {
  const recurrenceOrder =
    right.recurrenceInstanceCount - left.recurrenceInstanceCount;
  if (recurrenceOrder !== 0) return recurrenceOrder;
  if (left.structure !== right.structure) {
    return left.structure === "LADDER" ? -1 : 1;
  }
  const closeOrder =
    (left.closesAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(left.closesAt)) -
    (right.closesAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(right.closesAt));
  if (closeOrder !== 0) return closeOrder;
  const rankOrder = left.bestExchangeRank - right.bestExchangeRank;
  return rankOrder === 0
    ? left.familyKey.localeCompare(right.familyKey, "en-US")
    : rankOrder;
}

/**
 * Groups already-eligible ranked rows into bounded, deterministic discovery
 * hints. The caller remains responsible for exact detail, rule, quote, and risk
 * validation before any proposal is formed.
 */
export function buildFamilyScout(
  rows: readonly EligibleRankedMarketRow[],
  options: FamilyScoutOptions,
): readonly FamilyScoutFamily[] {
  validateOptions(options);
  assertUniqueRows(rows);

  const grouped = new Map<string, MutableScoutFamily>();
  for (const row of rows) {
    const identity = scoutIdentity(row.market);
    if (identity === undefined) continue;
    const existing = grouped.get(identity.familyKey);
    if (existing === undefined) {
      grouped.set(identity.familyKey, { ...identity, members: [row] });
    } else {
      existing.members.push(row);
    }
  }

  const recurrenceInstances = new Map<string, number>();
  for (const family of grouped.values()) {
    recurrenceInstances.set(
      family.recurrenceKey,
      (recurrenceInstances.get(family.recurrenceKey) ?? 0) + 1,
    );
  }

  return Object.freeze(
    [...grouped.values()]
      .filter((family) => family.members.length >= options.minimumFamilyMembers)
      .map((family): FamilyScoutFamily => {
        const structure = structureOf(family.members);
        const close = earliestClose(family.members);
        return {
          advisoryOnly: true,
          familyKey: family.familyKey,
          recurrenceKey: family.recurrenceKey,
          kind: family.kind,
          source: family.source,
          recurrenceSource: family.recurrenceSource,
          structure,
          totalMemberCount: family.members.length,
          recurrenceInstanceCount:
            recurrenceInstances.get(family.recurrenceKey) ?? 1,
          bestExchangeRank: Math.min(
            ...family.members.map(({ exchangeRank }) => exchangeRank),
          ),
          ...(close === undefined ? {} : { closesAt: close.toISOString() }),
          sampledMembers: sampleMembers(
            family.members,
            structure,
            options.maximumMembersPerFamily,
          ),
        };
      })
      .sort(compareFamilies)
      .slice(0, options.maximumFamilies),
  );
}
