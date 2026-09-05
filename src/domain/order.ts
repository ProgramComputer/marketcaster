import type { Decimal } from "decimal.js";
import type { MarketId, OutcomeSide, TradeAction } from "./primitives.js";

export type OrderState =
  | "NEW"
  | "OPEN"
  | "INFLIGHT"
  | "PARTIALLY_FILLED"
  | "PENDING_CLEARING"
  | "CLEARED"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED"
  | "BUSTED"
  | "UNKNOWN";

export type OrderExecutionPolicy =
  "IOC" | "GTD" | "GTC" | "DAY" | "FOK" | "UNKNOWN";

export interface ExchangeOrder {
  readonly id: string;
  readonly marketId: MarketId;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly canonicalPrice: Decimal;
  readonly quantity: Decimal;
  readonly filledQuantity: Decimal;
  readonly remainingQuantity?: Decimal;
  readonly averageFillPrice?: Decimal;
  readonly fees?: Decimal;
  readonly executionPolicy?: OrderExecutionPolicy;
  readonly restUntil?: Date;
  readonly state: OrderState;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface ImmediateOrder {
  readonly marketId: MarketId;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly canonicalLimitPrice: Decimal;
  readonly quantity: Decimal;
  /** Missing preserves the existing IOC behavior. */
  readonly executionPolicy?: "IOC" | "GTD";
  /** Engine-generated expiry. Required for GTD; never model-controlled. */
  readonly restUntil?: Date;
}

export type OrderPreviewPurpose = "ADVISORY" | "PLACEMENT";

export interface OrderPreview {
  readonly accepted: boolean;
  readonly estimatedFees: Decimal;
  readonly estimatedPrincipal?: Decimal;
  readonly estimatedCollateral?: Decimal;
  readonly warnings: readonly string[];
  readonly rejectionReasons: readonly string[];
  readonly rawStatus?: string;
  readonly basis?: "EXCHANGE" | "LOCAL_CONSERVATIVE";
  readonly observedAt?: Date;
}
