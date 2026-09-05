import { Decimal } from "decimal.js";

export const DEFAULT_TAKER_FEE_THETA = new Decimal("0.06");
export const KALSHI_TAKER_FEE_THETA = new Decimal("0.07");
const KALSHI_ROUNDING_RESERVE = new Decimal("0.01");
const KALSHI_FEE_ROUNDING_INCREMENT = new Decimal("0.0001");
const KALSHI_MINIMUM_FILL_QUANTITY = new Decimal("0.01");

export function estimateTakerFeePerContract(
  price: Decimal,
  theta = DEFAULT_TAKER_FEE_THETA,
): Decimal {
  if (price.lt(0) || price.gt(1)) {
    throw new RangeError("Contract price must be between zero and one");
  }
  return theta.mul(price).mul(new Decimal(1).minus(price));
}

export function estimateTakerFee(
  quantity: Decimal,
  price: Decimal,
  theta = DEFAULT_TAKER_FEE_THETA,
): Decimal {
  if (quantity.lt(0)) throw new RangeError("Quantity cannot be negative");
  return quantity.mul(estimateTakerFeePerContract(price, theta));
}

export function feeMaximizingPriceWithinLimit(
  canonicalLimitPrice: Decimal,
  action: "BUY" | "SELL",
): Decimal {
  if (canonicalLimitPrice.lt(0) || canonicalLimitPrice.gt(1)) {
    throw new RangeError("Contract price must be between zero and one");
  }
  return action === "BUY"
    ? Decimal.min(canonicalLimitPrice, new Decimal("0.5"))
    : Decimal.max(canonicalLimitPrice, new Decimal("0.5"));
}

export function estimateTakerFeeUpperBound(
  quantity: Decimal,
  canonicalLimitPrice: Decimal,
  action: "BUY" | "SELL",
  theta = DEFAULT_TAKER_FEE_THETA,
): Decimal {
  return estimateTakerFee(
    quantity,
    feeMaximizingPriceWithinLimit(canonicalLimitPrice, action),
    theta,
  );
}

export function estimateExchangeTakerFee(
  exchangeId: string,
  quantity: Decimal,
  price: Decimal,
): Decimal {
  if (exchangeId !== "kalshi") return estimateTakerFee(quantity, price);
  return estimateTakerFee(quantity, price, KALSHI_TAKER_FEE_THETA)
    .toDecimalPlaces(4, Decimal.ROUND_CEIL)
    .plus(KALSHI_ROUNDING_RESERVE);
}

export function estimateKalshiTakerFeeUpperBound(
  quantity: Decimal,
  canonicalLimitPrice: Decimal,
  action: "BUY" | "SELL",
  feeMultiplier: Decimal,
): Decimal {
  if (quantity.lt(0)) throw new RangeError("Quantity cannot be negative");
  if (canonicalLimitPrice.lt(0) || canonicalLimitPrice.gt(1)) {
    throw new RangeError("Contract price must be between zero and one");
  }
  if (!feeMultiplier.isFinite() || feeMultiplier.lt(0)) {
    throw new RangeError(
      "Kalshi fee multiplier must be nonnegative and finite",
    );
  }
  if (!quantity.mod(KALSHI_MINIMUM_FILL_QUANTITY).isZero()) {
    throw new RangeError("Kalshi quantity must align to 0.01 contracts");
  }
  const worstFillPrice = feeMaximizingPriceWithinLimit(
    canonicalLimitPrice,
    action,
  );
  const microFillFee = estimateTakerFee(
    KALSHI_MINIMUM_FILL_QUANTITY,
    worstFillPrice,
    KALSHI_TAKER_FEE_THETA.mul(feeMultiplier),
  )
    .div(KALSHI_FEE_ROUNDING_INCREMENT)
    .ceil()
    .mul(KALSHI_FEE_ROUNDING_INCREMENT);
  return microFillFee
    .mul(quantity.div(KALSHI_MINIMUM_FILL_QUANTITY))
    .plus(KALSHI_ROUNDING_RESERVE);
}

export function estimateExchangeTakerFeePerContract(
  exchangeId: string,
  price: Decimal,
): Decimal {
  return estimateExchangeTakerFee(exchangeId, new Decimal(1), price);
}

export function calculateNetEdge(
  estimatedProbability: Decimal,
  executablePrice: Decimal,
  feePerContract: Decimal,
): Decimal {
  return estimatedProbability.minus(executablePrice).minus(feePerContract);
}

export function calculateLiquidationEdge(
  probabilityUpperBound: Decimal,
  executablePrice: Decimal,
  feePerContract: Decimal,
): Decimal {
  return executablePrice.minus(feePerContract).minus(probabilityUpperBound);
}
