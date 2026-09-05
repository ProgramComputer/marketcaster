import type { Decimal } from "decimal.js";
import type { MarketId } from "./primitives.js";

export type MarketMetricWindow = "24_HOURS" | "TRADING_SESSION";
export type MarketMetricBasis =
  "EXCHANGE_REPORTED_24H_CHANGE" | "EXCHANGE_SESSION_BOOK_STATS";

export interface MarketTag {
  readonly id?: string;
  readonly slug: string;
  readonly label?: string;
}

export interface Market {
  readonly id: MarketId;
  readonly slug: string;
  readonly eventId?: string;
  readonly eventSlug?: string;
  readonly seriesId?: string;
  readonly seriesSlug?: string;
  readonly tags?: readonly MarketTag[];
  readonly title: string;
  readonly description: string;
  readonly settlementRules: string;
  readonly resolutionSource?: string;
  readonly category?: string;
  readonly subcategory?: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly archived: boolean;
  readonly opensAt?: Date;
  readonly closesAt?: Date;
  readonly liquidity?: Decimal;
  readonly volume?: Decimal;
  readonly volume24h?: Decimal;
  readonly volume7d?: Decimal;
  readonly volume30d?: Decimal;
  readonly lastPrice?: Decimal;
  readonly priceMovement?: Decimal;
  readonly priceMovementWindow?: MarketMetricWindow;
  readonly priceMovementBasis?: MarketMetricBasis;
  readonly volatility?: Decimal;
  readonly volatilityWindow?: MarketMetricWindow;
  readonly volatilityBasis?: MarketMetricBasis;
  readonly openInterest?: Decimal;
  readonly minimumTradeQuantity: Decimal;
  readonly priceTick: Decimal;
  readonly updatedAt?: Date;
}

export interface QuoteLevel {
  readonly price: Decimal;
  readonly quantity: Decimal;
}

export interface OrderBook {
  readonly marketId: MarketId;
  readonly yesBids: readonly QuoteLevel[];
  readonly yesAsks: readonly QuoteLevel[];
  readonly currentPrice?: Decimal;
  readonly lastPrice?: Decimal;
  readonly openPrice?: Decimal;
  readonly highPrice?: Decimal;
  readonly lowPrice?: Decimal;
  readonly volume?: Decimal;
  readonly openInterest?: Decimal;
  readonly priceMovement?: Decimal;
  readonly priceMovementWindow?: MarketMetricWindow;
  readonly priceMovementBasis?: MarketMetricBasis;
  readonly volatility?: Decimal;
  readonly volatilityWindow?: MarketMetricWindow;
  readonly volatilityBasis?: MarketMetricBasis;
  readonly observedAt: Date;
  readonly observationBasis?: "EXCHANGE_TIMESTAMP" | "CLIENT_RECEIPT_TIME";
}

export interface SideBbo {
  readonly bid?: Decimal;
  readonly ask?: Decimal;
  readonly spread?: Decimal;
}

export interface MarketBbo {
  readonly marketId: MarketId;
  readonly yes: SideBbo;
  readonly no: SideBbo;
  readonly observedAt: Date;
}

export type SettlementState =
  | "OPEN"
  | "PENDING"
  | "SETTLED_YES"
  | "SETTLED_NO"
  | "SETTLED_OTHER"
  | "VOID"
  | "UNKNOWN";

export interface SettlementStatus {
  readonly marketId: MarketId;
  readonly state: SettlementState;
  readonly settlementPrice?: Decimal;
  readonly settledAt?: Date;
}

export interface MarketQuery {
  readonly active?: boolean;
  readonly closed?: boolean;
  readonly archived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly offset?: number;
  readonly orderBy?: readonly string[];
  readonly orderDirection?: "asc" | "desc";
  readonly minimumVolumeUsd?: Decimal;
}

export type MarketGroupKind = "TAG" | "EVENT" | "SERIES";

export interface MarketGroupQuery {
  readonly kind: MarketGroupKind;
  readonly value: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MarketCandle {
  readonly endedAt: Date;
  readonly open?: Decimal;
  readonly high?: Decimal;
  readonly low?: Decimal;
  readonly close?: Decimal;
  readonly previousClose?: Decimal;
  readonly volume?: Decimal;
  readonly openInterest?: Decimal;
}

export interface MarketHistoryQuery {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly intervalMinutes: number;
}

export interface MarketHistory {
  readonly source: "KALSHI_CANDLESTICKS" | "POLYMARKET_EXCHANGE_HISTORY";
  readonly candles: readonly MarketCandle[];
  readonly warnings: readonly string[];
}
