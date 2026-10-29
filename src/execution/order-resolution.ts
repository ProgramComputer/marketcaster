import { Decimal } from "decimal.js";
import type { TradeActivity } from "../domain/activity.js";
import type { ExecutionResult } from "../domain/execution.js";
import type { ExchangeOrder } from "../domain/order.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";

export interface SubmittedImmediateOrder {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly canonicalLimitPrice: Decimal;
  readonly quantity: Decimal;
}

export interface ImmediateOrderEvidence {
  readonly order: SubmittedImmediateOrder;
  /** Position on the order's side when the order was submitted. */
  readonly quantityBefore: Decimal;
  /** Position on the order's side now. */
  readonly quantityNow: Decimal;
  readonly openOrders: readonly ExchangeOrder[];
  /** The account's trades in the order's market inside the submission window. */
  readonly trades: readonly TradeActivity[];
}

export type ImmediateOrderProof =
  | { readonly proven: true; readonly result: ExecutionResult }
  | { readonly proven: false; readonly reason: string };

/** The fill's price on `side`; adapters report the YES price for a fill without a side. */
function priceOnSide(
  trade: TradeActivity,
  side: OutcomeSide,
): Decimal | undefined {
  if (trade.side !== undefined) {
    return trade.side === side ? trade.price : undefined;
  }
  const yesPrice = trade.yesPrice ?? trade.price;
  return side === "YES" ? yesPrice : new Decimal(1).minus(yesPrice);
}

function refuse(reason: string): ImmediateOrderProof {
  return { proven: false, reason };
}

/**
 * Proves an immediate-or-cancel order's outcome from account state alone, for
 * an order whose exchange response was lost. Every check must agree; anything
 * else leaves the order unresolved.
 */
export function proveImmediateOrderOutcome(
  evidence: ImmediateOrderEvidence,
): ImmediateOrderProof {
  const { order } = evidence;
  if (
    evidence.openOrders.some((open) => open.marketSlug === order.marketSlug)
  ) {
    return refuse("An order in the market is still open");
  }
  let quantity = new Decimal(0);
  let notional = new Decimal(0);
  let fees = new Decimal(0);
  for (const trade of evidence.trades) {
    if (trade.marketSlug !== order.marketSlug) {
      return refuse("A trade belongs to another market");
    }
    if (!trade.aggressor) {
      return refuse("A trade in the window did not take liquidity");
    }
    if (trade.state === "TRADE_STATE_BUSTED") {
      return refuse("A trade in the window was busted");
    }
    if (trade.action !== undefined && trade.action !== order.action) {
      return refuse("A trade in the window has the opposite action");
    }
    const price = priceOnSide(trade, order.side);
    if (price === undefined) {
      return refuse("A trade in the window is on the other side");
    }
    const withinLimit =
      order.action === "BUY"
        ? price.lte(order.canonicalLimitPrice)
        : price.gte(order.canonicalLimitPrice);
    if (!price.gt(0) || !price.lt(1) || !withinLimit) {
      return refuse("A trade price is outside the order's limit");
    }
    quantity = quantity.plus(trade.quantity);
    notional = notional.plus(trade.quantity.mul(price));
    fees = fees.plus(trade.fees ?? 0);
  }
  if (quantity.gt(order.quantity)) {
    return refuse("Trades exceed the ordered quantity");
  }
  const positionChange =
    order.action === "BUY"
      ? evidence.quantityNow.minus(evidence.quantityBefore)
      : evidence.quantityBefore.minus(evidence.quantityNow);
  if (!positionChange.eq(quantity)) {
    return refuse("The position change does not equal the traded quantity");
  }
  if (quantity.eq(0)) {
    return {
      proven: true,
      result: {
        status: "NO_FILL",
        filledQuantity: quantity,
        fees,
        finalState: "CANCELED",
      },
    };
  }
  const filled = quantity.eq(order.quantity);
  return {
    proven: true,
    result: {
      status: filled ? "FILLED" : "PARTIAL",
      filledQuantity: quantity,
      averageFillPrice: notional.div(quantity).toDecimalPlaces(6),
      fees,
      // An immediate order's unfilled remainder is canceled.
      finalState: filled ? "FILLED" : "CANCELED",
    },
  };
}
