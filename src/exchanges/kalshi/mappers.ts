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
  ImmediateOrder,
  OrderState,
} from "../../domain/order.js";
import type { Position } from "../../domain/position.js";
import type { MarketId } from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";
import type {
  KalshiCreateOrderResult,
  KalshiDeposit,
  KalshiFill,
  KalshiHistoricalFill,
  KalshiMarket,
  KalshiMarketPosition,
  KalshiOrder,
  KalshiOrderBook,
  KalshiSettlement,
  KalshiWithdrawal,
} from "./schemas.js";
import {
  canonicalFromKalshiDirection,
  yesPriceToCanonicalPrice,
} from "./side-conversion.js";

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const CENT = new Decimal("0.01");
const DECI_CENT = new Decimal("0.001");
const CONTRACT_GRANULARITY = new Decimal("0.01");

function schemaFailure(message: string): never {
  throw new ExchangeError(message, "SCHEMA");
}

function marketId(ticker: string): MarketId {
  return { exchange: "kalshi", value: ticker };
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function assertProbability(value: Decimal, fieldName: string): void {
  if (!value.isFinite() || value.lt(0) || value.gt(1)) {
    schemaFailure(`${fieldName} must be between zero and one`);
  }
}

function assertCompatibleResponsePrices(
  yesPrice: Decimal,
  noPrice: Decimal,
  fieldName: string,
): void {
  assertProbability(yesPrice, `${fieldName} YES price`);
  assertProbability(noPrice, `${fieldName} NO price`);
  if (!yesPrice.eq(noPrice) && !yesPrice.plus(noPrice).eq(ONE)) {
    schemaFailure(
      `${fieldName} YES and NO prices are neither unified nor complementary`,
    );
  }
}

function settlementRules(value: KalshiMarket): string {
  return [
    value.rules_primary,
    value.rules_secondary,
    value.early_close_condition === undefined
      ? undefined
      : `Early close: ${value.early_close_condition}`,
  ]
    .filter(
      (part): part is string => part !== undefined && part.trim().length > 0,
    )
    .join("\n\n");
}

function priceTick(value: KalshiMarket): Decimal {
  const steps = value.price_ranges
    ?.map((range) => {
      if (range.start.gt(range.end)) {
        schemaFailure("Kalshi price range starts after it ends");
      }
      if (range.step.gt(ONE)) {
        schemaFailure("Kalshi price step exceeds one dollar");
      }
      return range.step;
    })
    .filter((step) => step.gt(0));
  if (steps !== undefined && steps.length > 0) {
    // A single canonical tick cannot express tapered grids. Expose the
    // smallest supported tick so shared validation accepts every valid band;
    // the raw range validator still enforces each band's exact grid.
    return Decimal.min(...steps);
  }
  return value.price_level_structure === "deci_cent" ? DECI_CENT : CENT;
}

function marketStatus(value: KalshiMarket): {
  readonly active: boolean;
  readonly closed: boolean;
  readonly archived: boolean;
} {
  const status = value.status.toLowerCase();
  const archived = status === "settled" || status === "finalized";
  return {
    active: status === "open" || status === "active",
    closed:
      archived ||
      ["closed", "determined", "disputed", "amended"].includes(status),
    archived,
  };
}

function marketTitle(value: KalshiMarket): string {
  for (const candidate of [value.title, value.yes_sub_title, value.subtitle]) {
    const normalized = candidate?.trim();
    if (normalized !== undefined && normalized.length > 0) return normalized;
  }
  return value.ticker;
}

export function mapMarket(value: KalshiMarket): Market {
  const status = marketStatus(value);
  const notional = value.notional_value_dollars ?? ONE;
  const priceMovement =
    value.last_price_dollars === undefined ||
    value.previous_price_dollars === undefined
      ? undefined
      : value.last_price_dollars.minus(value.previous_price_dollars).abs();
  const liquidity =
    value.liquidity_dollars?.gt(0) === true
      ? value.liquidity_dollars
      : undefined;
  const closesAt =
    value.close_time ??
    value.expiration_time ??
    value.expected_expiration_time ??
    value.latest_expiration_time;
  const description = [value.subtitle, value.yes_sub_title]
    .filter(
      (part): part is string => part !== undefined && part.trim().length > 0,
    )
    .join(" — ");
  return {
    id: marketId(value.ticker),
    slug: value.ticker,
    eventId: value.event_ticker,
    eventSlug: value.event_ticker,
    ...optional("seriesId", value.series_ticker),
    ...optional("seriesSlug", value.series_ticker),
    title: marketTitle(value),
    description,
    settlementRules: settlementRules(value),
    active: status.active,
    closed: status.closed,
    archived: status.archived,
    minimumTradeQuantity: CONTRACT_GRANULARITY,
    priceTick: priceTick(value),
    ...(value.open_time === undefined ? {} : { opensAt: value.open_time }),
    ...(closesAt === undefined ? {} : { closesAt }),
    ...optional("liquidity", liquidity),
    ...optional(
      "volume",
      value.volume_fp === undefined ? undefined : value.volume_fp.mul(notional),
    ),
    ...optional(
      "volume24h",
      value.volume_24h_fp === undefined
        ? undefined
        : value.volume_24h_fp.mul(notional),
    ),
    ...optional("lastPrice", value.last_price_dollars),
    ...optional("priceMovement", priceMovement),
    ...(priceMovement === undefined
      ? {}
      : {
          priceMovementWindow: "24_HOURS" as const,
          priceMovementBasis: "EXCHANGE_REPORTED_24H_CHANGE" as const,
        }),
    ...optional("openInterest", value.open_interest_fp),
    ...optional("updatedAt", value.updated_time),
  };
}

export function isValidKalshiYesPrice(
  value: KalshiMarket,
  yesPrice: Decimal,
): boolean {
  if (!yesPrice.isFinite() || yesPrice.lte(0) || yesPrice.gte(1)) return false;
  if (value.price_ranges === undefined || value.price_ranges.length === 0) {
    return yesPrice.mod(priceTick(value)).isZero();
  }
  return value.price_ranges.some(
    (range) =>
      yesPrice.gte(range.start) &&
      yesPrice.lte(range.end) &&
      yesPrice.minus(range.start).mod(range.step).isZero(),
  );
}

export function mapOrderBook(
  value: KalshiOrderBook,
  id: MarketId,
  observedAt: Date,
): OrderBook {
  const yesBids = value.orderbook_fp.yes_dollars.map(([price, quantity]) => ({
    price,
    quantity,
  }));
  const yesAsks = value.orderbook_fp.no_dollars.map(([price, quantity]) => ({
    price: ONE.minus(price),
    quantity,
  }));
  yesBids.sort((left, right) => right.price.comparedTo(left.price));
  yesAsks.sort((left, right) => left.price.comparedTo(right.price));
  const bestBid = yesBids[0]?.price;
  const bestAsk = yesAsks[0]?.price;
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.gt(bestAsk)) {
    schemaFailure("Kalshi order book is crossed");
  }
  if (Number.isNaN(observedAt.getTime())) {
    schemaFailure("Kalshi order-book observation time is invalid");
  }
  return {
    marketId: id,
    yesBids,
    yesAsks,
    observedAt,
    observationBasis: "CLIENT_RECEIPT_TIME",
  };
}

