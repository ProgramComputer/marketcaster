import type { Decimal } from "decimal.js";
import type { MarketId, OutcomeSide } from "./primitives.js";

export interface Position {
  readonly marketId: MarketId;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly quantity: Decimal;
  readonly availableQuantity: Decimal;
  readonly costBasis: Decimal;
  readonly realizedPnl: Decimal;
  readonly exchangeCashValue?: Decimal;
  readonly expired: boolean;
  readonly updatedAt?: Date;
}
