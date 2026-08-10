import { Decimal } from "decimal.js";
import type { AccountActivity } from "../domain/activity.js";
import type { ExecutionResult } from "../domain/execution.js";
import type { ImmediateOrder } from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { PredictionExchange } from "../exchanges/exchange.js";

const ONE = new Decimal(1);

export interface ReconcileAmbiguousInput {
  readonly exchange: PredictionExchange;
  readonly order: ImmediateOrder;
  readonly orderId?: string;
  readonly positionsBefore: readonly Position[];
  readonly submittedAt: Date;
}

function sideQuantity(
  positions: readonly Position[],
  order: ImmediateOrder,
): Decimal {
  return (
    positions.find(
      (position) =>
        position.marketSlug === order.marketSlug &&
        position.side === order.side,
    )?.quantity ?? new Decimal(0)
  );
}

function fillFromPositionDelta(
  order: ImmediateOrder,
  before: readonly Position[],
  after: readonly Position[],
): Decimal {
  const beforeQuantity = sideQuantity(before, order);
  const afterQuantity = sideQuantity(after, order);
  const delta =
    order.action === "BUY"
      ? afterQuantity.minus(beforeQuantity)
      : beforeQuantity.minus(afterQuantity);
  return Decimal.max(0, Decimal.min(order.quantity, delta));
}

function recentMatchingTrade(
  activities: readonly AccountActivity[],
  order: ImmediateOrder,
  submittedAt: Date,
): AccountActivity | undefined {
  return activities.find(
    (activity) =>
      activity.kind === "TRADE" &&
      activity.state !== "TRADE_STATE_BUSTED" &&
      activity.marketSlug === order.marketSlug &&
      activity.createdAt >= submittedAt,
  );
}

function orderSidePrice(
  reportedSide: ImmediateOrder["side"] | undefined,
  reportedPrice: Decimal,
  submittedSide: ImmediateOrder["side"],
  yesPrice?: Decimal,
): Decimal {
  if (yesPrice !== undefined) {
    return submittedSide === "YES" ? yesPrice : ONE.minus(yesPrice);
  }
  return reportedSide !== undefined && reportedSide !== submittedSide
    ? ONE.minus(reportedPrice)
    : reportedPrice;
}

export async function reconcileAmbiguousSubmission(
  input: ReconcileAmbiguousInput,
): Promise<ExecutionResult> {
  if (input.orderId !== undefined) {
    try {
      const exchangeOrder = await input.exchange.getOrder(input.orderId);
      if (["FILLED", "CLEARED"].includes(exchangeOrder.state)) {
        return {
          status: exchangeOrder.filledQuantity.gte(exchangeOrder.quantity)
            ? "FILLED"
            : "PARTIAL",
          orderId: exchangeOrder.id,
          filledQuantity: exchangeOrder.filledQuantity,
          averageFillPrice: orderSidePrice(
            exchangeOrder.side,
            exchangeOrder.canonicalPrice,
            input.order.side,
          ),
          fees: new Decimal(0),
          finalState: exchangeOrder.state,
        };
      }
      if (["REJECTED", "CANCELED", "EXPIRED"].includes(exchangeOrder.state)) {
        const result: ExecutionResult = {
          status: exchangeOrder.filledQuantity.gt(0) ? "PARTIAL" : "REJECTED",
          orderId: exchangeOrder.id,
          filledQuantity: exchangeOrder.filledQuantity,
          fees: new Decimal(0),
          finalState: exchangeOrder.state,
        };
        return exchangeOrder.filledQuantity.gt(0)
          ? {
              ...result,
              averageFillPrice: orderSidePrice(
                exchangeOrder.side,
                exchangeOrder.canonicalPrice,
                input.order.side,
              ),
            }
          : result;
      }
    } catch {
      // Continue with activity, position, and open-order reconciliation.
    }
  }

  const [positions, openOrders, activityPage] = await Promise.all([
    input.exchange.getPositions(),
    input.exchange.getOpenOrders(),
    input.exchange.getActivities({
      marketSlug: input.order.marketSlug,
      createdAfter: input.submittedAt,
      sortOrder: "DESCENDING",
      limit: 100,
    }),
  ]);
  const filledQuantity = fillFromPositionDelta(
    input.order,
    input.positionsBefore,
    positions,
  );
  const activity = recentMatchingTrade(
    activityPage.items,
    input.order,
    input.submittedAt,
  );
  const resting = openOrders.find(
    (order) =>
      order.marketSlug === input.order.marketSlug &&
      order.side === input.order.side &&
      order.action === input.order.action,
  );

  if (filledQuantity.gt(0) && activity?.kind === "TRADE") {
    return {
      status: filledQuantity.gte(input.order.quantity) ? "FILLED" : "PARTIAL",
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      filledQuantity,
      averageFillPrice: orderSidePrice(
        activity.side,
        activity.price,
        input.order.side,
        activity.yesPrice,
      ),
      fees: new Decimal(0),
      finalState: filledQuantity.gte(input.order.quantity)
        ? "FILLED"
        : "PARTIALLY_FILLED",
    };
  }

  const reconciledOrderId = input.orderId ?? resting?.id;
  return {
    status: "AMBIGUOUS",
    ...(reconciledOrderId === undefined ? {} : { orderId: reconciledOrderId }),
    filledQuantity,
    fees: new Decimal(0),
    finalState: resting?.state ?? "UNKNOWN",
    ambiguousReason:
      "Order outcome could not be proven from order, activity, position, and open-order state",
  };
}