export function mapBbo(book: OrderBook): MarketBbo {
  const yesBid = book.yesBids[0]?.price;
  const yesAsk = book.yesAsks[0]?.price;
  const noBid = yesAsk === undefined ? undefined : ONE.minus(yesAsk);
  const noAsk = yesBid === undefined ? undefined : ONE.minus(yesBid);
  return {
    marketId: book.marketId,
    yes: {
      ...optional("bid", yesBid),
      ...optional("ask", yesAsk),
      ...optional(
        "spread",
        yesBid === undefined || yesAsk === undefined
          ? undefined
          : yesAsk.minus(yesBid),
      ),
    },
    no: {
      ...optional("bid", noBid),
      ...optional("ask", noAsk),
      ...optional(
        "spread",
        noBid === undefined || noAsk === undefined
          ? undefined
          : noAsk.minus(noBid),
      ),
    },
    observedAt: book.observedAt,
  };
}

export function mapSettlement(
  value: KalshiMarket,
  id: MarketId,
): SettlementStatus {
  const status = value.status.toLowerCase();
  const result = (value.result ?? value.market_result)?.toLowerCase();
  const settlementPrice = value.settlement_value_dollars;
  const isFinal = status === "settled" || status === "finalized";
  let state: SettlementStatus["state"];
  if (
    [
      "open",
      "active",
      "unopened",
      "initialized",
      "paused",
      "inactive",
    ].includes(status)
  ) {
    state = "OPEN";
  } else if (!isFinal) {
    state = ["closed", "determined", "disputed", "amended"].includes(status)
      ? "PENDING"
      : "UNKNOWN";
  } else {
    switch (result) {
      case "yes":
        if (settlementPrice !== undefined && !settlementPrice.eq(1)) {
          schemaFailure(`Market ${id.value} has a contradictory YES payout`);
        }
        state = "SETTLED_YES";
        break;
      case "no":
        if (settlementPrice !== undefined && !settlementPrice.eq(0)) {
          schemaFailure(`Market ${id.value} has a contradictory NO payout`);
        }
        state = "SETTLED_NO";
        break;
      case "void":
        state = "VOID";
        break;
      case "scalar":
        state = "SETTLED_OTHER";
        break;
      default:
        if (result !== undefined && result !== "unknown") {
          state = "UNKNOWN";
        } else if (settlementPrice?.eq(1) === true) {
          state = "SETTLED_YES";
        } else if (settlementPrice?.eq(0) === true) {
          state = "SETTLED_NO";
        } else if (settlementPrice !== undefined) {
          // A result-less fractional payout is a scalar settlement, not a void.
          state = "SETTLED_OTHER";
        } else {
          state = "UNKNOWN";
        }
    }
  }
  return {
    marketId: id,
    state,
    ...optional("settlementPrice", settlementPrice),
    ...optional("settledAt", value.settlement_ts),
  };
}

