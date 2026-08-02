import { z } from "zod";

import {
  DecimalInputSchema,
  NonNegativeDecimalSchema,
  PositiveDecimalSchema,
} from "../../domain/primitives.js";
import { ExchangeError } from "../exchange.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const OptionalNonEmptyStringSchema = z.preprocess(
  (value) =>
    value === null || (typeof value === "string" && value.trim().length === 0)
      ? undefined
      : value,
  NonEmptyStringSchema.optional(),
);
const OptionalCursorSchema = z.preprocess(
  (value) =>
    value === null || (typeof value === "string" && value.trim().length === 0)
      ? undefined
      : value,
  OptionalNonEmptyStringSchema,
);
const IdentifierSchema = z
  .union([NonEmptyStringSchema, z.number().int().nonnegative()])
  .transform(String);

const MarketTagSchema = z
  .object({
    id: IdentifierSchema.optional(),
    slug: NonEmptyStringSchema,
    label: OptionalNonEmptyStringSchema,
  })
  .loose();

export const DateTimeSchema = z
  .union([z.iso.datetime({ offset: true }), z.date()])
  .transform((value) =>
    value instanceof Date ? new Date(value) : new Date(value),
  );

const OptionalNullableDateTimeSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  DateTimeSchema.optional(),
);

export const ProbabilitySchema = DecimalInputSchema.refine(
  (value) => value.gte(0) && value.lte(1),
  "Expected a probability between 0 and 1",
);

export const AmountSchema = z
  .object({
    value: DecimalInputSchema,
    currency: z.literal("USD"),
  })
  .loose();

function requireOne(
  value: Record<string, unknown>,
  fields: readonly string[],
  context: z.RefinementCtx,
  label: string,
): void {
  if (!fields.some((field) => value[field] !== undefined)) {
    context.addIssue({ code: "custom", message: `Missing ${label}` });
  }
}

export const PolymarketMarketSchema = z
  .object({
    id: IdentifierSchema,
    slug: NonEmptyStringSchema,
    title: OptionalNonEmptyStringSchema,
    question: OptionalNonEmptyStringSchema,
    description: OptionalNonEmptyStringSchema,
    settlementRules: OptionalNonEmptyStringSchema,
    resolutionRules: OptionalNonEmptyStringSchema,
    rules: OptionalNonEmptyStringSchema,
    rulesDescription: OptionalNonEmptyStringSchema,
    rulesDisclaimer: OptionalNonEmptyStringSchema,
    resolutionSource: OptionalNonEmptyStringSchema,
    resolutionUrl: OptionalNonEmptyStringSchema,
    category: OptionalNonEmptyStringSchema,
    subcategory: OptionalNonEmptyStringSchema,
    active: z.boolean(),
    closed: z.boolean(),
    archived: z.boolean(),
    startDate: DateTimeSchema.optional(),
    startTime: DateTimeSchema.optional(),
    opensAt: DateTimeSchema.optional(),
    endDate: DateTimeSchema.optional(),
    endTime: DateTimeSchema.optional(),
    closesAt: DateTimeSchema.optional(),
    liquidity: NonNegativeDecimalSchema.optional(),
    liquidityNum: NonNegativeDecimalSchema.optional(),
    volume: NonNegativeDecimalSchema.optional(),
    volumeNum: NonNegativeDecimalSchema.optional(),
    volume24hr: NonNegativeDecimalSchema.optional(),
    volume24h: NonNegativeDecimalSchema.optional(),
    volume1wk: NonNegativeDecimalSchema.optional(),
    volume1mo: NonNegativeDecimalSchema.optional(),
    lastTradePrice: ProbabilitySchema.optional(),
    oneDayPriceChange: DecimalInputSchema.optional(),
    oneWeekPriceChange: DecimalInputSchema.optional(),
    openInterest: NonNegativeDecimalSchema.optional(),
    orderPriceMinTickSize: PositiveDecimalSchema.optional(),
    priceTick: PositiveDecimalSchema.optional(),
    tickSize: PositiveDecimalSchema.optional(),
    minimumPriceIncrement: PositiveDecimalSchema.optional(),
    minimumTradeQty: PositiveDecimalSchema.optional(),
    minimumTradeQuantity: PositiveDecimalSchema.optional(),
    minTradeQty: PositiveDecimalSchema.optional(),
    lotSize: PositiveDecimalSchema.optional(),
    updatedAt: DateTimeSchema.optional(),
    eventId: IdentifierSchema.optional(),
    eventSlug: OptionalNonEmptyStringSchema,
    seriesId: IdentifierSchema.optional(),
    seriesSlug: OptionalNonEmptyStringSchema,
    tags: z.array(MarketTagSchema).optional(),
  })
  .loose()
  .superRefine((value, context) => {
    requireOne(value, ["title", "question"], context, "market title/question");
    requireOne(
      value,
      [
        "settlementRules",
        "resolutionRules",
        "rules",
        "rulesDescription",
        "rulesDisclaimer",
        "description",
      ],
      context,
      "settlement rules",
    );
    requireOne(
      value,
      [
        "orderPriceMinTickSize",
        "priceTick",
        "tickSize",
        "minimumPriceIncrement",
      ],
      context,
      "market price tick",
    );
    requireOne(
      value,
      ["minimumTradeQty", "minimumTradeQuantity", "minTradeQty", "lotSize"],
      context,
      "market minimum trade quantity",
    );
  });

