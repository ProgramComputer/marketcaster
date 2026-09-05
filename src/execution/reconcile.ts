import { Decimal } from "decimal.js";
import type { AccountActivity } from "../domain/activity.js";
import type { ExecutionResult } from "../domain/execution.js";
import type { ExchangeOrder, ImmediateOrder } from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { PredictionExchange } from "../exchanges/exchange.js";

const ONE = new Decimal(1);
const ACTIVE_ORDER_STATES = new Set([
  "NEW",
  "OPEN",
  "INFLIGHT",
  "PARTIALLY_FILLED",
]);
const EXACT_ORDER_READ_DELAYS_MILLISECONDS = [0, 250, 750, 1_500] as const;

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
      (activity.side === undefined || activity.side === order.side) &&
      (activity.action === undefined || activity.action === order.action) &&
      activity.createdAt >= submittedAt,
  );
}

function matchesSubmittedOrder(
  reported: ExchangeOrder,
  submitted: ImmediateOrder,
): boolean {
  if (
    reported.marketId.exchange !== submitted.marketId.exchange ||
    reported.marketId.value !== submitted.marketId.value ||
    reported.marketSlug !== submitted.marketSlug ||
    reported.side !== submitted.side ||
    reported.action !== submitted.action ||
    !reported.canonicalPrice.eq(submitted.canonicalLimitPrice) ||
    !reported.quantity.eq(submitted.quantity)
  ) {
    return false;
  }
  const submittedPolicy = submitted.executionPolicy ?? "IOC";
  if (submittedPolicy === "GTD") {
    if (
      reported.executionPolicy !== "GTD" ||
      reported.restUntil === undefined
    ) {
      return false;
    }
  } else if (
    reported.executionPolicy !== undefined &&
    reported.executionPolicy !== "IOC"
  ) {
    return false;
  }
  if (reported.restUntil !== undefined) {
    const submittedExpiry = submitted.restUntil?.getTime() ?? Number.NaN;
    const reportedExpiry = reported.restUntil.getTime();
    // Permit only sub-second exchange timestamp normalization, never a
    // materially later expiry than the engine requested.
    if (
      !Number.isFinite(submittedExpiry) ||
      !Number.isFinite(reportedExpiry) ||
      reportedExpiry > submittedExpiry + 999
    ) {
      return false;
    }
  }
  return true;
}

function workingResult(
  reported: ExchangeOrder,
  submitted: ImmediateOrder,
  submittedAt: Date,
): ExecutionResult | undefined {
  if (
    (submitted.executionPolicy ?? "IOC") !== "GTD" ||
    submitted.action !== "BUY" ||
    !ACTIVE_ORDER_STATES.has(reported.state) ||
    !matchesSubmittedOrder(reported, submitted) ||
    !reported.filledQuantity.isFinite() ||
    reported.filledQuantity.lt(0) ||
    reported.filledQuantity.gte(submitted.quantity) ||
    (reported.remainingQuantity !== undefined &&
      !reported.remainingQuantity.eq(
        submitted.quantity.minus(reported.filledQuantity),
      ))
  ) {
    return undefined;
  }
  const requestedExpiry = submitted.restUntil?.getTime() ?? Number.NaN;
  const reportedExpiry = reported.restUntil?.getTime() ?? Number.NaN;
  if (
    !Number.isFinite(requestedExpiry) ||
    !Number.isFinite(reportedExpiry) ||
    requestedExpiry <= submittedAt.getTime() ||
    requestedExpiry - submittedAt.getTime() > 15 * 60_000 ||
    reportedExpiry <= submittedAt.getTime() ||
    reportedExpiry > requestedExpiry + 999
  ) {
    return undefined;
  }
  const remainingQuantity = submitted.quantity.minus(reported.filledQuantity);
  const result: ExecutionResult = {
    status: "WORKING",
    orderId: reported.id,
    filledQuantity: reported.filledQuantity,
    remainingQuantity,
    fees: reported.fees ?? new Decimal(0),
    finalState: reported.state,
  };
  return reported.filledQuantity.gt(0) &&
    reported.averageFillPrice !== undefined
    ? {
        ...result,
        averageFillPrice: reported.averageFillPrice,
      }
    : result;
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

async function getOrderWithBoundedRetry(
  exchange: PredictionExchange,
  orderId: string,
): Promise<ExchangeOrder> {
  let lastError: unknown;
  for (const delayMilliseconds of EXACT_ORDER_READ_DELAYS_MILLISECONDS) {
    if (delayMilliseconds > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delayMilliseconds),
      );
    }
    try {
      return await exchange.getOrder(orderId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function reconcileAmbiguousSubmission(
  input: ReconcileAmbiguousInput,
): Promise<ExecutionResult> {
  if (input.orderId !== undefined) {
    try {
      const exchangeOrder = await getOrderWithBoundedRetry(
        input.exchange,
        input.orderId,
      );
      if (!matchesSubmittedOrder(exchangeOrder, input.order)) {
        return {
          status: "AMBIGUOUS",
          orderId: input.orderId,
          filledQuantity: new Decimal(0),
          fees: new Decimal(0),
          finalState: "UNKNOWN",
          ambiguousReason:
            "Fetched order does not match the submitted order fingerprint",
        };
      }
      const verifiedWorking = workingResult(
        exchangeOrder,
        input.order,
        input.submittedAt,
      );
      if (verifiedWorking !== undefined) return verifiedWorking;
      if (["FILLED", "CLEARED"].includes(exchangeOrder.state)) {
        const result: ExecutionResult = {
          status: exchangeOrder.filledQuantity.gte(exchangeOrder.quantity)
            ? "FILLED"
            : "PARTIAL",
          orderId: exchangeOrder.id,
          filledQuantity: exchangeOrder.filledQuantity,
          fees: exchangeOrder.fees ?? new Decimal(0),
          finalState: exchangeOrder.state,
        };
        if (exchangeOrder.averageFillPrice !== undefined) {
          return {
            ...result,
            averageFillPrice: exchangeOrder.averageFillPrice,
          };
        }
      }
      if (["REJECTED", "CANCELED", "EXPIRED"].includes(exchangeOrder.state)) {
        const result: ExecutionResult = {
          status: exchangeOrder.filledQuantity.gt(0) ? "PARTIAL" : "REJECTED",
          orderId: exchangeOrder.id,
          filledQuantity: exchangeOrder.filledQuantity,
          fees: exchangeOrder.fees ?? new Decimal(0),
          finalState: exchangeOrder.state,
        };
        if (exchangeOrder.filledQuantity.eq(0)) return result;
        if (exchangeOrder.averageFillPrice !== undefined) {
          return {
            ...result,
            averageFillPrice: exchangeOrder.averageFillPrice,
          };
        }
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
      matchesSubmittedOrder(order, input.order) &&
      (input.orderId === undefined || order.id === input.orderId),
  );

  if (resting !== undefined) {
    const verifiedWorking = workingResult(
      resting,
      input.order,
      input.submittedAt,
    );
    if (verifiedWorking !== undefined) {
      return verifiedWorking;
    }
  }

  if (
    resting === undefined &&
    filledQuantity.gt(0) &&
    activity?.kind === "TRADE"
  ) {
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
      fees: activity.fees ?? new Decimal(0),
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
