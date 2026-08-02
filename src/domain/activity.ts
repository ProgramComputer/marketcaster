import type { Decimal } from "decimal.js";
import type { OutcomeSide, TradeAction } from "./primitives.js";

export type AccountActivity =
  TradeActivity | ResolutionActivity | BalanceChangeActivity;

export interface TradeActivity {
  readonly kind: "TRADE";
  readonly tradeId: string;
  readonly marketSlug: string;
  readonly side?: OutcomeSide;
  readonly action?: TradeAction;
  readonly yesPrice?: Decimal;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly costBasis: Decimal;
  readonly fees?: Decimal;
  /** Omitted while the exchange has not reported authoritative realized PnL. */
  readonly realizedPnl?: Decimal;
  readonly state: string;
  readonly aggressor: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ResolutionActivity {
  readonly kind: "RESOLUTION";
  readonly marketSlug: string;
  readonly realizedPnl: Decimal;
  readonly resolvedAt: Date;
}

export interface BalanceChangeActivity {
  readonly kind: "BALANCE_CHANGE";
  readonly activityType: string;
  readonly amount: Decimal;
  readonly createdAt: Date;
}

export interface ActivityQuery {
  readonly marketSlug?: string;
  readonly kinds?: readonly AccountActivity["kind"][];
  readonly createdAfter?: Date;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sortOrder?: "ASCENDING" | "DESCENDING";
}

export function isEffectiveTrade(
  activity: AccountActivity,
): activity is TradeActivity {
  return activity.kind === "TRADE" && activity.state !== "TRADE_STATE_BUSTED";
}
