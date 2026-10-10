import type { OutcomeSide } from "../domain/primitives.js";

/**
 * Exchanges trade every market as two sides, one of them long. The decision
 * model names them LONG and SHORT and reads each side's own exchange label;
 * the engine keeps YES for long and NO for short internally.
 */
export const MODEL_SIDES = ["LONG", "SHORT"] as const;
export type ModelSide = (typeof MODEL_SIDES)[number];

export function toModelSide(side: OutcomeSide): ModelSide {
  return side === "YES" ? "LONG" : "SHORT";
}

export function fromModelSide(side: ModelSide): OutcomeSide {
  return side === "LONG" ? "YES" : "NO";
}

/** Internal YES-named fields and the long-side names the model reads and writes. */
export const MODEL_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  ["sessionOpenYesPrice", "sessionOpenLongPrice"],
  ["sessionCurrentYesPrice", "sessionCurrentLongPrice"],
  ["sessionLastYesPrice", "sessionLastLongPrice"],
  ["sessionHighYesPrice", "sessionHighLongPrice"],
  ["sessionLowYesPrice", "sessionLowLongPrice"],
  ["yesPrice", "longPrice"],
  ["yesPriceBasis", "longPriceBasis"],
  ["minimumYesPrice", "minimumLongPrice"],
  ["maximumYesPrice", "maximumLongPrice"],
  ["forecastYesProbability", "forecastLongProbability"],
  ["originalYesProbability", "originalLongProbability"],
  ["targetYesProbability", "targetLongProbability"],
]);

const SIDE_QUOTE_FIELDS: ReadonlySet<string> = new Set([
  "sideLabels",
  "yesBid",
  "yesAsk",
  "noBid",
  "noAsk",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSideKey(key: string): boolean {
  return key === "side" || key.endsWith("Side");
}

function modelSides(
  value: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const labels = isPlainObject(value.sideLabels) ? value.sideLabels : {};
  const side = (
    position: ModelSide,
    label: unknown,
    bid: unknown,
    ask: unknown,
  ) => ({
    position,
    ...(typeof label === "string" ? { label } : {}),
    ...(bid === undefined ? {} : { bid }),
    ...(ask === undefined ? {} : { ask }),
  });
  return [
    side("LONG", labels.long, value.yesBid, value.yesAsk),
    side("SHORT", labels.short, value.noBid, value.noAsk),
  ];
}

/**
 * Rewrites a JSON-ready value into the model's terms: YES/NO side values become
 * LONG/SHORT, a market's yes/no quotes and exchange side labels become one
 * `sides` list, and YES-named fields take their long-side names. Applying it
 * twice changes nothing.
 */
export function toModelView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toModelView);
  if (typeof value === "string") return MODEL_FIELD_NAMES.get(value) ?? value;
  if (!isPlainObject(value)) return value;
  const entries: [string, unknown][] = [];
  let sidesPlaced = false;
  for (const [key, entry] of Object.entries(value)) {
    if (SIDE_QUOTE_FIELDS.has(key)) {
      if (!sidesPlaced) {
        entries.push(["sides", modelSides(value)]);
        sidesPlaced = true;
      }
      continue;
    }
    if (isSideKey(key) && (entry === "YES" || entry === "NO")) {
      entries.push([key, toModelSide(entry)]);
      continue;
    }
    entries.push([MODEL_FIELD_NAMES.get(key) ?? key, toModelView(entry)]);
  }
  return Object.fromEntries(entries);
}

/** Serializes a tool result body or context exactly as the model reads it. */
export function modelJson(value: unknown, space?: number): string {
  return JSON.stringify(toModelView(value), null, space);
}
