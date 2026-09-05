import { Decimal } from "decimal.js";
import type {
  Market,
  MarketCandle,
  MarketHistory,
  OrderBook,
} from "../domain/market.js";
import { serializeDecimal } from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";

export type MarketAnalysisWindow = "24_HOURS" | "7_DAYS" | "30_DAYS";

export interface MarketAnalysisRequest {
  readonly marketSlug: string;
  readonly window: MarketAnalysisWindow;
}

export interface MarketAnalysisResult {
  readonly marketSlug: string;
  readonly window: MarketAnalysisWindow;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly intervalMinutes: number;
  readonly history: {
    readonly availability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    readonly source?: MarketHistory["source"];
    readonly sampleCount: number;
    readonly open?: string;
    readonly high?: string;
    readonly low?: string;
    readonly close?: string;
    readonly absolutePriceChange?: string;
    readonly intervalPriceChangeStdDev?: string;
    readonly volatilityBasis?: "SAMPLE_STDDEV_OF_INTERVAL_PRICE_CHANGES";
    readonly volumeContracts?: string;
    readonly openingOpenInterest?: string;
    readonly closingOpenInterest?: string;
    readonly openInterestChange?: string;
    readonly candles: readonly {
      readonly endedAt: string;
      readonly open?: string;
      readonly high?: string;
      readonly low?: string;
      readonly close?: string;
      readonly volumeContracts?: string;
      readonly openInterest?: string;
    }[];
  };
  readonly currentBook?: {
    readonly observedAt: string;
    readonly observationBasis: "EXCHANGE_TIMESTAMP" | "CLIENT_RECEIPT_TIME";
    readonly yesBid?: string;
    readonly yesAsk?: string;
    readonly noBid?: string;
    readonly noAsk?: string;
    readonly spread?: string;
    readonly bidDepthContracts: string;
    readonly askDepthContracts: string;
    readonly sessionOpen?: string;
    readonly sessionHigh?: string;
    readonly sessionLow?: string;
    readonly currentPrice?: string;
    readonly lastPrice?: string;
    readonly openInterest?: string;
  };
  readonly warnings: readonly string[];
}

interface WindowDefinition {
  readonly milliseconds: number;
  readonly intervalMinutes: number;
}

const WINDOW_DEFINITIONS: Readonly<
  Record<MarketAnalysisWindow, WindowDefinition>
> = Object.freeze({
  "24_HOURS": { milliseconds: 86_400_000, intervalMinutes: 60 },
  "7_DAYS": { milliseconds: 7 * 86_400_000, intervalMinutes: 60 },
  "30_DAYS": { milliseconds: 30 * 86_400_000, intervalMinutes: 240 },
});

function optionalDecimal(value: Decimal | undefined): string | undefined {
  return value === undefined ? undefined : serializeDecimal(value);
}

function extrema(
  candles: readonly MarketCandle[],
  key: "high" | "low",
): Decimal | undefined {
  const values = candles
    .map((candle) => candle[key])
    .filter((value): value is Decimal => value !== undefined);
  if (values.length === 0) return undefined;
  return key === "high" ? Decimal.max(...values) : Decimal.min(...values);
}

function intervalChangeStdDev(
  candles: readonly MarketCandle[],
): Decimal | undefined {
  const closes = candles
    .map((candle) => candle.close)
    .filter((value): value is Decimal => value !== undefined);
  if (closes.length < 3) return undefined;
  const changes = closes.slice(1).map((close, index) => {
    const prior = closes[index];
    return prior === undefined ? new Decimal(0) : close.minus(prior);
  });
  if (changes.length < 2) return undefined;
  const mean = changes
    .reduce((total, change) => total.plus(change), new Decimal(0))
    .div(changes.length);
  const variance = changes
    .reduce(
      (total, change) => total.plus(change.minus(mean).pow(2)),
      new Decimal(0),
    )
    .div(changes.length - 1);
  return variance.sqrt();
}

function historyContext(
  history: MarketHistory | undefined,
): MarketAnalysisResult["history"] {
  const candles = history?.candles ?? [];
  const first = candles.find(
    (candle) => candle.open !== undefined || candle.previousClose !== undefined,
  );
  const last = candles.findLast((candle) => candle.close !== undefined);
  const open = first?.open ?? first?.previousClose;
  const close = last?.close;
  const high = extrema(candles, "high");
  const low = extrema(candles, "low");
  const volatility = intervalChangeStdDev(candles);
  const openInterestValues = candles
    .map((candle) => candle.openInterest)
    .filter((value): value is Decimal => value !== undefined);
  const openingOpenInterest = openInterestValues[0];
  const closingOpenInterest = openInterestValues.at(-1);
  const volumeValues = candles
    .map((candle) => candle.volume)
    .filter((value): value is Decimal => value !== undefined);
  const volume =
    volumeValues.length === 0
      ? undefined
      : volumeValues.reduce(
          (total, value) => total.plus(value),
          new Decimal(0),
        );
  const availability =
    history === undefined || candles.length === 0
      ? ("UNAVAILABLE" as const)
      : open === undefined || close === undefined || volatility === undefined
        ? ("PARTIAL" as const)
        : ("AVAILABLE" as const);
  const openValue = optionalDecimal(open);
  const highValue = optionalDecimal(high);
  const lowValue = optionalDecimal(low);
  const closeValue = optionalDecimal(close);

  return {
    availability,
    ...(history === undefined ? {} : { source: history.source }),
    sampleCount: candles.length,
    ...(openValue === undefined ? {} : { open: openValue }),
    ...(highValue === undefined ? {} : { high: highValue }),
    ...(lowValue === undefined ? {} : { low: lowValue }),
    ...(closeValue === undefined ? {} : { close: closeValue }),
    ...(open === undefined || close === undefined
      ? {}
      : { absolutePriceChange: serializeDecimal(close.minus(open).abs()) }),
    ...(volatility === undefined
      ? {}
      : {
          intervalPriceChangeStdDev: serializeDecimal(volatility),
          volatilityBasis: "SAMPLE_STDDEV_OF_INTERVAL_PRICE_CHANGES" as const,
        }),
    ...(volume === undefined
      ? {}
      : { volumeContracts: serializeDecimal(volume) }),
    ...(openingOpenInterest === undefined
      ? {}
      : { openingOpenInterest: serializeDecimal(openingOpenInterest) }),
    ...(closingOpenInterest === undefined
      ? {}
      : { closingOpenInterest: serializeDecimal(closingOpenInterest) }),
    ...(openingOpenInterest === undefined || closingOpenInterest === undefined
      ? {}
      : {
          openInterestChange: serializeDecimal(
            closingOpenInterest.minus(openingOpenInterest),
          ),
        }),
    candles: candles.map((candle) => ({
      endedAt: candle.endedAt.toISOString(),
      ...(candle.open === undefined
        ? {}
        : { open: serializeDecimal(candle.open) }),
      ...(candle.high === undefined
        ? {}
        : { high: serializeDecimal(candle.high) }),
      ...(candle.low === undefined
        ? {}
        : { low: serializeDecimal(candle.low) }),
      ...(candle.close === undefined
        ? {}
        : { close: serializeDecimal(candle.close) }),
      ...(candle.volume === undefined
        ? {}
        : { volumeContracts: serializeDecimal(candle.volume) }),
      ...(candle.openInterest === undefined
        ? {}
        : { openInterest: serializeDecimal(candle.openInterest) }),
    })),
  };
}

