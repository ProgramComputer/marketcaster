import type { Decimal } from "decimal.js";
import type { OrderState } from "./order.js";

export type ExecutionStatus =
  "WORKING" | "FILLED" | "PARTIAL" | "NO_FILL" | "REJECTED" | "AMBIGUOUS";

export interface ExecutionResult {
  readonly status: ExecutionStatus;
  readonly orderId?: string;
  readonly filledQuantity: Decimal;
  readonly remainingQuantity?: Decimal;
  readonly averageFillPrice?: Decimal;
  readonly fees: Decimal;
  readonly finalState: OrderState;
  readonly rejectionReason?: string;
  readonly ambiguousReason?: string;
}

export interface DepthResult {
  readonly fillableQuantity: Decimal;
  readonly principal: Decimal;
  readonly vwap: Decimal;
  readonly worstPrice: Decimal;
  readonly fullyFillable: boolean;
}
