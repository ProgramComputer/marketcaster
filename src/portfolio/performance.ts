import { Decimal } from "decimal.js";
import type {
  AccountActivity,
  BalanceChangeActivity,
  TradeActivity,
} from "../domain/activity.js";

export interface PerformanceBreakdown {
  readonly tradingPnl: Decimal;
  readonly deposits: Decimal;
  readonly withdrawals: Decimal;
  readonly rebates: Decimal;
  readonly programCredits: Decimal;
  readonly otherBalanceChanges: Decimal;
  readonly effectiveTrades: readonly TradeActivity[];
}

function latestTradeStates(
  activities: readonly AccountActivity[],
): readonly TradeActivity[] {
  const byId = new Map<string, TradeActivity>();
  for (const activity of activities) {
    if (activity.kind !== "TRADE") continue;
    const previous = byId.get(activity.tradeId);
    if (previous === undefined || activity.updatedAt > previous.updatedAt) {
      byId.set(activity.tradeId, activity);
    }
  }
  return [...byId.values()].filter(
    (trade) => trade.state !== "TRADE_STATE_BUSTED",
  );
}

function balanceBucket(
  activity: BalanceChangeActivity,
):
  | "deposits"
  | "withdrawals"
  | "rebates"
  | "programCredits"
  | "otherBalanceChanges"
  | undefined {
  const type = activity.activityType.toUpperCase();
  // Polymarket emits this internal advance alongside the account deposit it
  // funds. It is not a second external cash contribution.
  if (type === "ACTIVITY_TYPE_ACCOUNT_ADVANCED_DEPOSIT") return undefined;
  if (type.includes("DEPOSIT")) return "deposits";
  if (type.includes("WITHDRAW")) return "withdrawals";
  if (type.includes("REBATE")) return "rebates";
  if (/(REFERRAL|LIQUIDITY|PROGRAM|PROMOTION)/u.test(type)) {
    return "programCredits";
  }
  return "otherBalanceChanges";
}

export function calculatePerformance(
  activities: readonly AccountActivity[],
): PerformanceBreakdown {
  const effectiveTrades = latestTradeStates(activities);
  const resolutionPnl = activities.reduce(
    (total, activity) =>
      activity.kind === "RESOLUTION" ? total.plus(activity.realizedPnl) : total,
    new Decimal(0),
  );
  const tradePnl = effectiveTrades.reduce(
    (total, trade) =>
      trade.realizedPnl === undefined ? total : total.plus(trade.realizedPnl),
    new Decimal(0),
  );
  const buckets = {
    deposits: new Decimal(0),
    withdrawals: new Decimal(0),
    rebates: new Decimal(0),
    programCredits: new Decimal(0),
    otherBalanceChanges: new Decimal(0),
  };
  for (const activity of activities) {
    if (activity.kind !== "BALANCE_CHANGE") continue;
    const bucket = balanceBucket(activity);
    if (bucket === undefined) continue;
    buckets[bucket] = buckets[bucket].plus(activity.amount);
  }

  return {
    tradingPnl: tradePnl.plus(resolutionPnl),
    ...buckets,
    effectiveTrades,
  };
}
