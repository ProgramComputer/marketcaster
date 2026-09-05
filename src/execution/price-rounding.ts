import { Decimal } from "decimal.js";

function assertPositiveIncrement(increment: Decimal, name: string): void {
  if (!increment.isFinite() || increment.lte(0)) {
    throw new RangeError(`${name} must be a positive finite decimal`);
  }
}

export function floorToIncrement(value: Decimal, increment: Decimal): Decimal {
  assertPositiveIncrement(increment, "increment");
  return value.div(increment).floor().mul(increment);
}

export function ceilToIncrement(value: Decimal, increment: Decimal): Decimal {
  assertPositiveIncrement(increment, "increment");
  return value.div(increment).ceil().mul(increment);
}

export function floorToTick(value: Decimal, tick: Decimal): Decimal {
  return floorToIncrement(value, tick);
}

export function ceilToTick(value: Decimal, tick: Decimal): Decimal {
  return ceilToIncrement(value, tick);
}

export function alignQuantity(
  rawQuantity: Decimal,
  minimumTradeQuantity: Decimal,
): Decimal {
  return floorToIncrement(rawQuantity, minimumTradeQuantity);
}

export function isAligned(value: Decimal, increment: Decimal): boolean {
  assertPositiveIncrement(increment, "increment");
  return value.mod(increment).isZero();
}

export function decimalToExactNumber(value: Decimal): number {
  if (!value.isFinite())
    throw new RangeError("Cannot convert a non-finite Decimal");
  const numberValue = Number(value.toFixed());
  if (!Number.isFinite(numberValue)) {
    throw new RangeError("Decimal is outside the JavaScript number range");
  }
  if (!new Decimal(numberValue.toString()).eq(value)) {
    throw new RangeError(
      "Decimal cannot be represented exactly at the SDK boundary",
    );
  }
  return numberValue;
}
