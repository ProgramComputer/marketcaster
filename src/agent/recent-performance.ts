import { Decimal } from "decimal.js";
import type {
  AccountActivity,
  ResolutionActivity,
  TradeActivity,
} from "../domain/activity.js";
import { isEffectiveTrade } from "../domain/activity.js";

export interface RecentPerformanceOptions {
  readonly maximumSettlements?: number;
  readonly maximumClosedTrades?: number;
}

export interface RecentSettlement {
  readonly marketSlug: string;
  readonly realizedPnl: Decimal;
  readonly resolvedAt: Date;
}

export interface RecentClosedTrade {
  readonly tradeId: string;
  readonly marketSlug: string;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly costBasis: Decimal;
  readonly realizedPnl: Decimal;
  readonly state: string;
  readonly aggressor: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RecentPerformance {
  readonly settlements: readonly RecentSettlement[];
  readonly closedTrades: readonly RecentClosedTrade[];
  readonly settlementRealizedPnl: Decimal;
  readonly closedTradeRealizedPnl: Decimal;
  readonly profitableOutcomeCount: number;
  readonly losingOutcomeCount: number;
  readonly flatOutcomeCount: number;
  readonly bustedTradeCount: number;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 100) {
    throw new RangeError(
      "Recent-performance limits must be integers from 0 to 100",
    );
  }
  return resolved;
}

function resolutionTime(activity: ResolutionActivity): number {
  return activity.resolvedAt.getTime();
}

function tradeTime(activity: TradeActivity): number {
  return activity.updatedAt.getTime();
}

function toSettlement(activity: ResolutionActivity): RecentSettlement {
  return {
    marketSlug: activity.marketSlug,
    realizedPnl: activity.realizedPnl,
    resolvedAt: activity.resolvedAt,
  };
}

function toClosedTrade(activity: TradeActivity): RecentClosedTrade {
  if (activity.realizedPnl === undefined) {
    throw new TypeError("Closed trade is missing authoritative realized PnL");
  }
  return {
    tradeId: activity.tradeId,
    marketSlug: activity.marketSlug,
    price: activity.price,
    quantity: activity.quantity,
    costBasis: activity.costBasis,
    realizedPnl: activity.realizedPnl,
    state: activity.state,
    aggressor: activity.aggressor,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
  };
}

export function summarizeRecentPerformance(
  activities: readonly AccountActivity[],
  options: RecentPerformanceOptions = {},
): RecentPerformance {
  const maximumSettlements = boundedLimit(options.maximumSettlements, 10);
  const maximumClosedTrades = boundedLimit(options.maximumClosedTrades, 10);

  const settlements = activities
    .filter(
      (activity): activity is ResolutionActivity =>
        activity.kind === "RESOLUTION",
    )
    .sort((left, right) => resolutionTime(right) - resolutionTime(left))
    .slice(0, maximumSettlements)
    .map(toSettlement);

  // A non-zero realized PnL is the canonical activity signal available here for
  // a reducing/closing fill. Busted trades remain countable for observability
  // but never contribute to history or PnL.
  const closedTrades = activities
    .filter(isEffectiveTrade)
    .filter(
      (activity) =>
        activity.realizedPnl !== undefined && !activity.realizedPnl.eq(0),
    )
    .sort((left, right) => tradeTime(right) - tradeTime(left))
    .slice(0, maximumClosedTrades)
    .map(toClosedTrade);

  const settlementRealizedPnl = settlements.reduce(
    (total, settlement) => total.plus(settlement.realizedPnl),
    new Decimal(0),
  );
  const closedTradeRealizedPnl = closedTrades.reduce(
    (total, trade) => total.plus(trade.realizedPnl),
    new Decimal(0),
  );
  const outcomes = [
    ...settlements.map((settlement) => settlement.realizedPnl),
    ...closedTrades.map((trade) => trade.realizedPnl),
  ];

  return {
    settlements,
    closedTrades,
    settlementRealizedPnl,
    closedTradeRealizedPnl,
    profitableOutcomeCount: outcomes.filter((pnl) => pnl.gt(0)).length,
    losingOutcomeCount: outcomes.filter((pnl) => pnl.lt(0)).length,
    flatOutcomeCount: outcomes.filter((pnl) => pnl.eq(0)).length,
    bustedTradeCount: activities.filter(
      (activity) =>
        activity.kind === "TRADE" && activity.state === "TRADE_STATE_BUSTED",
    ).length,
  };
}
