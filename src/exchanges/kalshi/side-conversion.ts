import { Decimal } from "decimal.js";

import type { ImmediateOrder } from "../../domain/order.js";
import type { OutcomeSide, TradeAction } from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";

const ONE = new Decimal(1);

export type KalshiBookSide = "bid" | "ask";

export interface KalshiOrderConversion {
  readonly bookSide: KalshiBookSide;
  readonly yesPrice: Decimal;
}

export function canonicalPriceToYesPrice(
  side: OutcomeSide,
  canonicalPrice: Decimal,
): Decimal {
  return side === "YES" ? canonicalPrice : ONE.minus(canonicalPrice);
}

export function yesPriceToCanonicalPrice(
  side: OutcomeSide,
  yesPrice: Decimal,
): Decimal {
  return side === "YES" ? yesPrice : ONE.minus(yesPrice);
}

/**
 * Kalshi's current V2 order endpoint exposes one YES-priced book. A bid buys
 * YES (and is economically equivalent to selling NO); an ask sells YES (and
 * is economically equivalent to buying NO).
 */
export function canonicalOrderToKalshi(
  order: Pick<ImmediateOrder, "side" | "action" | "canonicalLimitPrice">,
): KalshiOrderConversion {
  const yesPrice = canonicalPriceToYesPrice(
    order.side,
    order.canonicalLimitPrice,
  );
  const bookSide: KalshiBookSide =
    (order.side === "YES" && order.action === "BUY") ||
    (order.side === "NO" && order.action === "SELL")
      ? "bid"
      : "ask";
  return { bookSide, yesPrice };
}

export function canonicalFromLegacyKalshiOrder(
  side: "yes" | "no",
  action: "buy" | "sell",
): { readonly side: OutcomeSide; readonly action: TradeAction } {
  return {
    side: side === "yes" ? "YES" : "NO",
    action: action === "buy" ? "BUY" : "SELL",
  };
}

/**
 * New Kalshi responses may omit the deprecated action/side pair. In that case
 * normalize the economic exposure as a buy of the reported outcome.
 */
export function canonicalFromKalshiDirection(
  outcomeSide: "yes" | "no" | undefined,
  bookSide: KalshiBookSide | undefined,
  legacySide?: "yes" | "no",
  legacyAction?: "buy" | "sell",
): { readonly side: OutcomeSide; readonly action: TradeAction } {
  const normalizedOutcome =
    outcomeSide ??
    (bookSide === undefined ? undefined : bookSide === "bid" ? "yes" : "no");
  if (
    normalizedOutcome !== undefined &&
    bookSide !== undefined &&
    (normalizedOutcome === "yes") !== (bookSide === "bid")
  ) {
    throw new ExchangeError(
      "Kalshi outcome_side contradicts book_side",
      "SCHEMA",
    );
  }

  if (legacySide !== undefined && legacyAction !== undefined) {
    const legacy = canonicalFromLegacyKalshiOrder(legacySide, legacyAction);
    const expectedOutcome =
      (legacy.side === "YES" && legacy.action === "BUY") ||
      (legacy.side === "NO" && legacy.action === "SELL")
        ? "yes"
        : "no";
    if (
      normalizedOutcome !== undefined &&
      normalizedOutcome !== expectedOutcome
    ) {
      throw new ExchangeError(
        "Kalshi order direction contradicts legacy action/side",
        "SCHEMA",
      );
    }
    if (normalizedOutcome === undefined) return legacy;
  }

  if (normalizedOutcome === undefined) {
    throw new ExchangeError("Kalshi order direction is missing", "SCHEMA");
  }
  return {
    side: normalizedOutcome === "yes" ? "YES" : "NO",
    action: "BUY",
  };
}
