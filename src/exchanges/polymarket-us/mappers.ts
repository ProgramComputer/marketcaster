import { Decimal } from "decimal.js";

import type { AccountActivity } from "../../domain/activity.js";
import type { ExecutionResult } from "../../domain/execution.js";
import type {
  Market,
  MarketBbo,
  OrderBook,
  SettlementStatus,
} from "../../domain/market.js";
import type {
  ExchangeOrder,
  OrderPreview,
  OrderState,
} from "../../domain/order.js";
import type { Position } from "../../domain/position.js";
import type { MarketId } from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";
import type {
  PolymarketActivity,
  PolymarketBalance,
  PolymarketBbo,
  PolymarketBook,
  PolymarketCreateOrder,
  PolymarketMarket,
  PolymarketOrder,
  PolymarketPosition,
  PolymarketPreview,
  PolymarketPreviewOrder,
  PolymarketSettlement,
} from "./schemas.js";
import {
  assertConsistentPolymarketSide,
  canonicalFromPolymarketIntent,
  noAskFromYesBid,
  noBidFromYesAsk,
  yesPriceToCanonicalPrice,
  type PolymarketOrderIntent,
} from "./side-conversion.js";

function schemaFailure(message: string): never {
  throw new ExchangeError(message, "SCHEMA");
}