function bookContext(
  book: OrderBook,
): NonNullable<MarketAnalysisResult["currentBook"]> {
  const yesBid = book.yesBids[0]?.price;
  const yesAsk = book.yesAsks[0]?.price;
  const noBid = yesAsk === undefined ? undefined : new Decimal(1).minus(yesAsk);
  const noAsk = yesBid === undefined ? undefined : new Decimal(1).minus(yesBid);
  const bidDepth = book.yesBids.reduce(
    (total, level) => total.plus(level.quantity),
    new Decimal(0),
  );
  const askDepth = book.yesAsks.reduce(
    (total, level) => total.plus(level.quantity),
    new Decimal(0),
  );
  return {
    observedAt: book.observedAt.toISOString(),
    observationBasis: book.observationBasis ?? "CLIENT_RECEIPT_TIME",
    ...(yesBid === undefined ? {} : { yesBid: serializeDecimal(yesBid) }),
    ...(yesAsk === undefined ? {} : { yesAsk: serializeDecimal(yesAsk) }),
    ...(noBid === undefined ? {} : { noBid: serializeDecimal(noBid) }),
    ...(noAsk === undefined ? {} : { noAsk: serializeDecimal(noAsk) }),
    ...(yesBid === undefined || yesAsk === undefined
      ? {}
      : { spread: serializeDecimal(yesAsk.minus(yesBid)) }),
    bidDepthContracts: serializeDecimal(bidDepth),
    askDepthContracts: serializeDecimal(askDepth),
    ...(book.openPrice === undefined
      ? {}
      : { sessionOpen: serializeDecimal(book.openPrice) }),
    ...(book.highPrice === undefined
      ? {}
      : { sessionHigh: serializeDecimal(book.highPrice) }),
    ...(book.lowPrice === undefined
      ? {}
      : { sessionLow: serializeDecimal(book.lowPrice) }),
    ...(book.currentPrice === undefined
      ? {}
      : { currentPrice: serializeDecimal(book.currentPrice) }),
    ...(book.lastPrice === undefined
      ? {}
      : { lastPrice: serializeDecimal(book.lastPrice) }),
    ...(book.openInterest === undefined
      ? {}
      : { openInterest: serializeDecimal(book.openInterest) }),
  };
}

export class MarketAnalysisResolver {
  public constructor(
    private readonly exchange: PredictionExchange,
    private readonly marketsBySlug: ReadonlyMap<string, Market>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async analyze(
    request: MarketAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<MarketAnalysisResult> {
    const market = this.marketsBySlug.get(request.marketSlug);
    if (market === undefined) {
      throw new Error(`Market ${request.marketSlug} is not in the catalog`);
    }
    const definition = WINDOW_DEFINITIONS[request.window];
    const endsAt = this.now();
    if (Number.isNaN(endsAt.getTime())) {
      throw new Error("Market-analysis time is invalid");
    }
    const startsAt = new Date(endsAt.getTime() - definition.milliseconds);
    signal?.throwIfAborted();
    const warnings: string[] = [];
    let history: MarketHistory | undefined;
    if (this.exchange.getMarketHistory === undefined) {
      warnings.push(
        `Historical candles are unavailable from ${this.exchange.id}`,
      );
    } else {
      try {
        history = await this.exchange.getMarketHistory(market.id, {
          startsAt,
          endsAt,
          intervalMinutes: definition.intervalMinutes,
        });
        warnings.push(...history.warnings);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        warnings.push(
          `Historical candles could not be fetched for ${market.slug}`,
        );
      }
    }
    signal?.throwIfAborted();
    let book: OrderBook | undefined;
    try {
      book = await this.exchange.getOrderBook(market.id);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      warnings.push(
        `Current order book could not be fetched for ${market.slug}`,
      );
    }
    signal?.throwIfAborted();
    return {
      marketSlug: market.slug,
      window: request.window,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      intervalMinutes: definition.intervalMinutes,
      history: historyContext(history),
      ...(book === undefined ? {} : { currentBook: bookContext(book) }),
      warnings,
    };
  }
}