const MarketListPayloadSchema = z
  .object({
    markets: z.array(PolymarketMarketSchema),
    nextCursor: OptionalCursorSchema,
    eof: z.boolean().optional(),
  })
  .loose();

export const MarketsResponseSchema = z.union([
  MarketListPayloadSchema,
  z
    .object({ data: MarketListPayloadSchema })
    .loose()
    .transform((value) => value.data),
  z.array(PolymarketMarketSchema).transform((markets) => ({ markets })),
]);

export const MarketResponseSchema = z.union([
  z
    .object({ market: PolymarketMarketSchema })
    .loose()
    .transform((value) => value.market),
  z
    .object({ data: z.object({ market: PolymarketMarketSchema }).loose() })
    .loose()
    .transform((value) => value.data.market),
  PolymarketMarketSchema,
]);

const EventMarketReferenceSchema = z
  .object({ slug: NonEmptyStringSchema })
  .loose();

const PolymarketEventSchema = z
  .object({
    id: IdentifierSchema,
    slug: NonEmptyStringSchema,
    active: z.boolean(),
    closed: z.boolean(),
    archived: z.boolean(),
    markets: z.array(EventMarketReferenceSchema).optional(),
  })
  .loose();

const EventsPayloadSchema = z
  .object({ events: z.array(PolymarketEventSchema) })
  .loose();

