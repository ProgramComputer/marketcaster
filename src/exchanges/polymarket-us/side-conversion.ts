import { Decimal } from "decimal.js";

import type { ImmediateOrder } from "../../domain/order.js";
import type { OutcomeSide, TradeAction } from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";

export type PolymarketOrderIntent =
  | "ORDER_INTENT_BUY_LONG"
  | "ORDER_INTENT_SELL_LONG"
  | "ORDER_INTENT_BUY_SHORT"
  | "ORDER_INTENT_SELL_SHORT";

export type PolymarketOrderSide = "ORDER_SIDE_BUY" | "ORDER_SIDE_SELL";

export interface CanonicalOrderConversion {
  readonly intent: PolymarketOrderIntent;
  readonly orderSide: PolymarketOrderSide;
  readonly submittedYesPrice: Decimal;
}

const ONE = new Decimal(1);

function assertProbability(price: Decimal, fieldName: string): void {
  if (!price.isFinite() || price.lt(0) || price.gt(1)) {
    throw new ExchangeError(
      `${fieldName} must be a finite probability between 0 and 1`,
      "INVALID_REQUEST",
    );
  }
}

/** Converts a canonical YES/NO price to the price of the underlying YES instrument. */
export function canonicalPriceToYesPrice(
  side: OutcomeSide,
  canonicalPrice: Decimal,
): Decimal {
  assertProbability(canonicalPrice, "canonicalPrice");
  return side === "YES" ? canonicalPrice : ONE.minus(canonicalPrice);
}

/** Converts an underlying YES-instrument price back to a canonical side price. */
export function yesPriceToCanonicalPrice(
  side: OutcomeSide,
  submittedYesPrice: Decimal,
): Decimal {
  assertProbability(submittedYesPrice, "submittedYesPrice");
  return side === "YES" ? submittedYesPrice : ONE.minus(submittedYesPrice);
}

export function canonicalOrderToPolymarket(
  order: Pick<ImmediateOrder, "side" | "action" | "canonicalLimitPrice">,
): CanonicalOrderConversion {
  const submittedYesPrice = canonicalPriceToYesPrice(
    order.side,
    order.canonicalLimitPrice,
  );

  if (order.side === "YES" && order.action === "BUY") {
    return {
      intent: "ORDER_INTENT_BUY_LONG",
      orderSide: "ORDER_SIDE_BUY",
      submittedYesPrice,
    };
  }
  if (order.side === "YES" && order.action === "SELL") {
    return {
      intent: "ORDER_INTENT_SELL_LONG",
      orderSide: "ORDER_SIDE_SELL",
      submittedYesPrice,
    };
  }
  if (order.side === "NO" && order.action === "BUY") {
    return {
      intent: "ORDER_INTENT_BUY_SHORT",
      orderSide: "ORDER_SIDE_SELL",
      submittedYesPrice,
    };
  }
  return {
    intent: "ORDER_INTENT_SELL_SHORT",
    orderSide: "ORDER_SIDE_BUY",
    submittedYesPrice,
  };
}

export function canonicalFromPolymarketIntent(intent: PolymarketOrderIntent): {
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly orderSide: PolymarketOrderSide;
} {
  switch (intent) {
    case "ORDER_INTENT_BUY_LONG":
      return { side: "YES", action: "BUY", orderSide: "ORDER_SIDE_BUY" };
    case "ORDER_INTENT_SELL_LONG":
      return { side: "YES", action: "SELL", orderSide: "ORDER_SIDE_SELL" };
    case "ORDER_INTENT_BUY_SHORT":
      return { side: "NO", action: "BUY", orderSide: "ORDER_SIDE_SELL" };
    case "ORDER_INTENT_SELL_SHORT":
      return { side: "NO", action: "SELL", orderSide: "ORDER_SIDE_BUY" };
  }
}

export function assertConsistentPolymarketSide(
  intent: PolymarketOrderIntent,
  orderSide: PolymarketOrderSide,
): void {
  const expected = canonicalFromPolymarketIntent(intent).orderSide;
  if (orderSide !== expected) {
    throw new ExchangeError(
      `Polymarket order side ${orderSide} contradicts intent ${intent}`,
      "SCHEMA",
    );
  }
}

export function noBidFromYesAsk(yesAsk: Decimal): Decimal {
  return canonicalPriceToYesPrice("NO", yesAsk);
}

export function noAskFromYesBid(yesBid: Decimal): Decimal {
  return canonicalPriceToYesPrice("NO", yesBid);
}
