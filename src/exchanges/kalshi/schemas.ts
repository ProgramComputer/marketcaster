import { z } from "zod";

import {
  DecimalInputSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
} from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const OptionalStringSchema = z.string().optional();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const KalshiDateTimeSchema = z
  .union([z.iso.datetime({ offset: true }), z.date()])
  .transform((value) =>
    value instanceof Date ? new Date(value) : new Date(value),
  );

const NullableOptionalDateTimeSchema = KalshiDateTimeSchema.nullish().transform(
  (value) => value ?? undefined,
);
const NullableOptionalNonEmptyStringSchema =
  NonEmptyStringSchema.nullish().transform((value) => value ?? undefined);
const NullableOptionalNonNegativeIntegerSchema =
  NonNegativeIntegerSchema.nullish().transform((value) => value ?? undefined);

export const KalshiProbabilitySchema = DecimalInputSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a fixed-point dollar price between zero and one",
);

const SignedDollarSchema = DecimalInputSchema;
const NonNegativeDollarSchema = NonNegativeDecimalSchema;
const ContractCountSchema = NonNegativeDecimalSchema;

export const KalshiPriceRangeSchema = z
  .object({
    start: KalshiProbabilitySchema,
    end: KalshiProbabilitySchema,
    step: PositiveDecimalSchema,
  })
  .loose();

export const KalshiMarketSchema = z
  .object({
    ticker: NonEmptyStringSchema,
    event_ticker: NonEmptyStringSchema,
    series_ticker: NonEmptyStringSchema.optional(),
    market_type: NonEmptyStringSchema,
    // Some list responses omit title even though the detail response includes
    // it. The mapper supplies a stable display fallback for catalog entries.
    title: NonEmptyStringSchema.optional(),
    subtitle: OptionalStringSchema,
    yes_sub_title: OptionalStringSchema,
    no_sub_title: OptionalStringSchema,
    status: NonEmptyStringSchema,
    created_time: KalshiDateTimeSchema.optional(),
    updated_time: KalshiDateTimeSchema.optional(),
    open_time: KalshiDateTimeSchema.optional(),
    close_time: KalshiDateTimeSchema.optional(),
    expected_expiration_time: KalshiDateTimeSchema.optional(),
    expiration_time: KalshiDateTimeSchema.optional(),
    latest_expiration_time: KalshiDateTimeSchema.optional(),
    settlement_ts: KalshiDateTimeSchema.optional(),
    rules_primary: z.string(),
    rules_secondary: OptionalStringSchema,
    early_close_condition: OptionalStringSchema,
    yes_bid_dollars: KalshiProbabilitySchema.optional(),
    yes_ask_dollars: KalshiProbabilitySchema.optional(),
    no_bid_dollars: KalshiProbabilitySchema.optional(),
    no_ask_dollars: KalshiProbabilitySchema.optional(),
    last_price_dollars: KalshiProbabilitySchema.optional(),
    previous_price_dollars: KalshiProbabilitySchema.optional(),
    settlement_value_dollars: KalshiProbabilitySchema.optional(),
    volume_fp: ContractCountSchema.optional(),
    volume_24h_fp: ContractCountSchema.optional(),
    open_interest_fp: ContractCountSchema.optional(),
    liquidity_dollars: NonNegativeDollarSchema.optional(),
    notional_value_dollars: NonNegativeDollarSchema.optional(),
    price_level_structure: NonEmptyStringSchema.optional(),
    price_ranges: z.array(KalshiPriceRangeSchema).optional(),
    fractional_trading_enabled: z.boolean().optional(),
    result: z.string().optional(),
    market_result: z.string().optional(),
    is_provisional: z.boolean().optional(),
    mve_collection_ticker: NonEmptyStringSchema.optional(),
    mve_selected_legs: z.array(z.unknown()).optional(),
    exchange_index: NonNegativeIntegerSchema.optional(),
  })
  .loose();

export const KalshiMarketsResponseSchema = z
  .object({
    markets: z.array(KalshiMarketSchema),
    cursor: z.string(),
  })
  .loose();

