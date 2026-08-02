import { Decimal } from "decimal.js";
import type { Market } from "../domain/market.js";
import type { ImmediateOrder } from "../domain/order.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";
import { serializeDecimal } from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import {
  canonicalBookLevels,
  totalEligibleQuantity,
  walkCanonicalBook,
} from "../execution/depth.js";

export interface AdvisoryTradePreviewRequest {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly quantity: Decimal;
  readonly limitPrice: Decimal;
}

export interface AdvisoryTradePreviewResult {
  readonly readOnly: true;
  readonly authoritativeForExecution: false;
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly quantity: string;
  readonly limitPrice: string;
  readonly bookObservedAt: string;
  readonly bookObservationBasis: "EXCHANGE_TIMESTAMP" | "CLIENT_RECEIPT_TIME";
  readonly depth: {
    readonly maximumImmediatelyFillableQuantity: string;
    readonly requestedFillableQuantity: string;
    readonly fullyFillable: boolean;
    readonly principal: string;
    readonly vwap?: string;
    readonly worstPrice?: string;
    readonly bestPrice?: string;
    readonly priceImpact?: string;
  };
  readonly feePreview: {
    readonly accepted: boolean;
    readonly basis: "EXCHANGE" | "LOCAL_CONSERVATIVE" | "UNSPECIFIED";
    readonly observedAt?: string;
    readonly estimatedFees: string;
    readonly estimatedPrincipal?: string;
    readonly estimatedCollateral?: string;
    readonly warnings: readonly string[];
    readonly rejectionReasons: readonly string[];
    readonly rawStatus?: string;
  };
  readonly costs: {
    readonly expectedBookSpend: string;
    readonly exchangeReportedFees?: string;
    readonly conservativeFeeReserve: string;
    readonly maximumSpendAtLimit: string;
  };
  readonly warnings: readonly string[];
}

export class AdvisoryTradePreviewResolver {
  public constructor(
    private readonly exchange: PredictionExchange,
    private readonly marketsBySlug: ReadonlyMap<string, Market>,
  ) {}

  public async preview(
    request: AdvisoryTradePreviewRequest,
    signal?: AbortSignal,
  ): Promise<AdvisoryTradePreviewResult> {
    const market = this.marketsBySlug.get(request.marketSlug);
    if (market === undefined) {
      throw new Error(`Market ${request.marketSlug} is not in the catalog`);
    }
    const order: ImmediateOrder = {
      marketId: market.id,
      marketSlug: market.slug,
      side: request.side,
      action: request.action,
      canonicalLimitPrice: request.limitPrice,
      quantity: request.quantity,
    };
    signal?.throwIfAborted();
    const book = await this.exchange.getOrderBook(market.id);
    signal?.throwIfAborted();
    const levels = canonicalBookLevels(book, request.side, request.action);
    const bestPrice = levels[0]?.price;
    const maximumImmediatelyFillableQuantity = totalEligibleQuantity(
      levels,
      request.action,
      request.limitPrice,
    );
    const depth = walkCanonicalBook(
      book,
      request.side,
      request.action,
      request.quantity,
      request.limitPrice,
    );
    const priceImpact =
      bestPrice === undefined || depth.fillableQuantity.isZero()
        ? undefined
        : request.action === "BUY"
          ? depth.vwap.minus(bestPrice)
          : bestPrice.minus(depth.vwap);
    const [feePreview, feeReserveForQuantity] = await Promise.all([
      this.exchange.previewImmediateOrder(order, "ADVISORY"),
      this.exchange.createImmediateOrderFeeReserveEstimator(order),
    ]);
    signal?.throwIfAborted();
    const localFeeReserve = feeReserveForQuantity(request.quantity);
    if (!localFeeReserve.isFinite() || localFeeReserve.lt(0)) {
      throw new Error("Exchange returned an invalid conservative fee reserve");
    }
    const conservativeFeeReserve = Decimal.max(
      localFeeReserve,
      feePreview.estimatedFees,
    );
    const expectedBookSpend =
      request.action === "BUY"
        ? depth.principal.plus(feePreview.estimatedFees)
        : feePreview.estimatedFees;
    const maximumSpendAtLimit =
      request.action === "BUY"
        ? request.quantity.mul(request.limitPrice).plus(conservativeFeeReserve)
        : conservativeFeeReserve;
    const warnings = [...feePreview.warnings];
    if (!depth.fullyFillable) {
      warnings.push(
        "The requested quantity is not fully fillable within the supplied limit price in this book snapshot",
      );
    }
    return {
      readOnly: true,
      authoritativeForExecution: false,
      marketSlug: market.slug,
      side: request.side,
      action: request.action,
      quantity: serializeDecimal(request.quantity),
      limitPrice: serializeDecimal(request.limitPrice),
      bookObservedAt: book.observedAt.toISOString(),
      bookObservationBasis: book.observationBasis ?? "CLIENT_RECEIPT_TIME",
      depth: {
        maximumImmediatelyFillableQuantity: serializeDecimal(
          maximumImmediatelyFillableQuantity,
        ),
        requestedFillableQuantity: serializeDecimal(depth.fillableQuantity),
        fullyFillable: depth.fullyFillable,
        principal: serializeDecimal(depth.principal),
        ...(depth.fillableQuantity.isZero()
          ? {}
          : {
              vwap: serializeDecimal(depth.vwap),
              worstPrice: serializeDecimal(depth.worstPrice),
            }),
        ...(bestPrice === undefined
          ? {}
          : { bestPrice: serializeDecimal(bestPrice) }),
        ...(priceImpact === undefined
          ? {}
          : { priceImpact: serializeDecimal(priceImpact) }),
      },
      feePreview: {
        accepted: feePreview.accepted,
        basis: feePreview.basis ?? "UNSPECIFIED",
        ...(feePreview.observedAt === undefined
          ? {}
          : { observedAt: feePreview.observedAt.toISOString() }),
        estimatedFees: serializeDecimal(feePreview.estimatedFees),
        ...(feePreview.estimatedPrincipal === undefined
          ? {}
          : {
              estimatedPrincipal: serializeDecimal(
                feePreview.estimatedPrincipal,
              ),
            }),
        ...(feePreview.estimatedCollateral === undefined
          ? {}
          : {
              estimatedCollateral: serializeDecimal(
                feePreview.estimatedCollateral,
              ),
            }),
        warnings: feePreview.warnings,
        rejectionReasons: feePreview.rejectionReasons,
        ...(feePreview.rawStatus === undefined
          ? {}
          : { rawStatus: feePreview.rawStatus }),
      },
      costs: {
        expectedBookSpend: serializeDecimal(expectedBookSpend),
        ...(feePreview.basis === "EXCHANGE"
          ? {
              exchangeReportedFees: serializeDecimal(feePreview.estimatedFees),
            }
          : {}),
        conservativeFeeReserve: serializeDecimal(conservativeFeeReserve),
        maximumSpendAtLimit: serializeDecimal(maximumSpendAtLimit),
      },
      warnings,
    };
  }
}
