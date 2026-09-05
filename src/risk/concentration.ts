import { Decimal } from "decimal.js";

export function concentrationHeadroom(
  riskEquity: Decimal,
  maximumFraction: Decimal,
  existingCostBasis: Decimal,
  queuedSpend: Decimal,
): Decimal {
  const maximum = riskEquity.mul(maximumFraction);
  return Decimal.max(0, maximum.minus(existingCostBasis).minus(queuedSpend));
}

export function concentrationFraction(
  postTradeCostBasis: Decimal,
  riskEquity: Decimal,
): Decimal {
  return riskEquity.lte(0)
    ? new Decimal(Infinity)
    : postTradeCostBasis.div(riskEquity);
}