// The historical tier can omit live-only lifecycle fields. Presence in this
// tier is itself authoritative evidence that the market is archived.
export const KalshiHistoricalMarketSchema = KalshiMarketSchema.extend({
  status: NonEmptyStringSchema.optional(),
}).transform((market) => ({ ...market, status: "finalized" }));

export const KalshiHistoricalMarketResponseSchema = z
  .object({ market: KalshiHistoricalMarketSchema })
  .loose();

export const KalshiHistoricalMarketsResponseSchema = z
  .object({
    markets: z.array(KalshiHistoricalMarketSchema),
    cursor: z.string(),
  })
  .loose();

export const KalshiMarketResponseSchema = z
  .object({ market: KalshiMarketSchema })
  .loose();

export const KalshiEventSchema = z
  .object({
    event_ticker: NonEmptyStringSchema,
    series_ticker: NonEmptyStringSchema,
    fee_type_override: NonEmptyStringSchema.nullish(),
    fee_multiplier_override: NonNegativeDecimalSchema.nullish(),
    exchange_index: NonNegativeIntegerSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    const hasType = value.fee_type_override != null;
    const hasMultiplier = value.fee_multiplier_override != null;
    if (hasType !== hasMultiplier) {
      context.addIssue({
        code: "custom",
        message: "Kalshi event fee override fields must appear together",
      });
    }
  });

export const KalshiEventResponseSchema = z
  .object({ event: KalshiEventSchema })
  .loose();

export const KalshiSeriesSchema = z
  .object({
    ticker: NonEmptyStringSchema,
    category: OptionalStringSchema,
    tags: z.array(NonEmptyStringSchema).optional(),
    fee_type: NonEmptyStringSchema,
    fee_multiplier: NonNegativeDecimalSchema,
    exchange_index: NonNegativeIntegerSchema.optional(),
  })
  .loose();

export const KalshiSeriesResponseSchema = z
  .object({ series: KalshiSeriesSchema })
  .loose();

export const KalshiSeriesListResponseSchema = z
  .object({ series: z.array(KalshiSeriesSchema) })
  .loose();

export const KalshiSeriesFeeChangesResponseSchema = z
  .object({
    series_fee_change_arr: z.array(
      z
        .object({
          id: NonEmptyStringSchema,
          series_ticker: NonEmptyStringSchema,
          fee_type: NonEmptyStringSchema,
          fee_multiplier: NonNegativeDecimalSchema,
          scheduled_ts: KalshiDateTimeSchema,
        })
        .loose(),
    ),
  })
  .loose();

export const KalshiEventFeeChangeSchema = z
  .object({
    id: NonEmptyStringSchema,
    event_ticker: NonEmptyStringSchema,
    series_ticker: NonEmptyStringSchema,
    fee_type_override: NonEmptyStringSchema.nullable(),
    fee_multiplier_override: NonNegativeDecimalSchema.nullable(),
    scheduled_ts: KalshiDateTimeSchema,
  })
  .loose()
  .superRefine((value, context) => {
    if (
      (value.fee_type_override === null) !==
      (value.fee_multiplier_override === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Kalshi scheduled event fee override fields must match",
      });
    }
  });

export const KalshiEventFeeChangesResponseSchema = z
  .object({
    event_fee_changes: z.array(KalshiEventFeeChangeSchema),
    cursor: z.string(),
  })
  .loose();

export const KalshiOrderBookLevelSchema = z.tuple([
  KalshiProbabilitySchema,
  PositiveDecimalSchema,
]);

export const KalshiOrderBookResponseSchema = z
  .object({
    orderbook_fp: z
      .object({
        yes_dollars: z.array(KalshiOrderBookLevelSchema),
        no_dollars: z.array(KalshiOrderBookLevelSchema),
      })
      .loose(),
  })
  .loose();

const NullableKalshiProbabilitySchema =
  KalshiProbabilitySchema.nullish().transform((value) => value ?? undefined);

const KalshiCandlestickPriceSchema = z
  .object({
    open_dollars: NullableKalshiProbabilitySchema,
    low_dollars: NullableKalshiProbabilitySchema,
    high_dollars: NullableKalshiProbabilitySchema,
    close_dollars: NullableKalshiProbabilitySchema,
    mean_dollars: NullableKalshiProbabilitySchema,
    previous_dollars: NullableKalshiProbabilitySchema,
    min_dollars: NullableKalshiProbabilitySchema,
    max_dollars: NullableKalshiProbabilitySchema,
  })
  .loose();

