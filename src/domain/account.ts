import type { Decimal } from "decimal.js";
import type { AccountActivity } from "./activity.js";
import type { ExchangeOrder } from "./order.js";
import type { Position } from "./position.js";

export interface AccountSnapshot {
  readonly observedAt: Date;
  readonly currentBalance: Decimal;
  readonly buyingPower: Decimal;
  readonly assetNotional: Decimal;
  readonly assetAvailable: Decimal;
  readonly openOrderValue: Decimal;
  readonly unsettledFunds: Decimal;
  readonly marginRequirement: Decimal;
  readonly positions: readonly Position[];
  readonly openOrders: readonly ExchangeOrder[];
  readonly recentActivities: readonly AccountActivity[];
}
