import type { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { ExecutionStatus } from "../domain/execution.js";
import type {
  Market,
  MarketBbo,
  MarketMetricBasis,
  MarketMetricWindow,
  OrderBook,
  MarketTag,
} from "../domain/market.js";
import type {
  ExchangeId,
  OutcomeSide,
  TradeAction,
} from "../domain/primitives.js";
import { assertFiniteDecimal, serializeDecimal } from "../domain/primitives.js";
import type { AgentMemoryContext } from "./memory.js";
import { statelessMemoryContext } from "./memory.js";
import type { AgentStateContext } from "./agent-state.js";
import { statelessAgentStateContext } from "./agent-state.js";
import { calculatePerformance } from "../portfolio/performance.js";
import type { RecentPerformance } from "./recent-performance.js";
import { summarizeRecentPerformance } from "./recent-performance.js";
import type { OpportunityBoardItem } from "./opportunity-board.js";
import type { PreviousCycleAdvisory } from "../reporting/previous-cycle-advisory.js";

export interface PositionValuationInput {
  readonly marketSlug: string;
  readonly liquidationBid?: Decimal;
  readonly conservativeValue?: Decimal;
  readonly unrealizedPnl?: Decimal;
}

export interface PortfolioValuationInput {
  readonly conservativeAccountValue?: Decimal;
  readonly riskEquity?: Decimal;
  readonly spendableCapital?: Decimal;
  readonly positions?: readonly PositionValuationInput[];
}

export interface RiskConstraintsInput {
  readonly maximumPositionCostBasisFraction: Decimal;
  readonly maximumCycleSpendFraction: Decimal;
  readonly maximumExecutionSpread: Decimal;
  readonly kellyFraction: Decimal;
  readonly uncertaintyBoundWeight: Decimal;
  readonly duplicateWindowMinutes: number;
  readonly minimumIndependentSources: number;
  readonly allowNakedShorts: false;
  readonly emergencyExitEnabled: boolean;
  readonly managedRestingBuyOrders: {
    readonly enabled: boolean;
    readonly maximumLifetimeMinutes: number;
  };
}

export interface RecentExecutionOutcomeInput {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly status: ExecutionStatus;
  readonly quantity: Decimal;
  readonly filledQuantity: Decimal;
  readonly averageFillPrice?: Decimal;
  readonly fees: Decimal;
  readonly occurredAt: Date;
}

export interface BuildAgentContextInput {
  readonly observedAt: Date;
  readonly exchangeId: ExchangeId;
  readonly exchangeName: string;
  readonly account: AccountSnapshot;
  readonly marketCatalog: {
    readonly count: number;
    readonly categoryCounts: Readonly<Record<string, number>>;
  };
  readonly opportunityBoard?: readonly OpportunityBoardItem[];
  readonly preloadedMarkets: readonly PreloadedMarketInput[];
  readonly prebuiltMarketContexts?: readonly DetailedMarketContext[];
  readonly riskConstraints: RiskConstraintsInput;
  readonly valuation?: PortfolioValuationInput;
  readonly recentPerformance?: RecentPerformance;
  readonly criticalLearningPolicy?: CriticalLearningPolicy;
  readonly recentExecutionOutcomes?: readonly RecentExecutionOutcomeInput[];
  readonly previousCycle?: PreviousCycleAdvisory;
  readonly memory?: AgentMemoryContext;
  readonly agentState?: AgentStateContext;
}

export interface PreloadedMarketInput {
  readonly market: Market;
  readonly bbo?: MarketBbo;
  readonly book?: OrderBook;
  readonly held: boolean;
  readonly warnings?: readonly string[];
}

export interface BuildMarketDetailContextInput extends PreloadedMarketInput {
  readonly account: AccountSnapshot;
  readonly valuation?: PortfolioValuationInput;
}

export interface PositionContext {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly quantity: string;
  readonly availableQuantity: string;
  readonly costBasis: string;
  readonly costBasisFractionOfRiskEquity?: string;
  readonly realizedPnl: string;
  readonly exchangeCashValue?: string;
  readonly liquidationBid?: string;
  readonly conservativeValue?: string;
  readonly unrealizedPnl?: string;
  readonly expired: boolean;
  readonly updatedAt?: string;
}

export interface DetailedMarketContext {
  readonly id: string;
  readonly slug: string;
  readonly eventId?: string;
  readonly eventSlug?: string;
  readonly seriesId?: string;
  readonly seriesSlug?: string;
  readonly tags?: readonly MarketTag[];
  readonly title: string;
  readonly description: string;
  readonly settlementRules: string;
  readonly resolutionSource?: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly archived: boolean;
  readonly closesAt?: string;
  readonly liquidityUsd?: string;
  readonly volumeUsd?: string;
  readonly volume24hUsd?: string;
  readonly volume7dUsd?: string;
  readonly volume30dUsd?: string;
  readonly lastPrice?: string;
  readonly sessionOpenYesPrice?: string;
  readonly sessionCurrentYesPrice?: string;
  readonly sessionLastYesPrice?: string;
  readonly sessionHighYesPrice?: string;
  readonly sessionLowYesPrice?: string;
  readonly sessionBookObservedAt?: string;
  readonly priceMovement?: string;
  readonly priceMovementWindow?: MarketMetricWindow;
  readonly priceMovementBasis?: MarketMetricBasis;
  readonly volatility?: string;
  readonly volatilityWindow?: MarketMetricWindow;
  readonly volatilityBasis?: MarketMetricBasis;
  readonly openInterest?: string;
  readonly minimumTradeQuantity: string;
  readonly priceTick: string;
  readonly yesBid?: string;
  readonly yesAsk?: string;
  readonly noBid?: string;
  readonly noAsk?: string;
  readonly spread?: string;
  readonly quoteObservedAt?: string;
  readonly quoteAvailable: boolean;
  readonly warnings: readonly string[];
  readonly held: boolean;
  readonly existingExposure?: PositionContext;
  readonly officialLiveSnapshot?: string;
  readonly officialLiveSnapshotObservedAt?: string;
  readonly officialLivePositiveEdge?: boolean;
}

export interface AgentContext {
  readonly currentUtcTime: string;
  readonly exchange: { readonly id: ExchangeId; readonly name: string };
  readonly account: {
    readonly observedAt: string;
    readonly currentBalanceUsd: string;
    readonly buyingPowerUsd: string;
    readonly assetNotionalUsd: string;
    readonly assetAvailableUsd: string;
    readonly openOrderValueUsd: string;
    readonly unsettledFundsUsd: string;
    readonly marginRequirementUsd: string;
    readonly tradingPnlUsd: string;
    readonly depositsUsd: string;
    readonly withdrawalsUsd: string;
    readonly rebatesUsd: string;
    readonly programCreditsUsd: string;
    readonly otherBalanceChangesUsd: string;
    readonly conservativeAccountValueUsd?: string;
    readonly riskEquityUsd?: string;
    readonly spendableCapitalUsd?: string;
  };
  readonly positions: readonly PositionContext[];
  readonly recentPerformance: {
    readonly settlements: readonly {
      readonly marketSlug: string;
      readonly realizedPnlUsd: string;
      readonly resolvedAt: string;
    }[];
    readonly closedTrades: readonly {
      readonly tradeId: string;
      readonly marketSlug: string;
      readonly price: string;
      readonly quantity: string;
      readonly costBasisUsd: string;
      readonly realizedPnlUsd: string;
      readonly state: string;
      readonly aggressor: boolean;
      readonly createdAt: string;
      readonly updatedAt: string;
    }[];
    readonly settlementRealizedPnlUsd: string;
    readonly closedTradeRealizedPnlUsd: string;
    readonly profitableOutcomeCount: number;
    readonly losingOutcomeCount: number;
    readonly flatOutcomeCount: number;
    readonly bustedTradeCount: number;
  };
  readonly recentExecutionOutcomes: readonly {
    readonly marketSlug: string;
    readonly side: OutcomeSide;
    readonly action: TradeAction;
    readonly status: ExecutionStatus;
    readonly quantity: string;
    readonly filledQuantity: string;
    readonly averageFillPrice?: string;
    readonly feesUsd: string;
    readonly occurredAt: string;
  }[];
  readonly previousCycle?: PreviousCycleAdvisory;
  readonly criticalLearning: {
    readonly advisoryOnly: true;
    readonly realizedOutcomeSampleSize: number;
    readonly profitableMarketSlugs: readonly string[];
    readonly losingMarketSlugs: readonly string[];
    readonly winningPatternAssessment: string;
    readonly losingPatternAssessment: string;
    readonly positionManagementReminders: readonly string[];
  };
  readonly markets: {
    readonly catalogCount: number;
    readonly categoryCounts: Readonly<Record<string, number>>;
    readonly fullUniverseSearchable: true;
    readonly discoveryModes: readonly [
      "ALL",
      "KEYWORD",
      "CATEGORY",
      "TAG",
      "EVENT",
      "SERIES",
      "VOLUME",
      "VOLATILITY",
      "TRENDING",
      "EXPIRING",
    ];
    readonly preloaded: readonly DetailedMarketContext[];
    readonly opportunityBoard: readonly OpportunityBoardItem[];
  };
  readonly riskConstraints: {
    readonly maximumPositionCostBasisFraction: string;
    readonly maximumCycleSpendFraction: string;
    readonly maximumCycleSpendUsd?: string;
    readonly maximumExecutionSpread: string;
    readonly kellyFraction: string;
    readonly uncertaintyBoundWeight: string;
    readonly duplicateWindowMinutes: number;
    readonly minimumIndependentSources: number;
    readonly allowNakedShorts: false;
    readonly emergencyExitEnabled: boolean;
    readonly managedRestingBuyOrders: {
      readonly enabled: boolean;
      readonly maximumLifetimeMinutes: number;
    };
  };
  readonly memory: AgentMemoryContext;
  readonly agentState: AgentStateContext;
}

function isoDate(date: Date, fieldName: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date`);
  }
  return date.toISOString();
}

function decimalString(value: Decimal, fieldName: string): string {
  return serializeDecimal(assertFiniteDecimal(value, fieldName));
}

function optionalDecimalString(
  value: Decimal | undefined,
  fieldName: string,
): string | undefined {
  return value === undefined ? undefined : decimalString(value, fieldName);
}

function positionValuationMap(
  valuation: PortfolioValuationInput | undefined,
): ReadonlyMap<string, PositionValuationInput> {
  const result = new Map<string, PositionValuationInput>();
  for (const item of valuation?.positions ?? []) {
    if (result.has(item.marketSlug)) {
      throw new Error(`Duplicate position valuation for ${item.marketSlug}`);
    }
    result.set(item.marketSlug, item);
  }
  return result;
}

export type CriticalLearningPolicy = (
  performance: RecentPerformance,
  previousCycle: PreviousCycleAdvisory | undefined,
) => AgentContext["criticalLearning"];

function buildCriticalLearning(
  performance: RecentPerformance,
): AgentContext["criticalLearning"] {
  const outcomes = [...performance.settlements, ...performance.closedTrades];
  const profitableMarketSlugs = outcomes
    .filter((item) => item.realizedPnl.gt(0))
    .map((item) => item.marketSlug);
  const losingMarketSlugs = outcomes
    .filter((item) => item.realizedPnl.lt(0))
    .map((item) => item.marketSlug);
  return {
    advisoryOnly: true,
    realizedOutcomeSampleSize: outcomes.length,
    profitableMarketSlugs,
    losingMarketSlugs,
    winningPatternAssessment:
      "Realized outcome counts are reported without a strategy interpretation.",
    losingPatternAssessment:
      "Realized outcome counts are reported without a strategy interpretation.",
    positionManagementReminders: [
      "Historical summaries and notes are advisory; current evidence and validation remain required.",
    ],
  };
}

function buildPositions(
  account: AccountSnapshot,
  valuations: ReadonlyMap<string, PositionValuationInput>,
  riskEquity?: Decimal,
): readonly PositionContext[] {
  return account.positions.map((position) => {
    const valuation = valuations.get(position.marketSlug);
    const liquidationBid = optionalDecimalString(
      valuation?.liquidationBid,
      `valuation ${position.marketSlug} liquidationBid`,
    );
    const conservativeValue = optionalDecimalString(
      valuation?.conservativeValue,
      `valuation ${position.marketSlug} conservativeValue`,
    );
    const unrealizedPnl = optionalDecimalString(
      valuation?.unrealizedPnl,
      `valuation ${position.marketSlug} unrealizedPnl`,
    );
    const exchangeCashValue = optionalDecimalString(
      position.exchangeCashValue,
      `position ${position.marketSlug} exchangeCashValue`,
    );
    const costBasisFractionOfRiskEquity = optionalDecimalString(
      riskEquity?.gt(0) === true
        ? position.costBasis.div(riskEquity)
        : undefined,
      `position ${position.marketSlug} costBasisFractionOfRiskEquity`,
    );
    return {
      marketSlug: position.marketSlug,
      side: position.side,
      quantity: decimalString(position.quantity, "position quantity"),
      availableQuantity: decimalString(
        position.availableQuantity,
        "position availableQuantity",
      ),
      costBasis: decimalString(position.costBasis, "position costBasis"),
      ...(costBasisFractionOfRiskEquity === undefined
        ? {}
        : { costBasisFractionOfRiskEquity }),
      realizedPnl: decimalString(position.realizedPnl, "position realizedPnl"),
      ...(exchangeCashValue === undefined ? {} : { exchangeCashValue }),
      ...(liquidationBid === undefined ? {} : { liquidationBid }),
      ...(conservativeValue === undefined ? {} : { conservativeValue }),
      ...(unrealizedPnl === undefined ? {} : { unrealizedPnl }),
      expired: position.expired,
      ...(position.updatedAt === undefined
        ? {}
        : {
            updatedAt: isoDate(
              position.updatedAt,
              `position ${position.marketSlug} updatedAt`,
            ),
          }),
    };
  });
}

function buildDetailedMarket(
  input: PreloadedMarketInput,
  positions: ReadonlyMap<string, PositionContext>,
): DetailedMarketContext {
  const { market, bbo, book } = input;
  const yesBid = optionalDecimalString(bbo?.yes.bid, `${market.slug} yesBid`);
  const yesAsk = optionalDecimalString(bbo?.yes.ask, `${market.slug} yesAsk`);
  const noBid = optionalDecimalString(bbo?.no.bid, `${market.slug} noBid`);
  const noAsk = optionalDecimalString(bbo?.no.ask, `${market.slug} noAsk`);
  const spread = optionalDecimalString(
    bbo?.yes.spread ??
      (bbo?.yes.bid === undefined || bbo.yes.ask === undefined
        ? undefined
        : bbo.yes.ask.minus(bbo.yes.bid)),
    `${market.slug} spread`,
  );
  const liquidity = optionalDecimalString(
    market.liquidity,
    `${market.slug} liquidity`,
  );
  const volume = optionalDecimalString(market.volume, `${market.slug} volume`);
  const volume24h = optionalDecimalString(
    market.volume24h,
    `${market.slug} volume24h`,
  );
  const volume7d = optionalDecimalString(
    market.volume7d,
    `${market.slug} volume7d`,
  );
  const volume30d = optionalDecimalString(
    market.volume30d,
    `${market.slug} volume30d`,
  );
  const lastPrice = optionalDecimalString(
    market.lastPrice,
    `${market.slug} lastPrice`,
  );
  const sessionOpenYesPrice = optionalDecimalString(
    book?.openPrice,
    `${market.slug} sessionOpenYesPrice`,
  );
  const sessionCurrentYesPrice = optionalDecimalString(
    book?.currentPrice,
    `${market.slug} sessionCurrentYesPrice`,
  );
  const sessionLastYesPrice = optionalDecimalString(
    book?.lastPrice,
    `${market.slug} sessionLastYesPrice`,
  );
  const sessionHighYesPrice = optionalDecimalString(
    book?.highPrice,
    `${market.slug} sessionHighYesPrice`,
  );
  const sessionLowYesPrice = optionalDecimalString(
    book?.lowPrice,
    `${market.slug} sessionLowYesPrice`,
  );
  const sessionBookObservedAt =
    book === undefined
      ? undefined
      : isoDate(book.observedAt, `${market.slug} sessionBookObservedAt`);
  const priceMovement =
    market.priceMovement === undefined ||
    market.priceMovementWindow === undefined ||
    market.priceMovementBasis === undefined
      ? undefined
      : {
          value: decimalString(
            market.priceMovement,
            `${market.slug} priceMovement`,
          ),
          window: market.priceMovementWindow,
          basis: market.priceMovementBasis,
        };
  const volatility =
    market.volatility === undefined ||
    market.volatilityWindow === undefined ||
    market.volatilityBasis === undefined
      ? undefined
      : {
          value: decimalString(market.volatility, `${market.slug} volatility`),
          window: market.volatilityWindow,
          basis: market.volatilityBasis,
        };
  const openInterest = optionalDecimalString(
    market.openInterest,
    `${market.slug} openInterest`,
  );
  const exposure = positions.get(market.slug);
  const quoteObservedAt =
    bbo === undefined
      ? undefined
      : isoDate(bbo.observedAt, `${market.slug} quoteObservedAt`);

  return {
    id: market.id.value,
    slug: market.slug,
    ...(market.eventId === undefined ? {} : { eventId: market.eventId }),
    ...(market.eventSlug === undefined ? {} : { eventSlug: market.eventSlug }),
    ...(market.seriesId === undefined ? {} : { seriesId: market.seriesId }),
    ...(market.seriesSlug === undefined
      ? {}
      : { seriesSlug: market.seriesSlug }),
    ...(market.tags === undefined
      ? {}
      : {
          tags: market.tags.map((tag) => ({
            ...(tag.id === undefined ? {} : { id: tag.id }),
            slug: tag.slug,
            ...(tag.label === undefined ? {} : { label: tag.label }),
          })),
        }),
    title: market.title,
    description: market.description,
    settlementRules: market.settlementRules,
    ...(market.resolutionSource === undefined
      ? {}
      : { resolutionSource: market.resolutionSource }),
    category:
      market.category?.trim() === undefined ||
      market.category.trim().length === 0
        ? "Uncategorized"
        : market.category.trim(),
    ...(market.subcategory === undefined
      ? {}
      : { subcategory: market.subcategory }),
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    ...(market.closesAt === undefined
      ? {}
      : { closesAt: isoDate(market.closesAt, `${market.slug} closesAt`) }),
    ...(liquidity === undefined ? {} : { liquidityUsd: liquidity }),
    ...(volume === undefined ? {} : { volumeUsd: volume }),
    ...(volume24h === undefined ? {} : { volume24hUsd: volume24h }),
    ...(volume7d === undefined ? {} : { volume7dUsd: volume7d }),
    ...(volume30d === undefined ? {} : { volume30dUsd: volume30d }),
    ...(lastPrice === undefined ? {} : { lastPrice }),
    ...(sessionOpenYesPrice === undefined ? {} : { sessionOpenYesPrice }),
    ...(sessionCurrentYesPrice === undefined ? {} : { sessionCurrentYesPrice }),
    ...(sessionLastYesPrice === undefined ? {} : { sessionLastYesPrice }),
    ...(sessionHighYesPrice === undefined ? {} : { sessionHighYesPrice }),
    ...(sessionLowYesPrice === undefined ? {} : { sessionLowYesPrice }),
    ...(sessionBookObservedAt === undefined ? {} : { sessionBookObservedAt }),
    ...(priceMovement === undefined
      ? {}
      : {
          priceMovement: priceMovement.value,
          priceMovementWindow: priceMovement.window,
          priceMovementBasis: priceMovement.basis,
        }),
    ...(volatility === undefined
      ? {}
      : {
          volatility: volatility.value,
          volatilityWindow: volatility.window,
          volatilityBasis: volatility.basis,
        }),
    ...(openInterest === undefined ? {} : { openInterest }),
    minimumTradeQuantity: decimalString(
      market.minimumTradeQuantity,
      `${market.slug} minimumTradeQuantity`,
    ),
    priceTick: decimalString(market.priceTick, `${market.slug} priceTick`),
    ...(yesBid === undefined ? {} : { yesBid }),
    ...(yesAsk === undefined ? {} : { yesAsk }),
    ...(noBid === undefined ? {} : { noBid }),
    ...(noAsk === undefined ? {} : { noAsk }),
    ...(spread === undefined ? {} : { spread }),
    ...(quoteObservedAt === undefined ? {} : { quoteObservedAt }),
    quoteAvailable: bbo?.yes.bid !== undefined && bbo.yes.ask !== undefined,
    warnings: input.warnings ?? [],
    held: input.held,
    ...(exposure === undefined ? {} : { existingExposure: exposure }),
  };
}

export function buildMarketDetailContext(
  input: BuildMarketDetailContextInput,
): DetailedMarketContext {
  const valuations = positionValuationMap(input.valuation);
  const positions = buildPositions(
    input.account,
    valuations,
    input.valuation?.riskEquity,
  );
  return buildDetailedMarket(
    input,
    new Map(
      positions.map((position) => [position.marketSlug, position] as const),
    ),
  );
}

export function buildAgentContext(input: BuildAgentContextInput): AgentContext {
  const currentUtcTime = isoDate(input.observedAt, "observedAt");
  const accountObservedAt = isoDate(
    input.account.observedAt,
    "account.observedAt",
  );
  const valuations = positionValuationMap(input.valuation);
  const positions = buildPositions(
    input.account,
    valuations,
    input.valuation?.riskEquity,
  );
  const positionsBySlug = new Map(
    positions.map((position) => [position.marketSlug, position] as const),
  );
  const performance =
    input.recentPerformance ??
    summarizeRecentPerformance(input.account.recentActivities);
  const activityBreakdown = calculatePerformance(
    input.account.recentActivities,
  );

  const conservativeAccountValue = optionalDecimalString(
    input.valuation?.conservativeAccountValue,
    "valuation.conservativeAccountValue",
  );
  const riskEquity = optionalDecimalString(
    input.valuation?.riskEquity,
    "valuation.riskEquity",
  );
  const spendableCapital = optionalDecimalString(
    input.valuation?.spendableCapital,
    "valuation.spendableCapital",
  );
  const maximumCycleSpend = optionalDecimalString(
    input.valuation?.riskEquity?.mul(
      input.riskConstraints.maximumCycleSpendFraction,
    ),
    "risk maximumCycleSpendUsd",
  );

  return {
    currentUtcTime,
    exchange: { id: input.exchangeId, name: input.exchangeName },
    account: {
      observedAt: accountObservedAt,
      currentBalanceUsd: decimalString(
        input.account.currentBalance,
        "account.currentBalance",
      ),
      buyingPowerUsd: decimalString(
        input.account.buyingPower,
        "account.buyingPower",
      ),
      assetNotionalUsd: decimalString(
        input.account.assetNotional,
        "account.assetNotional",
      ),
      assetAvailableUsd: decimalString(
        input.account.assetAvailable,
        "account.assetAvailable",
      ),
      openOrderValueUsd: decimalString(
        input.account.openOrderValue,
        "account.openOrderValue",
      ),
      unsettledFundsUsd: decimalString(
        input.account.unsettledFunds,
        "account.unsettledFunds",
      ),
      marginRequirementUsd: decimalString(
        input.account.marginRequirement,
        "account.marginRequirement",
      ),
      tradingPnlUsd: decimalString(
        activityBreakdown.tradingPnl,
        "account tradingPnl",
      ),
      depositsUsd: decimalString(
        activityBreakdown.deposits,
        "account deposits",
      ),
      withdrawalsUsd: decimalString(
        activityBreakdown.withdrawals,
        "account withdrawals",
      ),
      rebatesUsd: decimalString(activityBreakdown.rebates, "account rebates"),
      programCreditsUsd: decimalString(
        activityBreakdown.programCredits,
        "account programCredits",
      ),
      otherBalanceChangesUsd: decimalString(
        activityBreakdown.otherBalanceChanges,
        "account otherBalanceChanges",
      ),
      ...(conservativeAccountValue === undefined
        ? {}
        : { conservativeAccountValueUsd: conservativeAccountValue }),
      ...(riskEquity === undefined ? {} : { riskEquityUsd: riskEquity }),
      ...(spendableCapital === undefined
        ? {}
        : { spendableCapitalUsd: spendableCapital }),
    },
    positions,
    recentPerformance: {
      settlements: performance.settlements.map((settlement) => ({
        marketSlug: settlement.marketSlug,
        realizedPnlUsd: decimalString(
          settlement.realizedPnl,
          "settlement realizedPnl",
        ),
        resolvedAt: isoDate(settlement.resolvedAt, "settlement resolvedAt"),
      })),
      closedTrades: performance.closedTrades.map((trade) => ({
        tradeId: trade.tradeId,
        marketSlug: trade.marketSlug,
        price: decimalString(trade.price, "closed trade price"),
        quantity: decimalString(trade.quantity, "closed trade quantity"),
        costBasisUsd: decimalString(trade.costBasis, "closed trade costBasis"),
        realizedPnlUsd: decimalString(
          trade.realizedPnl,
          "closed trade realizedPnl",
        ),
        state: trade.state,
        aggressor: trade.aggressor,
        createdAt: isoDate(trade.createdAt, "closed trade createdAt"),
        updatedAt: isoDate(trade.updatedAt, "closed trade updatedAt"),
      })),
      settlementRealizedPnlUsd: decimalString(
        performance.settlementRealizedPnl,
        "performance settlementRealizedPnl",
      ),
      closedTradeRealizedPnlUsd: decimalString(
        performance.closedTradeRealizedPnl,
        "performance closedTradeRealizedPnl",
      ),
      profitableOutcomeCount: performance.profitableOutcomeCount,
      losingOutcomeCount: performance.losingOutcomeCount,
      flatOutcomeCount: performance.flatOutcomeCount,
      bustedTradeCount: performance.bustedTradeCount,
    },
    recentExecutionOutcomes: (input.recentExecutionOutcomes ?? []).map(
      (outcome) => {
        const averageFillPrice = optionalDecimalString(
          outcome.averageFillPrice,
          "execution averageFillPrice",
        );
        return {
          marketSlug: outcome.marketSlug,
          side: outcome.side,
          action: outcome.action,
          status: outcome.status,
          quantity: decimalString(outcome.quantity, "execution quantity"),
          filledQuantity: decimalString(
            outcome.filledQuantity,
            "execution filledQuantity",
          ),
          ...(averageFillPrice === undefined ? {} : { averageFillPrice }),
          feesUsd: decimalString(outcome.fees, "execution fees"),
          occurredAt: isoDate(outcome.occurredAt, "execution occurredAt"),
        };
      },
    ),
    ...(input.previousCycle === undefined
      ? {}
      : { previousCycle: input.previousCycle }),
    criticalLearning:
      input.criticalLearningPolicy === undefined
        ? buildCriticalLearning(performance)
        : input.criticalLearningPolicy(performance, input.previousCycle),
    markets: {
      catalogCount: input.marketCatalog.count,
      categoryCounts: input.marketCatalog.categoryCounts,
      fullUniverseSearchable: true,
      discoveryModes: [
        "ALL",
        "KEYWORD",
        "CATEGORY",
        "TAG",
        "EVENT",
        "SERIES",
        "VOLUME",
        "VOLATILITY",
        "TRENDING",
        "EXPIRING",
      ],
      preloaded: [
        ...input.preloadedMarkets.map((market) =>
          buildDetailedMarket(market, positionsBySlug),
        ),
        ...(input.prebuiltMarketContexts ?? []),
      ],
      opportunityBoard: input.opportunityBoard ?? [],
    },
    riskConstraints: {
      maximumPositionCostBasisFraction: decimalString(
        input.riskConstraints.maximumPositionCostBasisFraction,
        "risk maximumPositionCostBasisFraction",
      ),
      maximumCycleSpendFraction: decimalString(
        input.riskConstraints.maximumCycleSpendFraction,
        "risk maximumCycleSpendFraction",
      ),
      ...(maximumCycleSpend === undefined
        ? {}
        : { maximumCycleSpendUsd: maximumCycleSpend }),
      maximumExecutionSpread: decimalString(
        input.riskConstraints.maximumExecutionSpread,
        "risk maximumExecutionSpread",
      ),
      kellyFraction: decimalString(
        input.riskConstraints.kellyFraction,
        "risk kellyFraction",
      ),
      uncertaintyBoundWeight: decimalString(
        input.riskConstraints.uncertaintyBoundWeight,
        "risk uncertaintyBoundWeight",
      ),
      duplicateWindowMinutes: input.riskConstraints.duplicateWindowMinutes,
      minimumIndependentSources:
        input.riskConstraints.minimumIndependentSources,
      allowNakedShorts: input.riskConstraints.allowNakedShorts,
      emergencyExitEnabled: input.riskConstraints.emergencyExitEnabled,
      managedRestingBuyOrders: {
        enabled: input.riskConstraints.managedRestingBuyOrders.enabled,
        maximumLifetimeMinutes:
          input.riskConstraints.managedRestingBuyOrders.maximumLifetimeMinutes,
      },
    },
    memory: input.memory ?? statelessMemoryContext(),
    agentState: input.agentState ?? statelessAgentStateContext(),
  };
}