export const KalshiCandlestickSchema = z
  .object({
    end_period_ts: NonNegativeIntegerSchema,
    price: KalshiCandlestickPriceSchema,
    volume_fp: ContractCountSchema.optional(),
    open_interest_fp: ContractCountSchema.optional(),
  })
  .loose();

export const KalshiMarketCandlesticksResponseSchema = z
  .object({
    markets: z.array(
      z
        .object({
          market_ticker: NonEmptyStringSchema,
          candlesticks: z.array(KalshiCandlestickSchema),
        })
        .loose(),
    ),
  })
  .loose();

const KalshiHistoricalCandlestickPriceSchema = z
  .object({
    open: NullableKalshiProbabilitySchema,
    low: NullableKalshiProbabilitySchema,
    high: NullableKalshiProbabilitySchema,
    close: NullableKalshiProbabilitySchema,
    mean: NullableKalshiProbabilitySchema,
    previous: NullableKalshiProbabilitySchema,
    min: NullableKalshiProbabilitySchema,
    max: NullableKalshiProbabilitySchema,
    // Accept the fixed-point aliases as well so this remains compatible while
    // Kalshi transitions historical responses to the live candle envelope.
    open_dollars: NullableKalshiProbabilitySchema,
    low_dollars: NullableKalshiProbabilitySchema,
    high_dollars: NullableKalshiProbabilitySchema,
    close_dollars: NullableKalshiProbabilitySchema,
    mean_dollars: NullableKalshiProbabilitySchema,
    previous_dollars: NullableKalshiProbabilitySchema,
    min_dollars: NullableKalshiProbabilitySchema,
    max_dollars: NullableKalshiProbabilitySchema,
  })
  .loose()
  .transform((value) => ({
    open_dollars: value.open_dollars ?? value.open,
    low_dollars: value.low_dollars ?? value.low,
    high_dollars: value.high_dollars ?? value.high,
    close_dollars: value.close_dollars ?? value.close,
    mean_dollars: value.mean_dollars ?? value.mean,
    previous_dollars: value.previous_dollars ?? value.previous,
    min_dollars: value.min_dollars ?? value.min,
    max_dollars: value.max_dollars ?? value.max,
  }));

const KalshiHistoricalCandlestickSchema = z
  .object({
    end_period_ts: NonNegativeIntegerSchema,
    price: KalshiHistoricalCandlestickPriceSchema,
    volume: ContractCountSchema.optional(),
    volume_fp: ContractCountSchema.optional(),
    open_interest: ContractCountSchema.optional(),
    open_interest_fp: ContractCountSchema.optional(),
  })
  .loose()
  .transform((value) => ({
    end_period_ts: value.end_period_ts,
    price: value.price,
    volume_fp: value.volume_fp ?? value.volume,
    open_interest_fp: value.open_interest_fp ?? value.open_interest,
  }));

export const KalshiHistoricalMarketCandlesticksResponseSchema = z
  .object({
    ticker: NonEmptyStringSchema,
    candlesticks: z.array(KalshiHistoricalCandlestickSchema),
  })
  .loose();

export const KalshiBalanceResponseSchema = z
  .object({
    balance: NonNegativeIntegerSchema,
    balance_dollars: NonNegativeDollarSchema.optional(),
    portfolio_value: NonNegativeIntegerSchema,
    portfolio_value_dollars: NonNegativeDollarSchema.optional(),
    updated_ts: NonNegativeIntegerSchema,
    balance_breakdown: z
      .array(
        z
          .object({
            exchange_index: NonNegativeIntegerSchema,
            balance: NonNegativeDollarSchema,
          })
          .loose(),
      )
      .optional(),
  })
  // Fixed-point dollar fields can carry centicent precision that legacy
  // integer-cent fields cannot represent, so do not require exact equality.
  .loose();

