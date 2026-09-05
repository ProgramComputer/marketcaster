import type { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { AccountActivity, ActivityQuery } from "../domain/activity.js";
import type { ExecutionResult } from "../domain/execution.js";
import type {
  Market,
  MarketBbo,
  MarketGroupQuery,
  MarketHistory,
  MarketHistoryQuery,
  MarketQuery,
  OrderBook,
  SettlementStatus,
} from "../domain/market.js";
import type {
  ExchangeOrder,
  ImmediateOrder,
  OrderPreview,
  OrderPreviewPurpose,
} from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { ExchangeId, MarketId, Page } from "../domain/primitives.js";

export interface PredictionExchange {
  readonly id: ExchangeId;
  /** Stable, opaque, non-secret scope used only to isolate local agent memory. */
  readonly memoryScope: string;

  listMarkets(query: MarketQuery): Promise<Page<Market>>;
  listMarketGroupMembers?(query: MarketGroupQuery): Promise<Page<string>>;
  getMarket(marketId: MarketId): Promise<Market>;
  getMarketBySlug(slug: string): Promise<Market>;
  getBbo(marketId: MarketId): Promise<MarketBbo>;
  getOrderBook(marketId: MarketId): Promise<OrderBook>;
  getMarketHistory?(
    marketId: MarketId,
    query: MarketHistoryQuery,
  ): Promise<MarketHistory>;
  getSettlement(marketId: MarketId): Promise<SettlementStatus>;

  getAccountSnapshot(): Promise<AccountSnapshot>;
  getPositions(): Promise<readonly Position[]>;
  getOpenOrders(): Promise<readonly ExchangeOrder[]>;
  getActivities(query: ActivityQuery): Promise<Page<AccountActivity>>;

  previewImmediateOrder(
    order: ImmediateOrder,
    purpose: OrderPreviewPurpose,
  ): Promise<OrderPreview>;
  /**
   * Returns a reusable exchange-specific estimator that upper-bounds taker
   * fees at any fill price permitted by the order's canonical limit. This is
   * a local/read-only risk estimate; placement must still obtain an
   * authoritative order preview.
   */
  createImmediateOrderFeeReserveEstimator(
    order: ImmediateOrder,
  ): Promise<(quantity: Decimal) => Decimal>;
  placeImmediateOrder(order: ImmediateOrder): Promise<ExecutionResult>;
  getOrder(orderId: string): Promise<ExchangeOrder>;
  cancelOrder(orderId: string): Promise<void>;
}

export class ExchangeError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "AUTHENTICATION"
      | "NOT_FOUND"
      | "RATE_LIMITED"
      | "SCHEMA"
      | "TRANSIENT"
      | "AMBIGUOUS_SUBMISSION"
      | "INVALID_REQUEST"
      | "UNSUPPORTED"
      | "UNKNOWN",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExchangeError";
  }
}