export function mapPosition(value: KalshiMarketPosition): Position | undefined {
  if (value.position_fp.isZero()) return undefined;
  const quantity = value.position_fp.abs();
  return {
    marketId: marketId(value.ticker),
    marketSlug: value.ticker,
    side: value.position_fp.gt(0) ? "YES" : "NO",
    quantity,
    availableQuantity: quantity,
    costBasis: value.market_exposure_dollars.abs(),
    realizedPnl: value.realized_pnl_dollars,
    expired: false,
    ...optional("updatedAt", value.last_updated_ts),
  };
}

export function mapOrderState(value: string): OrderState {
  switch (value.toLowerCase()) {
    case "resting":
    case "open":
      return "OPEN";
    case "pending":
    case "inflight":
      return "INFLIGHT";
    case "executed":
    case "filled":
      return "FILLED";
    case "canceled":
    case "cancelled":
      return "CANCELED";
    case "expired":
      return "EXPIRED";
    case "rejected":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

export function mapOrder(value: KalshiOrder): ExchangeOrder {
  assertCompatibleResponsePrices(
    value.yes_price_dollars,
    value.no_price_dollars,
    `Order ${value.order_id}`,
  );
  const canonical = canonicalFromKalshiDirection(
    value.outcome_side,
    value.book_side,
    value.side,
    value.action,
  );
  if (value.fill_count_fp.gt(value.initial_count_fp)) {
    schemaFailure(`Order ${value.order_id} filled more than its initial count`);
  }
  if (value.remaining_count_fp.gt(value.initial_count_fp)) {
    schemaFailure(`Order ${value.order_id} has excessive remaining count`);
  }
  if (
    value.fill_count_fp
      .plus(value.remaining_count_fp)
      .gt(value.initial_count_fp)
  ) {
    schemaFailure(
      `Order ${value.order_id} filled plus remaining count exceeds its initial count`,
    );
  }
  const canonicalPrice = yesPriceToCanonicalPrice(
    canonical.side,
    value.yes_price_dollars,
  );
  const mappedState = mapOrderState(value.status);
  return {
    id: value.order_id,
    marketId: marketId(value.ticker),
    marketSlug: value.ticker,
    side: canonical.side,
    action: canonical.action,
    canonicalPrice,
    quantity: value.initial_count_fp,
    filledQuantity: value.fill_count_fp,
    remainingQuantity: value.remaining_count_fp,
    state:
      mappedState === "OPEN" && value.fill_count_fp.gt(0)
        ? "PARTIALLY_FILLED"
        : mappedState,
    ...optional("createdAt", value.created_time),
    ...optional("updatedAt", value.last_update_time),
  };
}

function fillTime(value: KalshiFill | KalshiHistoricalFill): Date {
  if (value.created_time !== undefined) return value.created_time;
  if (value.ts === undefined) {
    return schemaFailure(`Kalshi fill ${value.fill_id} has no timestamp`);
  }
  const timestamp = new Date(value.ts * 1_000);
  if (Number.isNaN(timestamp.getTime())) {
    return schemaFailure(
      `Kalshi fill ${value.fill_id} has an invalid timestamp`,
    );
  }
  return timestamp;
}

function fillTicker(value: KalshiFill | KalshiHistoricalFill): string {
  return (
    value.ticker ??
    value.market_ticker ??
    schemaFailure(`Kalshi fill ${value.fill_id} has no market ticker`)
  );
}

export function mapFill(
  value: KalshiFill | KalshiHistoricalFill,
): AccountActivity {
  assertCompatibleResponsePrices(
    value.yes_price_dollars,
    value.no_price_dollars,
    `Fill ${value.fill_id}`,
  );
  const hasDirection =
    value.outcome_side !== undefined ||
    value.book_side !== undefined ||
    (value.side !== undefined && value.action !== undefined);
  const canonical = hasDirection
    ? canonicalFromKalshiDirection(
        value.outcome_side,
        value.book_side,
        value.side,
        value.action,
      )
    : undefined;
  const price =
    canonical === undefined
      ? value.yes_price_dollars
      : yesPriceToCanonicalPrice(canonical.side, value.yes_price_dollars);
  const occurredAt = fillTime(value);
  return {
    kind: "TRADE",
    // fill_id is the stable user-fill identity across live and historical
    // tiers; trade_id can be absent or shared by both counterparties.
    tradeId: value.fill_id,
    fillId: value.fill_id,
    orderId: value.order_id,
    marketSlug: fillTicker(value),
    ...optional("side", canonical?.side),
    ...optional("action", canonical?.action),
    yesPrice: value.yes_price_dollars,
    price,
    quantity: value.count_fp,
    costBasis: price.mul(value.count_fp),
    fees: value.fee_cost,
    // The fill response does not contain authoritative realized PnL. In
    // particular, an opening buy must not become a flat closed trade.
    state: "TRADE_STATE_CLEARED",
    aggressor: value.is_taker,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function mapResolution(value: KalshiSettlement): AccountActivity {
  const fee = value.fee_cost ?? ZERO;
  const realizedPnl = new Decimal(value.revenue)
    .div(100)
    .minus(value.yes_total_cost_dollars)
    .minus(value.no_total_cost_dollars)
    .minus(fee);
  return {
    kind: "RESOLUTION",
    marketSlug: value.ticker,
    realizedPnl,
    resolvedAt: value.settled_time,
    payoutAmount: new Decimal(value.revenue).div(100),
    payoutState: "UNKNOWN",
  };
}

const UNSUCCESSFUL_TRANSFER_STATES = new Set([
  "canceled",
  "cancelled",
  "failed",
  "pending",
  "processing",
  "rejected",
]);
const SUCCESSFUL_TRANSFER_STATES = new Set([
  "complete",
  "completed",
  "finalized",
  "settled",
  "succeeded",
  "success",
]);

function transferDate(value: KalshiDeposit): Date | undefined {
  const normalizedStatus = value.status?.toLowerCase();
  if (
    normalizedStatus !== undefined &&
    UNSUCCESSFUL_TRANSFER_STATES.has(normalizedStatus)
  ) {
    return undefined;
  }
  if (
    value.finalized_ts == null &&
    (normalizedStatus === undefined ||
      !SUCCESSFUL_TRANSFER_STATES.has(normalizedStatus))
  ) {
    return undefined;
  }
  const timestamp = value.finalized_ts ?? value.created_ts;
  const date = new Date(timestamp * 1_000);
  if (Number.isNaN(date.getTime())) {
    schemaFailure(`Kalshi cash transfer ${value.id} has an invalid timestamp`);
  }
  return date;
}

function transferType(
  value: KalshiDeposit,
  direction: "DEPOSIT" | "WITHDRAWAL",
): string {
  const method = (value.type ?? "UNKNOWN").trim().toUpperCase();
  const status = (value.status ?? "FINALIZED").trim().toUpperCase();
  return `KALSHI_${method}_${direction}_${status}`;
}

export function mapDeposit(value: KalshiDeposit): AccountActivity | undefined {
  const createdAt = transferDate(value);
  if (createdAt === undefined) return undefined;
  const netAmountCents = new Decimal(value.amount_cents).minus(value.fee_cents);
  if (netAmountCents.lt(0)) {
    schemaFailure(`Kalshi deposit ${value.id} fee exceeds its amount`);
  }
  return {
    kind: "BALANCE_CHANGE",
    activityType: transferType(value, "DEPOSIT"),
    amount: netAmountCents.div(100),
    createdAt,
  };
}

export function mapWithdrawal(
  value: KalshiWithdrawal,
): AccountActivity | undefined {
  const createdAt = transferDate(value);
  if (createdAt === undefined) return undefined;
  return {
    kind: "BALANCE_CHANGE",
    activityType: transferType(value, "WITHDRAWAL"),
    amount: new Decimal(value.amount_cents).plus(value.fee_cents).div(-100),
    createdAt,
  };
}

export function mapCreateOrderResult(
  value: KalshiCreateOrderResult,
  order: ImmediateOrder,
): ExecutionResult {
  if (value.fill_count.gt(order.quantity)) {
    schemaFailure("Kalshi create response filled more than requested");
  }
  if (value.remaining_count.gt(order.quantity.minus(value.fill_count))) {
    schemaFailure("Kalshi create response has an impossible remaining count");
  }
  if (!value.remaining_count.isZero()) {
    schemaFailure("Kalshi IOC create response retained a remaining quantity");
  }
  if (value.fill_count.gt(0) && value.average_fill_price === undefined) {
    schemaFailure("Kalshi create response omitted the average fill price");
  }
  if (value.fill_count.gt(0) && value.average_fee_paid === undefined) {
    schemaFailure("Kalshi create response omitted the average fee paid");
  }
  const averageFillPrice =
    value.average_fill_price === undefined
      ? undefined
      : yesPriceToCanonicalPrice(order.side, value.average_fill_price);
  if (
    averageFillPrice !== undefined &&
    ((order.action === "BUY" &&
      averageFillPrice.gt(order.canonicalLimitPrice)) ||
      (order.action === "SELL" &&
        averageFillPrice.lt(order.canonicalLimitPrice)))
  ) {
    schemaFailure("Kalshi create response fill price violated the order limit");
  }
  const fees = (value.average_fee_paid ?? ZERO).mul(value.fill_count);
  const status = value.fill_count.eq(order.quantity)
    ? "FILLED"
    : value.fill_count.gt(0)
      ? "PARTIAL"
      : "NO_FILL";
  return {
    status,
    orderId: value.order_id,
    filledQuantity: value.fill_count,
    ...optional("averageFillPrice", averageFillPrice),
    fees,
    finalState: status === "FILLED" ? "FILLED" : "CANCELED",
  };
}
