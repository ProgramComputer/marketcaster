import { Decimal } from "decimal.js";
import { z } from "zod";

export type DecimalString = string;
export type ExchangeId =
  "polymarket-us" | "polymarket-international" | "kalshi";
export type OutcomeSide = "YES" | "NO";
export type TradeAction = "BUY" | "SELL";
export type RuntimeMode = "observe" | "live";

export interface Money {
  readonly value: Decimal;
  readonly currency: "USD";
}

export interface MarketId {
  readonly exchange: ExchangeId;
  readonly value: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly eof: boolean;
}

export const DecimalInputSchema = z
  .union([z.string(), z.number()])
  .transform((value, context) => {
    try {
      const decimal = new Decimal(value);
      if (!decimal.isFinite()) {
        context.addIssue({
          code: "custom",
          message: "Expected a finite decimal value",
        });
        return z.NEVER;
      }
      return decimal;
    } catch {
      context.addIssue({ code: "custom", message: "Invalid decimal value" });
      return z.NEVER;
    }
  });

export const NonNegativeDecimalSchema = DecimalInputSchema.refine(
  (value) => value.gte(0),
  "Expected a non-negative decimal value",
);

export const PositiveDecimalSchema = DecimalInputSchema.refine(
  (value) => value.gt(0),
  "Expected a positive decimal value",
);

export function decimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export function money(value: Decimal.Value): Money {
  return { value: decimal(value), currency: "USD" };
}

export function clampDecimal(
  value: Decimal,
  minimum: Decimal.Value,
  maximum: Decimal.Value,
): Decimal {
  return Decimal.max(minimum, Decimal.min(maximum, value));
}

export function serializeDecimal(value: Decimal): DecimalString {
  return value.toFixed();
}

export function assertFiniteDecimal(
  value: Decimal,
  fieldName: string,
): Decimal {
  if (!value.isFinite()) {
    throw new TypeError(`${fieldName} must be a finite decimal`);
  }
  return value;
}