export const EventsResponseSchema = z.union([
  EventsPayloadSchema,
  z
    .object({ data: EventsPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

const PolymarketSeriesSchema = z
  .object({ id: IdentifierSchema, slug: NonEmptyStringSchema })
  .loose();

const SeriesPayloadSchema = z
  .object({ series: z.array(PolymarketSeriesSchema) })
  .loose();

export const SeriesResponseSchema = z.union([
  SeriesPayloadSchema,
  z
    .object({ data: SeriesPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

export const OrderBookLevelSchema = z
  .object({
    px: AmountSchema,
    qty: PositiveDecimalSchema,
  })
  .loose();

const MarketStatsSchema = z
  .object({
    openPx: AmountSchema.optional(),
    closePx: AmountSchema.optional(),
    highPx: AmountSchema.optional(),
    lowPx: AmountSchema.optional(),
    lastTradePx: AmountSchema.optional(),
    currentPx: AmountSchema.optional(),
    sharesTraded: NonNegativeDecimalSchema.optional(),
    openInterest: NonNegativeDecimalSchema.optional(),
    openSetTime: DateTimeSchema.optional(),
    closeSetTime: DateTimeSchema.optional(),
    highSetTime: DateTimeSchema.optional(),
    lowSetTime: DateTimeSchema.optional(),
  })
  .loose();

const OrderBookPayloadSchema = z
  .object({
    marketSlug: NonEmptyStringSchema,
    bids: z.array(OrderBookLevelSchema),
    offers: z.array(OrderBookLevelSchema),
    state: NonEmptyStringSchema,
    stats: MarketStatsSchema.optional(),
    transactTime: DateTimeSchema.optional(),
  })
  .loose();

export const OrderBookResponseSchema = z.union([
  OrderBookPayloadSchema,
  z
    .object({ marketData: OrderBookPayloadSchema })
    .loose()
    .transform((value) => value.marketData),
  z
    .object({ book: OrderBookPayloadSchema })
    .loose()
    .transform((value) => value.book),
  z
    .object({ data: OrderBookPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

const BboPayloadSchema = z
  .object({
    marketSlug: NonEmptyStringSchema,
    bestBid: AmountSchema.optional(),
    bestAsk: AmountSchema.optional(),
    transactTime: DateTimeSchema.optional(),
    observedAt: DateTimeSchema.optional(),
  })
  .loose();

export const BboResponseSchema = z.union([
  BboPayloadSchema,
  z
    .object({ marketData: BboPayloadSchema })
    .loose()
    .transform((value) => value.marketData),
  z
    .object({ marketDataLite: BboPayloadSchema })
    .loose()
    .transform((value) => value.marketDataLite),
  z
    .object({ bbo: BboPayloadSchema })
    .loose()
    .transform((value) => value.bbo),
  z
    .object({ data: BboPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

const LegacySettlementSchema = z
  .object({
    marketSlug: NonEmptyStringSchema,
    settlementPrice: AmountSchema,
    settledAt: DateTimeSchema.optional(),
  })
  .loose()
  .transform((value) => ({
    marketSlug: value.marketSlug,
    settlementPrice: value.settlementPrice.value,
    ...(value.settledAt === undefined ? {} : { settledAt: value.settledAt }),
  }));

const CurrentSettlementSchema = z
  .object({
    slug: NonEmptyStringSchema,
    settlement: ProbabilitySchema,
    settledAt: DateTimeSchema.optional(),
  })
  .loose()
  .transform((value) => ({
    marketSlug: value.slug,
    settlementPrice: value.settlement,
    ...(value.settledAt === undefined ? {} : { settledAt: value.settledAt }),
  }));

const NormalizedSettlementSchema = z.union([
  LegacySettlementSchema,
  CurrentSettlementSchema,
]);

export const SettlementResponseSchema = z.union([
  NormalizedSettlementSchema,
  z
    .object({ marketSettlement: NormalizedSettlementSchema })
    .loose()
    .transform((value) => value.marketSettlement),
  z
    .object({ data: NormalizedSettlementSchema })
    .loose()
    .transform((value) => value.data),
]);

export const BalanceSchema = z
  .object({
    currentBalance: NonNegativeDecimalSchema,
    currency: z.literal("USD"),
    lastUpdated: OptionalNullableDateTimeSchema,
    buyingPower: NonNegativeDecimalSchema,
    assetNotional: NonNegativeDecimalSchema,
    assetAvailable: NonNegativeDecimalSchema,
    openOrders: NonNegativeDecimalSchema.optional(),
    openOrderValue: NonNegativeDecimalSchema.optional(),
    unsettledFunds: NonNegativeDecimalSchema,
    marginRequirement: NonNegativeDecimalSchema,
  })
  .loose()
  .superRefine((value, context) => {
    requireOne(
      value,
      ["openOrders", "openOrderValue"],
      context,
      "open-order value",
    );
  });

const BalancesPayloadSchema = z
  .object({ balances: z.array(BalanceSchema).min(1) })
  .loose();

export const BalancesResponseSchema = z.union([
  BalancesPayloadSchema,
  z
    .object({ data: BalancesPayloadSchema })
    .loose()
    .transform((value) => value.data),
  z
    .array(BalanceSchema)
    .min(1)
    .transform((balances) => ({ balances })),
]);

const MarketMetadataSchema = z
  .object({ slug: OptionalNonEmptyStringSchema })
  .loose();

export const UserPositionSchema = z
  .object({
    netPosition: DecimalInputSchema.optional(),
    netPositionDecimal: DecimalInputSchema.optional(),
    // NO inventory is represented with the same negative sign as netPosition.
    // mapPosition normalizes both quantities with abs() and then enforces that
    // available quantity cannot exceed total position quantity.
    qtyAvailable: DecimalInputSchema.optional(),
    qtyAvailableDecimal: DecimalInputSchema.optional(),
    cost: AmountSchema,
    realized: AmountSchema,
    expired: z.boolean(),
    updateTime: DateTimeSchema.optional(),
    marketMetadata: MarketMetadataSchema.optional(),
    cashValue: AmountSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    requireOne(
      value,
      ["netPositionDecimal", "netPosition"],
      context,
      "decimal net position",
    );
    requireOne(
      value,
      ["qtyAvailableDecimal", "qtyAvailable"],
      context,
      "decimal available quantity",
    );
  });

const PositionsPayloadSchema = z
  .object({
    positions: z.record(NonEmptyStringSchema, UserPositionSchema),
    nextCursor: OptionalCursorSchema,
    eof: z.boolean(),
  })
  .loose();

export const PositionsResponseSchema = z.union([
  PositionsPayloadSchema,
  z
    .object({ data: PositionsPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

const ResolutionPositionSchema = z.object({ realized: AmountSchema }).loose();

export const TradeActivityPayloadSchema = z
  .object({
    id: NonEmptyStringSchema,
    marketSlug: NonEmptyStringSchema,
    state: NonEmptyStringSchema,
    createTime: DateTimeSchema,
    updateTime: DateTimeSchema,
    price: AmountSchema,
    // The US API's legacy integer field truncates fractional fills (for
    // example qty="0" with qtyDecimal="0.3000").  Keep the canonical decimal
    // quantity positive, but do not reject an otherwise valid activity because
    // the lossy legacy representation rounded down to zero.
    qty: NonNegativeDecimalSchema.optional(),
    qtyDecimal: PositiveDecimalSchema.optional(),
    isAggressor: z.boolean().optional(),
    costBasis: AmountSchema.optional(),
    cost: AmountSchema.optional(),
    realizedPnl: AmountSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    requireOne(value, ["qtyDecimal", "qty"], context, "decimal trade quantity");
    if (value.qtyDecimal === undefined && value.qty?.isZero() === true) {
      context.addIssue({
        code: "custom",
        path: ["qty"],
        message: "Trade quantity needs a positive decimal quantity",
      });
    }
    requireOne(value, ["costBasis", "cost"], context, "trade cost basis");
  });

export const PositionResolutionPayloadSchema = z
  .object({
    marketSlug: NonEmptyStringSchema,
    beforePosition: ResolutionPositionSchema.optional(),
    afterPosition: ResolutionPositionSchema.optional(),
    realizedPnl: AmountSchema.optional(),
    updateTime: DateTimeSchema,
  })
  .loose()
  .superRefine((value, context) => {
    if (
      value.realizedPnl === undefined &&
      (value.beforePosition === undefined || value.afterPosition === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Position resolution needs realizedPnl or before/after realized amounts",
      });
    }
  });

export const BalanceChangeTransactionSchema = z
  .object({
    transactionId: NonEmptyStringSchema,
    status: z.string().optional(),
    amount: AmountSchema,
    updateTime: DateTimeSchema.optional(),
    createTime: DateTimeSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    requireOne(
      value,
      ["createTime", "updateTime"],
      context,
      "balance-change timestamp",
    );
  });

const BalanceChangePayloadSchema = z.union([
  z
    .object({ transactions: z.array(BalanceChangeTransactionSchema).min(1) })
    .loose()
    .transform((value) => value.transactions),
  BalanceChangeTransactionSchema.transform((value) => [value]),
]);

export const ActivitySchema = z
  .object({
    type: NonEmptyStringSchema,
    trade: TradeActivityPayloadSchema.optional(),
    positionResolution: PositionResolutionPayloadSchema.optional(),
    accountBalanceChange: BalanceChangePayloadSchema.optional(),
  })
  .loose()
  .superRefine((value, context) => {
    const populated = [
      value.trade,
      value.positionResolution,
      value.accountBalanceChange,
    ].filter((entry) => entry !== undefined).length;
    if (populated !== 1) {
      context.addIssue({
        code: "custom",
        message: "Activity must contain exactly one nested activity payload",
      });
      return;
    }
    if (value.type === "ACTIVITY_TYPE_TRADE" && value.trade === undefined) {
      context.addIssue({
        code: "custom",
        message: "Trade type/payload mismatch",
      });
    }
    if (
      value.type === "ACTIVITY_TYPE_POSITION_RESOLUTION" &&
      value.positionResolution === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Resolution type/payload mismatch",
      });
    }
    if (
      value.type !== "ACTIVITY_TYPE_TRADE" &&
      value.type !== "ACTIVITY_TYPE_POSITION_RESOLUTION" &&
      value.accountBalanceChange === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Balance-change type/payload mismatch",
      });
    }
  });

const ActivitiesPayloadSchema = z
  .object({
    activities: z.array(ActivitySchema),
    nextCursor: OptionalCursorSchema,
    eof: z.boolean(),
  })
  .loose();

export const ActivitiesResponseSchema = z.union([
  ActivitiesPayloadSchema,
  z
    .object({ data: ActivitiesPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

export const OrderIntentSchema = z.enum([
  "ORDER_INTENT_BUY_LONG",
  "ORDER_INTENT_SELL_LONG",
  "ORDER_INTENT_BUY_SHORT",
  "ORDER_INTENT_SELL_SHORT",
]);

export const OrderSideSchema = z.enum(["ORDER_SIDE_BUY", "ORDER_SIDE_SELL"]);

const OutcomeSideSchema = z.enum(["OUTCOME_SIDE_YES", "OUTCOME_SIDE_NO"]);
const OrderActionSchema = z.enum(["ORDER_ACTION_BUY", "ORDER_ACTION_SELL"]);

const CommonOrderShape = {
  id: NonEmptyStringSchema,
  marketSlug: NonEmptyStringSchema,
  side: OrderSideSchema.optional(),
  intent: OrderIntentSchema.optional(),
  outcomeSide: OutcomeSideSchema.optional(),
  action: OrderActionSchema.optional(),
  price: AmountSchema,
  quantity: PositiveDecimalSchema.optional(),
  quantityDecimal: PositiveDecimalSchema.optional(),
  cumQuantity: NonNegativeDecimalSchema.optional(),
  cumQuantityDecimal: NonNegativeDecimalSchema.optional(),
  leavesQuantity: NonNegativeDecimalSchema.optional(),
  state: NonEmptyStringSchema,
  avgPx: AmountSchema.optional(),
  insertTime: DateTimeSchema.optional(),
  createTime: DateTimeSchema.optional(),
  updateTime: DateTimeSchema.optional(),
  commissionNotionalTotalCollected: AmountSchema.optional(),
} as const;

export const OrderSchema = z
  .object(CommonOrderShape)
  .loose()
  .superRefine((value, context) => {
    requireOne(
      value,
      ["quantityDecimal", "quantity"],
      context,
      "decimal order quantity",
    );
    if (
      value.intent === undefined &&
      (value.outcomeSide === undefined || value.action === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Order needs intent or outcomeSide/action",
      });
    }
  });

const OrdersPayloadSchema = z.object({ orders: z.array(OrderSchema) }).loose();

export const OrdersResponseSchema = z.union([
  OrdersPayloadSchema,
  z
    .object({ data: OrdersPayloadSchema })
    .loose()
    .transform((value) => value.data),
  z.array(OrderSchema).transform((orders) => ({ orders })),
]);

export const OrderResponseSchema = z.union([
  z
    .object({ order: OrderSchema })
    .loose()
    .transform((value) => value.order),
  z
    .object({ data: z.object({ order: OrderSchema }).loose() })
    .loose()
    .transform((value) => value.data.order),
  OrderSchema,
]);

const PreviewOrderDetailsSchema = z
  .object({
    state: NonEmptyStringSchema.optional(),
    price: AmountSchema.optional(),
    quantity: PositiveDecimalSchema.optional(),
    quantityDecimal: PositiveDecimalSchema.optional(),
    cashOrderQty: AmountSchema.optional(),
    commissionNotionalTotalCollected: AmountSchema.optional(),
    orderRejectReason: NonEmptyStringSchema.optional(),
  })
  .loose();

const ExplicitPreviewSchema = z
  .object({
    accepted: z.boolean(),
    estimatedFees: z.union([AmountSchema, NonNegativeDecimalSchema]),
    estimatedPrincipal: z
      .union([AmountSchema, NonNegativeDecimalSchema])
      .optional(),
    estimatedCollateral: z
      .union([AmountSchema, NonNegativeDecimalSchema])
      .optional(),
    warnings: z.array(z.string()),
    rejectionReasons: z.array(z.string()),
    status: z.string().optional(),
  })
  .loose();

const OrderPreviewEnvelopeSchema = z
  .object({
    order: PreviewOrderDetailsSchema,
    accepted: z.boolean().optional(),
    estimatedFees: z.union([AmountSchema, NonNegativeDecimalSchema]).optional(),
    estimatedPrincipal: z
      .union([AmountSchema, NonNegativeDecimalSchema])
      .optional(),
    estimatedCollateral: z
      .union([AmountSchema, NonNegativeDecimalSchema])
      .optional(),
    warnings: z.array(z.string()).optional(),
    rejectionReasons: z.array(z.string()).optional(),
    status: z.string().optional(),
  })
  .loose();

export const PreviewResponseSchema = z.union([
  ExplicitPreviewSchema,
  OrderPreviewEnvelopeSchema,
  z
    .object({
      data: z.union([ExplicitPreviewSchema, OrderPreviewEnvelopeSchema]),
    })
    .loose()
    .transform((value) => value.data),
]);

const ExecutionOrderSchema = z
  .object({
    id: NonEmptyStringSchema,
    marketSlug: NonEmptyStringSchema,
    state: NonEmptyStringSchema.optional(),
    cumQuantity: NonNegativeDecimalSchema.optional(),
    cumQuantityDecimal: NonNegativeDecimalSchema.optional(),
    avgPx: AmountSchema.optional(),
    commissionNotionalTotalCollected: AmountSchema.optional(),
  })
  .loose();

export const ExecutionSchema = z
  .object({
    id: NonEmptyStringSchema,
    order: ExecutionOrderSchema,
    lastShares: NonNegativeDecimalSchema.optional(),
    lastSharesDecimal: NonNegativeDecimalSchema.optional(),
    lastPx: AmountSchema.optional(),
    type: NonEmptyStringSchema,
    text: z.string().optional(),
    orderRejectReason: z.string().optional(),
    commissionNotionalCollected: AmountSchema.optional(),
  })
  .loose();

const CreateOrderPayloadSchema = z
  .object({
    id: NonEmptyStringSchema,
    executions: z.array(ExecutionSchema).optional(),
  })
  .loose();

export const CreateOrderResponseSchema = z.union([
  CreateOrderPayloadSchema,
  z
    .object({ data: CreateOrderPayloadSchema })
    .loose()
    .transform((value) => value.data),
]);

export type PolymarketMarket = z.output<typeof PolymarketMarketSchema>;
export type PolymarketMarketPage = z.output<typeof MarketsResponseSchema>;
export type PolymarketBook = z.output<typeof OrderBookResponseSchema>;
export type PolymarketBbo = z.output<typeof BboResponseSchema>;
export type PolymarketSettlement = z.output<typeof SettlementResponseSchema>;
export type PolymarketBalance = z.output<typeof BalanceSchema>;
export type PolymarketPosition = z.output<typeof UserPositionSchema>;
export type PolymarketPositionPage = z.output<typeof PositionsResponseSchema>;
export type PolymarketActivity = z.output<typeof ActivitySchema>;
export type PolymarketActivityPage = z.output<typeof ActivitiesResponseSchema>;
export type PolymarketOrder = z.output<typeof OrderSchema>;
export type PolymarketPreview = z.output<typeof PreviewResponseSchema>;
export type PolymarketPreviewOrder = z.output<typeof PreviewOrderDetailsSchema>;
export type PolymarketCreateOrder = z.output<typeof CreateOrderResponseSchema>;

export function parseSdkResponse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  responseName: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ExchangeError(
      `Invalid Polymarket US ${responseName} response`,
      "SCHEMA",
      { cause: result.error },
    );
  }
  return result.data;
}
