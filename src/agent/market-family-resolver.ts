import pLimit from "p-limit";
import {
  deriveNativeMarketFamily,
  isInNativeMarketFamily,
  marketFamilySeed,
  nativeMarketFamilyGroupSelector,
  type NativeMarketFamily,
} from "../domain/market-family.js";
import type { Market, MarketBbo } from "../domain/market.js";
import {
  ExchangeError,
  type PredictionExchange,
} from "../exchanges/exchange.js";
import type { MarketCatalog } from "./discovery.js";

export const MAXIMUM_MARKET_FAMILY_MEMBERS = 30;

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAXIMUM_PAGES = 30;
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 4;

export interface MarketFamilyResolverOptions {
  /** Defaults to 30 and may not exceed the hard safety limit of 30. */
  readonly maximumMembers?: number;
  readonly pageSize?: number;
  readonly maximumPages?: number;
  readonly maximumConcurrentRequests?: number;
}

export type MarketFamilyDiscoveryBasis =
  | "EXCHANGE_GROUP"
  | "CATALOG_METADATA"
  | "EXCHANGE_GROUP_AND_CATALOG_METADATA"
  | "SEED_ONLY";

export interface ResolvedMarketFamilyMember {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly held: boolean;
  readonly warnings: readonly string[];
}