function marketId(value: string): MarketId {
  return { exchange: "polymarket-us", value };
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function requiredDefined<T>(
  fieldName: string,
  ...values: readonly (T | undefined)[]
): T {
  const value = firstDefined(...values);
  return value ?? schemaFailure(`Missing validated ${fieldName}`);
}

function assertProbability(value: Decimal, fieldName: string): void {
  if (!value.isFinite() || value.lt(0) || value.gt(1)) {
    schemaFailure(`${fieldName} must be between 0 and 1`);
  }
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function mapMarket(value: PolymarketMarket): Market {
  const title = requiredDefined("market title", value.title, value.question);
  const settlementRules = requiredDefined(
    "settlement rules",
    value.settlementRules,
    value.resolutionRules,
    value.rules,
    value.rulesDescription,
    value.rulesDisclaimer,
    value.description,
  );
  const priceTick = requiredDefined(
    "market price tick",
    value.orderPriceMinTickSize,
    value.priceTick,
    value.tickSize,
    value.minimumPriceIncrement,
  );
  const minimumTradeQuantity = requiredDefined(
    "market minimum trade quantity",
    value.minimumTradeQty,
    value.minimumTradeQuantity,
    value.minTradeQty,
    value.lotSize,
  );
  if (priceTick.gt(1)) {
    schemaFailure("Market price tick cannot exceed one dollar");
  }

  const opensAt = firstDefined(value.opensAt, value.startDate, value.startTime);
  const closesAt = firstDefined(value.closesAt, value.endDate, value.endTime);
  const liquidity = firstDefined(value.liquidityNum, value.liquidity);
  const volume = firstDefined(value.volumeNum, value.volume);
  const volume24h = firstDefined(value.volume24hr, value.volume24h);
  const priceMovement = value.oneDayPriceChange?.abs();
  if (priceMovement?.gt(1) === true) {
    schemaFailure("Market one-day price change cannot exceed one dollar");
  }
  const resolutionSource = firstDefined(
    value.resolutionSource,
    value.resolutionUrl,
  );
  return {
    id: marketId(value.id),
    slug: value.slug,
    title,
    description: value.description ?? "",
    settlementRules,
    active: value.active,
    closed: value.closed,
    archived: value.archived,
    minimumTradeQuantity,
    priceTick,
    ...optional("eventId", value.eventId),
    ...optional("eventSlug", value.eventSlug),
    ...optional("seriesId", value.seriesId),
    ...optional("seriesSlug", value.seriesSlug),
    ...optional(
      "tags",
      value.tags?.map((tag) => ({
        ...(tag.id === undefined ? {} : { id: tag.id }),
        slug: tag.slug,
        ...(tag.label === undefined ? {} : { label: tag.label }),
      })),
    ),
    ...optional("resolutionSource", resolutionSource),
    ...optional("category", value.category),
    ...optional("subcategory", value.subcategory),
    ...optional("opensAt", opensAt),
    ...optional("closesAt", closesAt),
    ...optional("liquidity", liquidity),
    ...optional("volume", volume),
    ...optional("volume24h", volume24h),
    ...optional("volume7d", value.volume1wk),
    ...optional("volume30d", value.volume1mo),
    ...optional("lastPrice", value.lastTradePrice),
    ...optional("priceMovement", priceMovement),
    ...(priceMovement === undefined
      ? {}
      : {
          priceMovementWindow: "24_HOURS" as const,
          priceMovementBasis: "EXCHANGE_REPORTED_24H_CHANGE" as const,
        }),
    ...optional("openInterest", value.openInterest),
    ...optional("updatedAt", value.updatedAt),
  };
}

export function mapBbo(
  value: PolymarketBbo,
  id: MarketId,
  expectedSlug: string,
  observedAt: Date,
): MarketBbo {
  if (value.marketSlug !== expectedSlug) {
    schemaFailure(
      `BBO market slug ${value.marketSlug} does not match ${expectedSlug}`,
    );
  }
  const yesBid = value.bestBid?.value;
  const yesAsk = value.bestAsk?.value;
  if (yesBid !== undefined) assertProbability(yesBid, "bestBid");
  if (yesAsk !== undefined) assertProbability(yesAsk, "bestAsk");
  if (yesBid !== undefined && yesAsk !== undefined && yesBid.gt(yesAsk)) {
    schemaFailure("Polymarket BBO is crossed");
  }

  const yesSpread =
    yesBid === undefined || yesAsk === undefined
      ? undefined
      : yesAsk.minus(yesBid);
  const noBid = yesAsk === undefined ? undefined : noBidFromYesAsk(yesAsk);
  const noAsk = yesBid === undefined ? undefined : noAskFromYesBid(yesBid);
  const noSpread =
    noBid === undefined || noAsk === undefined ? undefined : noAsk.minus(noBid);

  return {
    marketId: id,
    yes: {
      ...optional("bid", yesBid),
      ...optional("ask", yesAsk),
      ...optional("spread", yesSpread),
    },
    no: {
      ...optional("bid", noBid),
      ...optional("ask", noAsk),
      ...optional("spread", noSpread),
    },
    observedAt: value.transactTime ?? value.observedAt ?? observedAt,
  };
}

export function mapOrderBook(
  value: PolymarketBook,
  id: MarketId,
  expectedSlug: string,
  observedAt: Date,
): OrderBook {
  if (value.marketSlug !== expectedSlug) {
    schemaFailure(
      `Order-book market slug ${value.marketSlug} does not match ${expectedSlug}`,
    );
  }
  const yesBids = value.bids.map(({ px, qty }) => {
    assertProbability(px.value, "bid price");
    return { price: px.value, quantity: qty };
  });
  const yesAsks = value.offers.map(({ px, qty }) => {
    assertProbability(px.value, "ask price");
    return { price: px.value, quantity: qty };
  });
  yesBids.sort((left, right) => right.price.comparedTo(left.price));
  yesAsks.sort((left, right) => left.price.comparedTo(right.price));
  const bestBid = yesBids[0]?.price;
  const bestAsk = yesAsks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.gt(bestAsk)) {
    schemaFailure("Polymarket order book is crossed");
  }
  const currentPrice =
    value.stats?.currentPx?.value ?? value.stats?.lastTradePx?.value;
  const lastPrice = value.stats?.lastTradePx?.value;
  const openPrice = value.stats?.openPx?.value;
  const highPrice = value.stats?.highPx?.value;
  const lowPrice = value.stats?.lowPx?.value;
  for (const [label, price] of [
    ["current market price", currentPrice],
    ["opening market price", openPrice],
    ["high market price", highPrice],
    ["low market price", lowPrice],
  ] as const) {
    if (price !== undefined) assertProbability(price, label);
  }
  if (
    highPrice !== undefined &&
    lowPrice !== undefined &&
    highPrice.lt(lowPrice)
  ) {
    schemaFailure("Polymarket market-stat high price is below its low price");
  }
  const priceMovement =
    currentPrice === undefined || openPrice === undefined
      ? undefined
      : currentPrice.minus(openPrice).abs();
  const volatility =
    highPrice === undefined || lowPrice === undefined
      ? undefined
      : highPrice.minus(lowPrice);
  return {
    marketId: id,
    yesBids,
    yesAsks,
    ...optional("currentPrice", currentPrice),
    ...optional("lastPrice", lastPrice),
    ...optional("openPrice", openPrice),
    ...optional("highPrice", highPrice),
    ...optional("lowPrice", lowPrice),
    ...optional("volume", value.stats?.sharesTraded),
    ...optional("openInterest", value.stats?.openInterest),
    ...optional("priceMovement", priceMovement),
    ...(priceMovement === undefined
      ? {}
      : {
          priceMovementWindow: "TRADING_SESSION" as const,
          priceMovementBasis: "EXCHANGE_SESSION_BOOK_STATS" as const,
        }),
    ...optional("volatility", volatility),
    ...(volatility === undefined
      ? {}
      : {
          volatilityWindow: "TRADING_SESSION" as const,
          volatilityBasis: "EXCHANGE_SESSION_BOOK_STATS" as const,
        }),
    observedAt: value.transactTime ?? observedAt,
    observationBasis:
      value.transactTime === undefined
        ? "CLIENT_RECEIPT_TIME"
        : "EXCHANGE_TIMESTAMP",
  };
}

export function mapSettlement(
  value: PolymarketSettlement,
  id: MarketId,
  expectedSlug: string,
): SettlementStatus {
  if (value.marketSlug !== expectedSlug) {
    schemaFailure(
      `Settlement market slug ${value.marketSlug} does not match ${expectedSlug}`,
    );
  }
  assertProbability(value.settlementPrice, "settlementPrice");
  const state = value.settlementPrice.eq(1)
    ? "SETTLED_YES"
    : value.settlementPrice.eq(0)
      ? "SETTLED_NO"
      : value.settlementPrice.eq("0.5")
        ? "VOID"
        : "UNKNOWN";
  return {
    marketId: id,
    state,
    settlementPrice: value.settlementPrice,
    ...optional("settledAt", value.settledAt),
  };
}

export interface MappedBalance {
  readonly currentBalance: Decimal;
  readonly buyingPower: Decimal;
  readonly assetNotional: Decimal;
  readonly assetAvailable: Decimal;
  readonly openOrderValue: Decimal;
  readonly unsettledFunds: Decimal;
  readonly marginRequirement: Decimal;
  readonly lastUpdated?: Date;
}

export function mapBalance(value: PolymarketBalance): MappedBalance {
  const openOrderValue = requiredDefined(
    "open-order value",
    value.openOrderValue,
    value.openOrders,
  );
  return {
    currentBalance: value.currentBalance,
    buyingPower: value.buyingPower,
    assetNotional: value.assetNotional,
    assetAvailable: value.assetAvailable,
    openOrderValue,
    unsettledFunds: value.unsettledFunds,
    marginRequirement: value.marginRequirement,
    ...optional("lastUpdated", value.lastUpdated),
  };
}

export function mapPosition(
  slug: string,
  value: PolymarketPosition,
  canonicalMarketId: MarketId,
): Position | undefined {
  if (
    value.marketMetadata?.slug !== undefined &&
    value.marketMetadata.slug !== slug
  ) {
    schemaFailure(
      `Position map key ${slug} contradicts metadata slug ${value.marketMetadata.slug}`,
    );
  }
  const signedQuantity = requiredDefined(
    "net position",
    value.netPositionDecimal,
    value.netPosition,
  );
  if (signedQuantity.isZero()) return undefined;

  const quantity = signedQuantity.abs();
  const availableQuantity = requiredDefined(
    "available position quantity",
    value.qtyAvailableDecimal,
    value.qtyAvailable,
  ).abs();
  if (availableQuantity.gt(quantity)) {
    schemaFailure(`Available quantity exceeds net position for ${slug}`);
  }
  if (value.cost.value.lt(0)) {
    schemaFailure(`Position cost basis is negative for ${slug}`);
  }

  return {
    marketId: canonicalMarketId,
    marketSlug: slug,
    side: signedQuantity.gt(0) ? "YES" : "NO",
    quantity,
    availableQuantity,
    costBasis: value.cost.value,
    realizedPnl: value.realized.value,
    expired: value.expired,
    ...optional("exchangeCashValue", value.cashValue?.value),
    ...optional("updatedAt", value.updateTime),
  };
}

export function mapActivity(
  value: PolymarketActivity,
): readonly AccountActivity[] {
  if (value.trade !== undefined) {
    const quantity = requiredDefined(
      "trade quantity",
      value.trade.qtyDecimal,
      value.trade.qty,
    );
    const costBasis =
      value.trade.costBasis?.value ??
      value.trade.cost?.value ??
      schemaFailure("Trade is missing cost basis");
    return [
      {
        kind: "TRADE",
        tradeId: value.trade.id,
        marketSlug: value.trade.marketSlug,
        price: value.trade.price.value,
        quantity,
        costBasis,
        ...optional("realizedPnl", value.trade.realizedPnl?.value),
        state: value.trade.state,
        aggressor: value.trade.isAggressor ?? false,
        createdAt: value.trade.createTime,
        updatedAt: value.trade.updateTime,
      },
    ];
  }
  if (value.positionResolution !== undefined) {
    const resolution = value.positionResolution;
    const realizedPnl =
      resolution.realizedPnl?.value ??
      resolution.afterPosition?.realized.value.minus(
        resolution.beforePosition?.realized.value ??
          schemaFailure("Resolution is missing before realized PnL"),
      ) ??
      schemaFailure("Resolution is missing realized PnL");
    return [
      {
        kind: "RESOLUTION",
        marketSlug: resolution.marketSlug,
        realizedPnl,
        resolvedAt: resolution.updateTime,
      },
    ];
  }
  if (value.accountBalanceChange !== undefined) {
    return value.accountBalanceChange.map((transaction) => ({
      kind: "BALANCE_CHANGE" as const,
      activityType: value.type,
      amount: transaction.amount.value,
      createdAt:
        transaction.createTime ??
        transaction.updateTime ??
        schemaFailure("Balance change is missing a timestamp"),
    }));
  }
  return schemaFailure("Validated activity has no payload");
}

function intentFromOutcomeAction(
  outcomeSide: PolymarketOrder["outcomeSide"],
  action: PolymarketOrder["action"],
): PolymarketOrderIntent | undefined {
  if (outcomeSide === undefined || action === undefined) return undefined;
  if (outcomeSide === "OUTCOME_SIDE_YES") {
    return action === "ORDER_ACTION_BUY"
      ? "ORDER_INTENT_BUY_LONG"
      : "ORDER_INTENT_SELL_LONG";
  }
  return action === "ORDER_ACTION_BUY"
    ? "ORDER_INTENT_BUY_SHORT"
    : "ORDER_INTENT_SELL_SHORT";
}

function normalizedIntent(value: PolymarketOrder): PolymarketOrderIntent {
  const alternate = intentFromOutcomeAction(value.outcomeSide, value.action);
  if (
    value.intent !== undefined &&
    alternate !== undefined &&
    value.intent !== alternate
  ) {
    schemaFailure("Order intent contradicts outcomeSide/action");
  }
  return (
    value.intent ?? alternate ?? schemaFailure("Order has no canonical intent")
  );
}

export function mapOrderState(value: string): OrderState {
  switch (value) {
    case "ORDER_STATE_NEW":
    case "ORDER_STATE_OPEN":
      return "OPEN";
    case "ORDER_STATE_PENDING_NEW":
    case "ORDER_STATE_PENDING_REPLACE":
    case "ORDER_STATE_PENDING_CANCEL":
    case "ORDER_STATE_PENDING_RISK":
    case "ORDER_STATE_INFLIGHT":
      return "INFLIGHT";
    case "ORDER_STATE_PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "ORDER_STATE_PENDING_CLEARING":
      return "PENDING_CLEARING";
    case "ORDER_STATE_CLEARED":
      return "CLEARED";
    case "ORDER_STATE_FILLED":
      return "FILLED";
    case "ORDER_STATE_CANCELED":
    case "ORDER_STATE_REPLACED":
      return "CANCELED";
    case "ORDER_STATE_EXPIRED":
      return "EXPIRED";
    case "ORDER_STATE_REJECTED":
      return "REJECTED";
    case "ORDER_STATE_BUSTED":
      return "BUSTED";
    default:
      return "UNKNOWN";
  }
}

export function mapOrder(
  value: PolymarketOrder,
  canonicalMarketId: MarketId,
): ExchangeOrder {
  const intent = normalizedIntent(value);
  const canonical = canonicalFromPolymarketIntent(intent);
  if (value.side !== undefined) {
    assertConsistentPolymarketSide(intent, value.side);
  }
  const quantity = requiredDefined(
    "order quantity",
    value.quantityDecimal,
    value.quantity,
  );
  const filledQuantity =
    firstDefined(value.cumQuantityDecimal, value.cumQuantity) ?? new Decimal(0);
  if (filledQuantity.gt(quantity)) {
    schemaFailure(
      `Order ${value.id} filled quantity exceeds requested quantity`,
    );
  }
  assertProbability(value.price.value, "order YES price");
  const canonicalPrice = yesPriceToCanonicalPrice(
    canonical.side,
    value.price.value,
  );

  return {
    id: value.id,
    marketId: canonicalMarketId,
    marketSlug: value.marketSlug,
    side: canonical.side,
    action: canonical.action,
    canonicalPrice,
    quantity,
    filledQuantity,
    state: mapOrderState(value.state),
    ...optional("createdAt", value.createTime ?? value.insertTime),
    ...optional("updatedAt", value.updateTime),
  };
}

function decimalValue(
  value: Decimal | { readonly value: Decimal } | undefined,
): Decimal | undefined {
  if (value === undefined) return undefined;
  return Decimal.isDecimal(value) ? value : value.value;
}

export function mapPreview(value: PolymarketPreview): OrderPreview {
  const order = ("order" in value ? value.order : undefined) as
    PolymarketPreviewOrder | undefined;
  const state = order?.state ?? value.status;
  const rejectedByState = state === "ORDER_STATE_REJECTED";
  const accepted = value.accepted ?? !rejectedByState;
  const estimatedFees =
    decimalValue(value.estimatedFees) ??
    order?.commissionNotionalTotalCollected?.value ??
    schemaFailure("Order preview is missing an estimated fee");
  if (estimatedFees.lt(0)) {
    schemaFailure("Order preview fee is negative");
  }
  const rejectionReasons = [...(value.rejectionReasons ?? [])];
  if (order?.orderRejectReason !== undefined) {
    rejectionReasons.push(order.orderRejectReason);
  }
  return {
    accepted,
    estimatedFees,
    warnings: value.warnings ?? [],
    rejectionReasons,
    ...optional("estimatedPrincipal", decimalValue(value.estimatedPrincipal)),
    ...optional("estimatedCollateral", decimalValue(value.estimatedCollateral)),
    ...optional("rawStatus", state),
  };
}

function executionState(
  type: string,
  orderState: string | undefined,
): OrderState {
  if (orderState !== undefined) return mapOrderState(orderState);
  switch (type) {
    case "EXECUTION_TYPE_NEW":
      return "OPEN";
    case "EXECUTION_TYPE_PARTIAL_FILL":
      return "PARTIALLY_FILLED";
    case "EXECUTION_TYPE_FILL":
      return "FILLED";
    case "EXECUTION_TYPE_CANCELED":
      return "CANCELED";
    case "EXECUTION_TYPE_REJECTED":
      return "REJECTED";
    case "EXECUTION_TYPE_EXPIRED":
    case "EXECUTION_TYPE_DONE_FOR_DAY":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

export function mapCreateOrderResult(
  value: PolymarketCreateOrder,
  expectedMarketSlug: string,
  requestedQuantity: Decimal,
  canonicalSide: "YES" | "NO",
): ExecutionResult {
  const executions = value.executions;
  if (executions === undefined || executions.length === 0) {
    return {
      status: "AMBIGUOUS",
      orderId: value.id,
      filledQuantity: new Decimal(0),
      fees: new Decimal(0),
      finalState: "UNKNOWN",
      ambiguousReason: "Synchronous create response contained no executions",
    };
  }
  for (const execution of executions) {
    if (execution.order.id !== value.id) {
      schemaFailure("Execution order ID contradicts create response ID");
    }
    if (execution.order.marketSlug !== expectedMarketSlug) {
      schemaFailure("Execution market slug contradicts submitted market");
    }
  }

  const fillExecutions = executions.filter(
    (execution) =>
      execution.type === "EXECUTION_TYPE_PARTIAL_FILL" ||
      execution.type === "EXECUTION_TYPE_FILL",
  );
  const summedFillQuantity = fillExecutions.reduce(
    (sum, execution) =>
      sum.plus(
        firstDefined(execution.lastSharesDecimal, execution.lastShares) ??
          schemaFailure("Fill execution is missing lastShares"),
      ),
    new Decimal(0),
  );
  const finalExecution =
    executions.at(-1) ?? schemaFailure("Missing execution");
  const cumulativeQuantity = firstDefined(
    finalExecution.order.cumQuantityDecimal,
    finalExecution.order.cumQuantity,
  );
  if (
    cumulativeQuantity !== undefined &&
    !cumulativeQuantity.eq(summedFillQuantity)
  ) {
    schemaFailure("Execution cumulative quantity contradicts fill executions");
  }
  const filledQuantity = cumulativeQuantity ?? summedFillQuantity;
  if (filledQuantity.gt(requestedQuantity)) {
    schemaFailure("Create response filled more than the requested quantity");
  }

  const weightedPrincipal = fillExecutions.reduce((sum, execution) => {
    const shares = firstDefined(
      execution.lastSharesDecimal,
      execution.lastShares,
    );
    const price = execution.lastPx?.value;
    if (shares === undefined || price === undefined) {
      return schemaFailure("Fill execution is missing quantity or price");
    }
    return sum.plus(shares.times(price));
  }, new Decimal(0));
  const averageYesPrice = filledQuantity.isZero()
    ? undefined
    : (finalExecution.order.avgPx?.value ??
      weightedPrincipal.div(filledQuantity));
  if (averageYesPrice !== undefined) {
    assertProbability(averageYesPrice, "average fill YES price");
  }

  let fees: Decimal;
  const cumulativeFees =
    finalExecution.order.commissionNotionalTotalCollected?.value;
  if (cumulativeFees !== undefined) {
    fees = cumulativeFees;
  } else if (fillExecutions.length === 0) {
    fees = new Decimal(0);
  } else {
    fees = fillExecutions.reduce(
      (sum, execution) =>
        sum.plus(
          execution.commissionNotionalCollected?.value ??
            schemaFailure("Fill execution is missing commission"),
        ),
      new Decimal(0),
    );
  }
  const finalState = executionState(
    finalExecution.type,
    finalExecution.order.state,
  );
  const rejection = executions.find(
    (execution) => execution.type === "EXECUTION_TYPE_REJECTED",
  );
  if (rejection !== undefined || finalState === "REJECTED") {
    return {
      status: "REJECTED",
      orderId: value.id,
      filledQuantity,
      fees,
      finalState: "REJECTED",
      rejectionReason:
        rejection?.orderRejectReason ?? rejection?.text ?? "Order rejected",
    };
  }
  if (
    !["FILLED", "CANCELED", "EXPIRED"].includes(finalState) &&
    !filledQuantity.eq(requestedQuantity)
  ) {
    return {
      status: "AMBIGUOUS",
      orderId: value.id,
      filledQuantity,
      fees,
      finalState,
      ...optional(
        "averageFillPrice",
        averageYesPrice === undefined
          ? undefined
          : yesPriceToCanonicalPrice(canonicalSide, averageYesPrice),
      ),
      ambiguousReason:
        "Synchronous create response did not reach a final state",
    };
  }

  const status = filledQuantity.eq(requestedQuantity)
    ? "FILLED"
    : filledQuantity.gt(0)
      ? "PARTIAL"
      : "NO_FILL";
  return {
    status,
    orderId: value.id,
    filledQuantity,
    fees,
    finalState,
    ...optional(
      "averageFillPrice",
      averageYesPrice === undefined
        ? undefined
        : yesPriceToCanonicalPrice(canonicalSide, averageYesPrice),
    ),
  };
}