export const KalshiMarketPositionSchema = z
  .object({
    ticker: NonEmptyStringSchema,
    total_traded_dollars: NonNegativeDollarSchema,
    position_fp: DecimalInputSchema,
    market_exposure_dollars: NonNegativeDollarSchema,
    realized_pnl_dollars: SignedDollarSchema,
    resting_orders_count: NonNegativeIntegerSchema.optional(),
    fees_paid_dollars: NonNegativeDollarSchema,
    last_updated_ts: KalshiDateTimeSchema.optional(),
  })
  .loose();

export const KalshiEventPositionSchema = z
  .object({
    event_ticker: NonEmptyStringSchema,
    total_cost_dollars: NonNegativeDollarSchema,
    total_cost_shares_fp: ContractCountSchema,
    event_exposure_dollars: NonNegativeDollarSchema,
    realized_pnl_dollars: SignedDollarSchema,
    fees_paid_dollars: NonNegativeDollarSchema,
  })
  .loose();

export const KalshiPositionsResponseSchema = z
  .object({
    market_positions: z.array(KalshiMarketPositionSchema),
    event_positions: z.array(KalshiEventPositionSchema),
    cursor: z.string(),
  })
  .loose();

export const KalshiOrderSchema = z
  .object({
    order_id: NonEmptyStringSchema,
    client_order_id: NonEmptyStringSchema.optional(),
    ticker: NonEmptyStringSchema,
    side: z.enum(["yes", "no"]).optional(),
    action: z.enum(["buy", "sell"]).optional(),
    outcome_side: z.enum(["yes", "no"]).optional(),
    book_side: z.enum(["bid", "ask"]).optional(),
    is_yes: z.boolean().optional(),
    type: NonEmptyStringSchema.optional(),
    status: NonEmptyStringSchema,
    yes_price_dollars: KalshiProbabilitySchema,
    no_price_dollars: KalshiProbabilitySchema,
    fill_count_fp: ContractCountSchema,
    remaining_count_fp: ContractCountSchema,
    initial_count_fp: PositiveDecimalSchema,
    taker_fill_cost_dollars: NonNegativeDollarSchema.optional(),
    maker_fill_cost_dollars: NonNegativeDollarSchema.optional(),
    taker_fees_dollars: NonNegativeDollarSchema.optional(),
    maker_fees_dollars: NonNegativeDollarSchema.optional(),
    expiration_time: NullableOptionalDateTimeSchema,
    created_time: NullableOptionalDateTimeSchema,
    last_update_time: NullableOptionalDateTimeSchema,
    self_trade_prevention_type: NullableOptionalNonEmptyStringSchema,
    cancel_order_on_pause: z.boolean().optional(),
    subaccount_number: NullableOptionalNonNegativeIntegerSchema,
    exchange_index: NonNegativeIntegerSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if (
      (value.outcome_side === undefined) !==
      (value.book_side === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Order outcome_side and book_side must appear together",
      });
    }
    if (
      value.outcome_side !== undefined &&
      value.book_side !== undefined &&
      (value.outcome_side === "yes") !== (value.book_side === "bid")
    ) {
      context.addIssue({
        code: "custom",
        message: "Order outcome_side contradicts book_side",
      });
    }
    if ((value.side === undefined) !== (value.action === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Order legacy side/action must appear together",
      });
    }
  });

export const KalshiOrdersResponseSchema = z
  .object({
    orders: z.array(KalshiOrderSchema),
    cursor: z.string(),
  })
  .loose();

export const KalshiOrderResponseSchema = z
  .object({ order: KalshiOrderSchema })
  .loose();

