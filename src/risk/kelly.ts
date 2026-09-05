import { Decimal } from "decimal.js";
import { clampDecimal } from "../domain/primitives.js";

export function calculateFullKelly(
  estimatedProbability: Decimal,
  effectivePrice: Decimal,
): Decimal {
  if (effectivePrice.gte(1)) return new Decimal(0);
  return estimatedProbability
    .minus(effectivePrice)
    .div(new Decimal(1).minus(effectivePrice));
}

export function calculateKellyBudget(
  estimatedProbability: Decimal,
  effectivePrice: Decimal,
  riskEquity: Decimal,
  kellyFraction: Decimal,
): Decimal {
  if (riskEquity.lte(0)) return new Decimal(0);
  const fraction = clampDecimal(
    calculateFullKelly(estimatedProbability, effectivePrice),
    0,
    1,
  ).mul(kellyFraction);
  return fraction.mul(riskEquity);
}
