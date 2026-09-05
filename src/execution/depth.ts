import { Decimal } from "decimal.js";
import type { DepthResult } from "../domain/execution.js";
import type { OrderBook, QuoteLevel } from "../domain/market.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";

const ZERO_DEPTH: DepthResult = {
  fillableQuantity: new Decimal(0),
  principal: new Decimal(0),
  vwap: new Decimal(0),
  worstPrice: new Decimal(0),
  fullyFillable: false,
};

/** Total buy-side principal inside an explicit distance from the best ask. */
export function nearTouchBuyNotional(
  book: OrderBook,
  side: OutcomeSide,
  priceBand: Decimal,
  maximumPrice = new Decimal(1),
): Decimal {
  if (!priceBand.isFinite() || priceBand.lt(0))
    throw new RangeError("Depth price band must be finite and non-negative");
  const levels = canonicalBookLevels(book, side, "BUY").filter(
    (level) =>
      level.price.isFinite() &&
      level.price.gt(0) &&
      level.price.lte(1) &&
      level.quantity.isFinite() &&
      level.quantity.gt(0),
  );
  if (levels.length === 0) return new Decimal(0);
  const best = Decimal.min(...levels.map((level) => level.price));
  const ceiling = Decimal.min(best.plus(priceBand), maximumPrice);
  return levels
    .filter((level) => level.price.lte(ceiling))
    .reduce(
      (total, level) => total.plus(level.price.mul(level.quantity)),
      new Decimal(0),
    );
}

function walkLevels(
  levels: readonly QuoteLevel[],
  requestedQuantity: Decimal,
): DepthResult {
  if (requestedQuantity.lte(0) || levels.length === 0) return ZERO_DEPTH;

  let remaining = requestedQuantity;
  let fillableQuantity = new Decimal(0);
  let principal = new Decimal(0);
  let worstPrice = new Decimal(0);

  for (const level of levels) {
    if (remaining.lte(0)) break;
    if (level.quantity.lte(0) || level.price.lt(0) || level.price.gt(1))
      continue;
    const consumed = Decimal.min(remaining, level.quantity);
    fillableQuantity = fillableQuantity.plus(consumed);
    principal = principal.plus(consumed.mul(level.price));
    remaining = remaining.minus(consumed);
    worstPrice = level.price;
  }

  if (fillableQuantity.isZero()) return ZERO_DEPTH;
  return {
    fillableQuantity,
    principal,
    vwap: principal.div(fillableQuantity),
    worstPrice,
    fullyFillable: fillableQuantity.gte(requestedQuantity),
  };
}

export function calculateBuyVwap(
  asks: readonly QuoteLevel[],
  requestedQuantity: Decimal,
  maximumPrice: Decimal,
): DepthResult {
  const eligible = asks
    .filter((level) => level.price.lte(maximumPrice))
    .toSorted((left, right) => left.price.comparedTo(right.price));
  return walkLevels(eligible, requestedQuantity);
}

export function calculateSaleVwap(
  bids: readonly QuoteLevel[],
  requestedQuantity: Decimal,
  minimumPrice: Decimal,
): DepthResult {
  const eligible = bids
    .filter((level) => level.price.gte(minimumPrice))
    .toSorted((left, right) => right.price.comparedTo(left.price));
  return walkLevels(eligible, requestedQuantity);
}

export function canonicalBookLevels(
  book: OrderBook,
  side: OutcomeSide,
  action: TradeAction,
): readonly QuoteLevel[] {
  if (side === "YES") {
    return action === "BUY" ? book.yesAsks : book.yesBids;
  }

  if (action === "BUY") {
    return book.yesBids
      .map((level) => ({
        price: new Decimal(1).minus(level.price),
        quantity: level.quantity,
      }))
      .toSorted((left, right) => left.price.comparedTo(right.price));
  }

  return book.yesAsks
    .map((level) => ({
      price: new Decimal(1).minus(level.price),
      quantity: level.quantity,
    }))
    .toSorted((left, right) => right.price.comparedTo(left.price));
}

export function totalEligibleQuantity(
  levels: readonly QuoteLevel[],
  action: TradeAction,
  limitPrice: Decimal,
): Decimal {
  return levels.reduce(
    (total, level) =>
      action === "BUY"
        ? level.price.lte(limitPrice)
          ? total.plus(level.quantity)
          : total
        : level.price.gte(limitPrice)
          ? total.plus(level.quantity)
          : total,
    new Decimal(0),
  );
}

export function walkCanonicalBook(
  book: OrderBook,
  side: OutcomeSide,
  action: TradeAction,
  requestedQuantity: Decimal,
  limitPrice: Decimal,
): DepthResult {
  const levels = canonicalBookLevels(book, side, action);
  return action === "BUY"
    ? calculateBuyVwap(levels, requestedQuantity, limitPrice)
    : calculateSaleVwap(levels, requestedQuantity, limitPrice);
}