export const KalshiFillSchema = z
  .object({
    fill_id: NonEmptyStringSchema,
    trade_id: NonEmptyStringSchema.optional(),
    order_id: NonEmptyStringSchema,
    ticker: NonEmptyStringSchema.optional(),
    market_ticker: NonEmptyStringSchema.optional(),
    side: z.enum(["yes", "no"]).optional(),
    action: z.enum(["buy", "sell"]).optional(),
    outcome_side: z.enum(["yes", "no"]),
    book_side: z.enum(["bid", "ask"]),
    is_yes: z.boolean().optional(),
    count_fp: PositiveDecimalSchema,
    yes_price_dollars: KalshiProbabilitySchema,
    no_price_dollars: KalshiProbabilitySchema,
    is_taker: z.boolean(),
    fee_cost: NonNegativeDollarSchema,
    created_time: NullableOptionalDateTimeSchema,
    subaccount_number: NullableOptionalNonNegativeIntegerSchema,
    ts: NonNegativeIntegerSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if ((value.outcome_side === "yes") !== (value.book_side === "bid")) {
      context.addIssue({
        code: "custom",
        message: "Fill outcome_side contradicts book_side",
      });
    }
    if ((value.side === undefined) !== (value.action === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Fill legacy side/action must appear together",
      });
    }
    if (value.ticker === undefined && value.market_ticker === undefined) {
      context.addIssue({
        code: "custom",
        message: "Fill is missing ticker/market_ticker",
      });
    }
    if (
      value.ticker !== undefined &&
      value.market_ticker !== undefined &&
      value.ticker !== value.market_ticker
    ) {
      context.addIssue({
        code: "custom",
        message: "Fill ticker contradicts market_ticker",
      });
    }
    if (value.created_time === undefined && value.ts === undefined) {
      context.addIssue({
        code: "custom",
        message: "Fill is missing created_time/ts",
      });
    }
  });

export const KalshiFillsResponseSchema = z
  .object({
    fills: z.array(KalshiFillSchema),
    cursor: z.string(),
  })
  .loose();

// Historical payloads can omit direction; YES/NO prices still preserve the
// single-book price scale for canonical consumers. Current fills remain
// strict because the live endpoint requires both V2 direction fields.
export const KalshiHistoricalFillSchema = z
  .object({
    ...KalshiFillSchema.shape,
    outcome_side: z.enum(["yes", "no"]).optional(),
    book_side: z.enum(["bid", "ask"]).optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if (
      (value.outcome_side === undefined) !==
      (value.book_side === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical fill direction fields must appear together",
      });
    }
    if (
      value.outcome_side !== undefined &&
      value.book_side !== undefined &&
      (value.outcome_side === "yes") !== (value.book_side === "bid")
    ) {
      context.addIssue({
        code: "custom",
        message: "Fill outcome_side contradicts book_side",
      });
    }
    if ((value.side === undefined) !== (value.action === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Fill legacy side/action must appear together",
      });
    }
    if (value.ticker === undefined && value.market_ticker === undefined) {
      context.addIssue({
        code: "custom",
        message: "Fill is missing ticker/market_ticker",
      });
    }
    if (
      value.ticker !== undefined &&
      value.market_ticker !== undefined &&
      value.ticker !== value.market_ticker
    ) {
      context.addIssue({
        code: "custom",
        message: "Fill ticker contradicts market_ticker",
      });
    }
    if (value.created_time === undefined && value.ts === undefined) {
      context.addIssue({
        code: "custom",
        message: "Fill is missing created_time/ts",
      });
    }
  });

export const KalshiHistoricalCutoffSchema = z
  .object({
    market_settled_ts: KalshiDateTimeSchema,
    trades_created_ts: KalshiDateTimeSchema,
    orders_updated_ts: KalshiDateTimeSchema,
    market_positions_last_updated_ts: KalshiDateTimeSchema.optional(),
  })
  .loose();

export const KalshiHistoricalFillsResponseSchema = z
  .object({
    fills: z.array(KalshiHistoricalFillSchema),
    cursor: z.string(),
  })
  .loose();

const KalshiCashTransferSchema = z
  .object({
    id: NonEmptyStringSchema,
    status: NonEmptyStringSchema.optional(),
    type: NonEmptyStringSchema.optional(),
    amount_cents: NonNegativeIntegerSchema,
    fee_cents: NonNegativeIntegerSchema,
    created_ts: NonNegativeIntegerSchema,
    finalized_ts: NonNegativeIntegerSchema.nullish(),
  })
  .loose();

export const KalshiDepositSchema = KalshiCashTransferSchema;

export const KalshiDepositsResponseSchema = z
  .object({
    deposits: z.array(KalshiDepositSchema),
    // Kalshi omits the cursor on terminal transfer-history pages.
    cursor: z.string().default(""),
  })
  .loose();

export const KalshiWithdrawalSchema = KalshiCashTransferSchema;

