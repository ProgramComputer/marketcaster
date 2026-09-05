import { Decimal } from "decimal.js";
import type { AccountActivity } from "../domain/activity.js";
import type { ExchangeOrder, ImmediateOrder } from "../domain/order.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";

const ONE = new Decimal(1);

export interface DuplicateFingerprint {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly approximateQuantity: Decimal;
  readonly approximatePrice: Decimal;
  readonly windowStart: Date;
}

function approximatelyEqual(
  left: Decimal,
  right: Decimal,
  absoluteTolerance: Decimal,
): boolean {
  return left.minus(right).abs().lte(absoluteTolerance);
}

export function createFingerprint(
  order: ImmediateOrder,
  now: Date,
  duplicateWindowMinutes: number,
): DuplicateFingerprint {
  return {
    marketSlug: order.marketSlug,
    side: order.side,
    action: order.action,
    approximateQuantity: order.quantity,
    approximatePrice: order.canonicalLimitPrice,
    windowStart: new Date(now.getTime() - duplicateWindowMinutes * 60_000),
  };
}

export function findLikelyDuplicate(
  fingerprint: DuplicateFingerprint,
  openOrders: readonly ExchangeOrder[],
  activities: readonly AccountActivity[],
  quantityTolerance = new Decimal("0.000001"),
  priceTolerance = new Decimal("0.01"),
): string | undefined {
  const openOrder = openOrders.find(
    (order) =>
      order.marketSlug === fingerprint.marketSlug &&
      order.side === fingerprint.side &&
      order.action === fingerprint.action &&
      approximatelyEqual(
        order.quantity,
        fingerprint.approximateQuantity,
        quantityTolerance,
      ) &&
      approximatelyEqual(
        order.canonicalPrice,
        fingerprint.approximatePrice,
        priceTolerance,
      ),
  );
  if (openOrder !== undefined) return `open order ${openOrder.id}`;

  // Canonical activities intentionally omit exchange-specific intent. Matching a
  // recent fill on market/size/price is therefore treated conservatively as a
  // duplicate even when direction cannot be proven from the activity payload.
  const trade = activities.find((activity) => {
    if (
      activity.kind !== "TRADE" ||
      activity.state === "TRADE_STATE_BUSTED" ||
      activity.marketSlug !== fingerprint.marketSlug ||
      activity.createdAt < fingerprint.windowStart ||
      !approximatelyEqual(
        activity.quantity,
        fingerprint.approximateQuantity,
        quantityTolerance,
      )
    ) {
      return false;
    }
    const comparablePrice =
      activity.yesPrice !== undefined
        ? fingerprint.side === "YES"
          ? activity.yesPrice
          : ONE.minus(activity.yesPrice)
        : activity.side !== undefined && activity.side !== fingerprint.side
          ? ONE.minus(activity.price)
          : activity.price;
    return approximatelyEqual(
      comparablePrice,
      fingerprint.approximatePrice,
      priceTolerance,
    );
  });
  return trade?.kind === "TRADE" ? `recent trade ${trade.tradeId}` : undefined;
}