export interface ResolvedMarketFamily {
  readonly family: NativeMarketFamily;
  readonly seedMarketSlug: string;
  readonly members: readonly ResolvedMarketFamilyMember[];
  readonly discoveryBasis: MarketFamilyDiscoveryBasis;
  /** True when the hard member/page bound prevented complete enumeration. */
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

interface DiscoveredFamilySlugs {
  readonly slugs: readonly string[];
  readonly discoveryBasis: MarketFamilyDiscoveryBasis;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

interface ResolvedMemberFailure {
  readonly slug: string;
  readonly error: unknown;
}

function positiveSafeInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function normalizedSlug(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function discoveryBasis(
  usedExchangeGroup: boolean,
  usedCatalog: boolean,
): MarketFamilyDiscoveryBasis {
  if (usedExchangeGroup && usedCatalog) {
    return "EXCHANGE_GROUP_AND_CATALOG_METADATA";
  }
  if (usedExchangeGroup) return "EXCHANGE_GROUP";
  if (usedCatalog) return "CATALOG_METADATA";
  return "SEED_ONLY";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "unknown error";
}

export class MarketFamilyResolver {
  private readonly maximumMembers: number;
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly requestLimit: ReturnType<typeof pLimit>;

  public constructor(
    private readonly exchange: PredictionExchange,
    private readonly catalog: MarketCatalog,
    options: MarketFamilyResolverOptions = {},
  ) {
    this.maximumMembers = positiveSafeInteger(
      options.maximumMembers ?? MAXIMUM_MARKET_FAMILY_MEMBERS,
      "maximumMembers",
    );
    if (this.maximumMembers > MAXIMUM_MARKET_FAMILY_MEMBERS) {
      throw new RangeError(
        `maximumMembers cannot exceed ${MAXIMUM_MARKET_FAMILY_MEMBERS}`,
      );
    }
    this.pageSize = positiveSafeInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      "pageSize",
    );
    this.maximumPages = positiveSafeInteger(
      options.maximumPages ?? DEFAULT_MAXIMUM_PAGES,
      "maximumPages",
    );
    const maximumConcurrentRequests = positiveSafeInteger(
      options.maximumConcurrentRequests ?? DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
      "maximumConcurrentRequests",
    );
    if (maximumConcurrentRequests > MAXIMUM_MARKET_FAMILY_MEMBERS) {
      throw new RangeError(
        `maximumConcurrentRequests cannot exceed ${MAXIMUM_MARKET_FAMILY_MEMBERS}`,
      );
    }
    this.requestLimit = pLimit(maximumConcurrentRequests);
  }

  private async seedMarket(
    seed: Market | string,
    signal?: AbortSignal,
  ): Promise<Market> {
    if (typeof seed !== "string") return seed;
    const slug = seed.trim();
    if (slug.length === 0) {
      throw new RangeError("seed market slug must be non-empty");
    }
    const catalogMarket = this.catalog.bySlug.get(slug);
    if (catalogMarket === undefined) {
      throw new Error(`Market ${slug} is not in the catalog`);
    }
    signal?.throwIfAborted();
    const detailedMarket = await this.exchange.getMarketBySlug(slug);
    signal?.throwIfAborted();
    if (detailedMarket.id.value !== catalogMarket.id.value) {
      throw new Error(`Market identifier changed for ${slug}`);
    }
    return detailedMarket;
  }

  private async discoverSlugs(
    seed: Market,
    signal?: AbortSignal,
  ): Promise<DiscoveredFamilySlugs> {
    const familySeed = marketFamilySeed(seed);
    const selector = nativeMarketFamilyGroupSelector(familySeed);
    const slugs: string[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    let truncated = false;
    let usedExchangeGroup = false;
    let usedCatalog = false;

    const append = (rawSlug: string): boolean => {
      const slug = rawSlug.trim();
      if (slug.length === 0) return true;
      const key = normalizedSlug(slug);
      if (seen.has(key)) return true;
      if (slugs.length >= this.maximumMembers) {
        truncated = true;
        return false;
      }
      seen.add(key);
      slugs.push(slug);
      return true;
    };

    // The seed is always first and always consumes one slot in the hard bound.
    append(seed.slug);

    const listGroupMembers = this.exchange.listMarketGroupMembers?.bind(
      this.exchange,
    );
    if (selector !== undefined && listGroupMembers !== undefined) {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (
          let pageNumber = 0;
          pageNumber < this.maximumPages;
          pageNumber += 1
        ) {
          signal?.throwIfAborted();
          const remaining = this.maximumMembers - slugs.length;
          if (remaining <= 0) {
            truncated = true;
            break;
          }
          const page = await listGroupMembers({
            kind: selector.kind,
            value: selector.value,
            limit: Math.min(this.pageSize, remaining),
            ...(cursor === undefined ? {} : { cursor }),
          });
          signal?.throwIfAborted();
          usedExchangeGroup = true;
          let consumedEveryItem = true;
          for (const slug of page.items) {
            if (!append(slug)) {
              consumedEveryItem = false;
              break;
            }
          }
          if (!consumedEveryItem) break;
          if (page.eof) break;
          if (slugs.length >= this.maximumMembers) {
            truncated = true;
            break;
          }
          if (page.nextCursor === undefined || cursors.has(page.nextCursor)) {
            warnings.push(
              "Exchange family pagination was incomplete or repeated a cursor",
            );
            truncated = true;
            break;
          }
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
          if (pageNumber + 1 === this.maximumPages) {
            warnings.push(
              `Exchange family pagination reached the ${this.maximumPages}-page guard`,
            );
            truncated = true;
          }
        }
      } catch (error) {
        if (error instanceof ExchangeError && error.code === "UNSUPPORTED") {
          warnings.push(
            "Exchange family membership is unavailable; catalog metadata was used",
          );
        } else {
          throw error;
        }
      }
    }

    if (selector !== undefined) {
      for (const market of this.catalog.markets) {
        if (!isInNativeMarketFamily(familySeed, marketFamilySeed(market))) {
          continue;
        }
        const key = normalizedSlug(market.slug);
        const wasAlreadyDiscovered = seen.has(key);
        if (!append(market.slug)) break;
        if (!wasAlreadyDiscovered) usedCatalog = true;
      }
    }

    return {
      slugs: Object.freeze(slugs),
      discoveryBasis: discoveryBasis(usedExchangeGroup, usedCatalog),
      truncated,
      warnings: Object.freeze(warnings),
    };
  }

  private async resolveMember(
    slug: string,
    seed: Market,
    signal?: AbortSignal,
  ): Promise<ResolvedMarketFamilyMember> {
    signal?.throwIfAborted();
    const market =
      normalizedSlug(slug) === normalizedSlug(seed.slug)
        ? seed
        : await this.exchange.getMarketBySlug(slug);
    signal?.throwIfAborted();
    const catalogMarket = this.catalog.bySlug.get(slug);
    if (
      catalogMarket !== undefined &&
      catalogMarket.id.value !== market.id.value
    ) {
      throw new Error(`Market identifier changed for ${slug}`);
    }

    const warnings: string[] = [];
    let bbo: MarketBbo | undefined;
    try {
      bbo = await this.exchange.getBbo(market.id);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      warnings.push(`Current BBO is unavailable for ${market.slug}`);
    }
    signal?.throwIfAborted();
    return {
      market,
      ...(bbo === undefined ? {} : { bbo }),
      held: this.catalog.heldSlugs.has(market.slug),
      warnings: Object.freeze(warnings),
    };
  }

  /**
   * Resolves a native event/series family from a detailed Market or a catalog
   * slug. Results are seed-first and never exceed maximumMembers.
   */
  public async resolve(
    seed: Market | string,
    signal?: AbortSignal,
  ): Promise<ResolvedMarketFamily> {
    const resolvedSeed = await this.seedMarket(seed, signal);
    const family = deriveNativeMarketFamily(marketFamilySeed(resolvedSeed));
    const discovery = await this.discoverSlugs(resolvedSeed, signal);
    const results = await Promise.all(
      discovery.slugs.map((slug) =>
        this.requestLimit(async () => {
          try {
            return await this.resolveMember(slug, resolvedSeed, signal);
          } catch (error) {
            if (signal?.aborted === true) throw error;
            return { slug, error } satisfies ResolvedMemberFailure;
          }
        }),
      ),
    );
    signal?.throwIfAborted();

    const members: ResolvedMarketFamilyMember[] = [];
    const warnings = [...discovery.warnings];
    for (const result of results) {
      if ("error" in result) {
        warnings.push(
          `Market details are unavailable for ${result.slug}: ${errorMessage(result.error)}`,
        );
      } else {
        members.push(result);
      }
    }

    return {
      family,
      seedMarketSlug: resolvedSeed.slug,
      members: Object.freeze(members),
      discoveryBasis: discovery.discoveryBasis,
      truncated: discovery.truncated,
      warnings: Object.freeze(warnings),
    };
  }
}