export const KalshiWithdrawalsResponseSchema = z
  .object({
    withdrawals: z.array(KalshiWithdrawalSchema),
    // Kalshi omits the cursor on terminal transfer-history pages.
    cursor: z.string().default(""),
  })
  .loose();

export const KalshiSettlementSchema = z
  .object({
    ticker: NonEmptyStringSchema,
    event_ticker: NonEmptyStringSchema.optional(),
    // Removed from the current settlements response, but accepted for
    // compatibility with older payloads.
    market_result: NonEmptyStringSchema.optional(),
    yes_count_fp: ContractCountSchema,
    yes_total_cost_dollars: NonNegativeDollarSchema,
    no_count_fp: ContractCountSchema,
    no_total_cost_dollars: NonNegativeDollarSchema,
    revenue: NonNegativeIntegerSchema,
    settled_time: KalshiDateTimeSchema,
    fee_cost: NonNegativeDollarSchema.optional(),
    value: NullableOptionalNonNegativeIntegerSchema,
  })
  .loose();

export const KalshiSettlementsResponseSchema = z
  .object({
    settlements: z.array(KalshiSettlementSchema),
    cursor: z.string(),
  })
  .loose();

export const KalshiCreateOrderResponseSchema = z
  .object({
    order_id: NonEmptyStringSchema,
    client_order_id: NonEmptyStringSchema.optional(),
    fill_count: ContractCountSchema,
    remaining_count: ContractCountSchema,
    average_fill_price: KalshiProbabilitySchema.optional(),
    average_fee_paid: NonNegativeDollarSchema.optional(),
    ts_ms: NonNegativeIntegerSchema,
  })
  .loose();

export const KalshiCancelOrderResponseSchema = z
  .object({
    order_id: NonEmptyStringSchema,
    client_order_id: NonEmptyStringSchema.optional(),
    reduced_by: ContractCountSchema,
    ts_ms: NonNegativeIntegerSchema,
  })
  .loose();

export type KalshiMarket = z.output<typeof KalshiMarketSchema>;
export type KalshiEvent = z.output<typeof KalshiEventSchema>;
export type KalshiSeries = z.output<typeof KalshiSeriesSchema>;
export type KalshiMarketPage = z.output<typeof KalshiMarketsResponseSchema>;
export type KalshiOrderBook = z.output<typeof KalshiOrderBookResponseSchema>;
export type KalshiCandlestick = z.output<typeof KalshiCandlestickSchema>;
export type KalshiBalance = z.output<typeof KalshiBalanceResponseSchema>;
export type KalshiMarketPosition = z.output<typeof KalshiMarketPositionSchema>;
export type KalshiPositionPage = z.output<typeof KalshiPositionsResponseSchema>;
export type KalshiOrder = z.output<typeof KalshiOrderSchema>;
export type KalshiOrderPage = z.output<typeof KalshiOrdersResponseSchema>;
export type KalshiFill = z.output<typeof KalshiFillSchema>;
export type KalshiFillPage = z.output<typeof KalshiFillsResponseSchema>;
export type KalshiHistoricalFill = z.output<typeof KalshiHistoricalFillSchema>;
export type KalshiHistoricalCutoff = z.output<
  typeof KalshiHistoricalCutoffSchema
>;
export type KalshiHistoricalFillPage = z.output<
  typeof KalshiHistoricalFillsResponseSchema
>;
export type KalshiDeposit = z.output<typeof KalshiDepositSchema>;
export type KalshiDepositPage = z.output<typeof KalshiDepositsResponseSchema>;
export type KalshiWithdrawal = z.output<typeof KalshiWithdrawalSchema>;
export type KalshiWithdrawalPage = z.output<
  typeof KalshiWithdrawalsResponseSchema
>;
export type KalshiSettlement = z.output<typeof KalshiSettlementSchema>;
export type KalshiSettlementPage = z.output<
  typeof KalshiSettlementsResponseSchema
>;
export type KalshiCreateOrderResult = z.output<
  typeof KalshiCreateOrderResponseSchema
>;
export type KalshiCancelOrderResult = z.output<
  typeof KalshiCancelOrderResponseSchema
>;

export function parseKalshiResponse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  responseName: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ExchangeError(
      `Invalid Kalshi ${responseName} response`,
      "SCHEMA",
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}
