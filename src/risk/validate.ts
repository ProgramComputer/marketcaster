import { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { DepthResult } from "../domain/execution.js";
import type { Market, MarketBbo, OrderBook } from "../domain/market.js";
import type { ImmediateOrder } from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { OutcomeSide, TradeAction } from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import { canonicalBookLevels, walkCanonicalBook } from "../execution/depth.js";
import {
  alignQuantity,
  ceilToTick,
  floorToTick,
} from "../execution/price-rounding.js";
import type { PortfolioValuation } from "../portfolio/valuation.js";
import {
  allocateBatchBudget,
  type BatchAllocationCandidate,
} from "./batch-allocation.js";
import { concentrationHeadroom } from "./concentration.js";
import {
  calculateLiquidationEdge,
  calculateNetEdge,
  estimateExchangeTakerFee,
  estimateExchangeTakerFeePerContract,
} from "./edge.js";
import { calculateKellyBudget } from "./kelly.js";
import type { RiskPolicy, RiskRejectionCode } from "./policy.js";

export interface ProposalEvidence {
  readonly title: string;
  readonly url: string;
  readonly evidenceClass?:
    "CURRENT_REPORT" | "LIVE_DATA" | "BACKGROUND" | undefined;
  readonly claimExcerpt?: string | undefined;
  readonly claimEventYear?: number | null | undefined;
  readonly publishedAt?: string | undefined;
  readonly asOf?: string | undefined;
  readonly relevance: string;
}

export interface PortfolioTargetExecutionPlan {
  readonly targetCostBasisUsd: Decimal;
  readonly baselineCostBasisUsd: Decimal;
  readonly baselineQuantity: Decimal;
  readonly baselineAvailableQuantity: Decimal;
  readonly baselineOppositeCostBasisUsd: Decimal;
  readonly baselineOppositeQuantity: Decimal;
}

export interface RiskProposal {
  readonly marketSlug: string;
  readonly side: OutcomeSide;
  readonly action: TradeAction;
  readonly estimatedProbability: Decimal;
  /** Adverse probability bound used to haircut and audit a BUY. */
  readonly probabilityLowerBound: Decimal;
  /** Adverse probability bound used to haircut and audit a SELL. */
  readonly probabilityUpperBound: Decimal;
  readonly maximumEntryPrice?: Decimal | undefined;
  readonly minimumExitPrice?: Decimal | undefined;
  readonly maximumRiskUsd: Decimal;
  /**
   * Optional deterministic quantity ceiling supplied by portfolio-target
   * reconciliation. Model-authored proposals omit it. In particular, a SELL
   * target uses this to express an exact trim without overloading the dollar
   * risk field with a price-dependent quantity calculation.
   */
  readonly maximumQuantity?: Decimal;
  /** Cycle-start exposure used to fail closed if the target becomes stale. */
  readonly portfolioTargetPlan?: PortfolioTargetExecutionPlan;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly thesis: string;
  readonly settlementVerification: string;
  readonly invalidationConditions: string;
  readonly evidence: readonly ProposalEvidence[];
}

export interface ValidatedProposal {
  readonly proposal: RiskProposal;
  /** Point estimate blended toward the adverse interval bound by policy. */
  readonly authorizationProbability: Decimal;
  readonly market: Market;
  readonly bbo: MarketBbo;
  readonly book: OrderBook;
  readonly order: ImmediateOrder;
  readonly depth: DepthResult;
  readonly estimatedFees: Decimal;
  readonly expectedSpend: Decimal;
  readonly conservativeFeeReserve: Decimal;
  readonly minimumExecutionSpend: Decimal;
  readonly maximumExecutionSpend: Decimal;
  readonly riskBudget: Decimal;
  readonly netEdge?: Decimal;
}

export interface RejectedProposal {
  readonly proposal: RiskProposal;
  readonly code: RiskRejectionCode;
  readonly reason: string;
}

export interface ProposalValidationResult {
  readonly accepted: readonly ValidatedProposal[];
  readonly rejected: readonly RejectedProposal[];
  readonly committedCycleSpend: Decimal;
}

export interface ValidateProposalsInput {
  readonly proposals: readonly RiskProposal[];
  readonly snapshot: AccountSnapshot;
  readonly valuation: PortfolioValuation;
  readonly exchange: PredictionExchange;
  readonly policy: RiskPolicy;
  readonly knownMarkets?: ReadonlyMap<string, Market>;
  readonly permittedMarketSlugs?: ReadonlySet<string>;
  /**
   * Fresh deterministic selected-side probabilities for markets whose event
   * state can change during a model turn. When a slug is required but absent,
   * validation fails closed instead of treating a favorable price move as new
   * edge against stale event state.
   */
  readonly freshProbabilityByMarketSlug?: ReadonlyMap<string, Decimal>;
  readonly requireFreshProbabilityMarketSlugs?: ReadonlySet<string>;
  readonly now?: Date | (() => Date);
  readonly signal?: AbortSignal;
}

class ProposalRejectedError extends Error {
  public constructor(
    public readonly code: RiskRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

interface AssessedBuyCandidate extends BatchAllocationCandidate {
  readonly proposalIndex: number;
  readonly proposal: RiskProposal;
  readonly authorizationProbability: Decimal;
  readonly market: Market;
  readonly bbo: MarketBbo;
  readonly book: OrderBook;
  readonly limitPrice: Decimal;
  readonly minimumExecutionSpend: Decimal;
  readonly individualRiskBudget: Decimal;
  readonly maximumSized: ReturnType<typeof fitBuyQuantity>;
  readonly feeReserveForQuantity: (quantity: Decimal) => Decimal;
}

interface AssessedBuy {
  readonly kind: "BUY";
  readonly candidate: AssessedBuyCandidate;
}

interface AssessedSell {
  readonly kind: "SELL";
  readonly validated: ValidatedProposal;
}

type AssessedProposal = AssessedBuy | AssessedSell;

interface IndexedRejection {
  readonly proposalIndex: number;
  readonly rejection: RejectedProposal;
}

function reject(code: RiskRejectionCode, reason: string): never {
  throw new ProposalRejectedError(code, reason);
}

function positionFor(
  positions: readonly Position[],
  marketSlug: string,
  side: OutcomeSide,
): Position | undefined {
  return positions.find(
    (position) => position.marketSlug === marketSlug && position.side === side,
  );
}

function countIndependentSources(
  evidence: readonly ProposalEvidence[],
): number {
  const hosts = new Set<string>();
  for (const item of evidence) {
    // Undefined is retained only for bounded legacy fixtures and migrated
    // callers. The live model schema requires an explicit class, while
    // BACKGROUND never satisfies the independent-source gate.
    if (item.evidenceClass === "BACKGROUND") {
      continue;
    }
    try {
      hosts.add(
        new URL(item.url).hostname.toLowerCase().replace(/^www\./u, ""),
      );
    } catch {
      // The decision schema normally prevents this; an invalid URL counts as no source.
    }
  }
  return hosts.size;
}

function validateFreshMarket(
  market: Market,
  bbo: MarketBbo,
  book: OrderBook,
  knownMarket: Market | undefined,
  now: Date,
): void {
  if (!market.active) reject("MARKET_INACTIVE", "Market is no longer active");
  if (market.closed || market.archived) {
    reject("MARKET_CLOSED", "Market is closed or archived");
  }
  if (
    knownMarket !== undefined &&
    (!market.priceTick.eq(knownMarket.priceTick) ||
      !market.minimumTradeQuantity.eq(knownMarket.minimumTradeQuantity))
  ) {
    reject("MARKET_CHANGED", "Tick size or minimum quantity changed");
  }
  if (market.priceTick.lte(0) || market.minimumTradeQuantity.lte(0)) {
    reject("INVALID_MARKET_CONSTRAINTS", "Invalid tick or quantity constraint");
  }
  const checkedAt = now.getTime();
  const bboObservedAt = bbo.observedAt.getTime();
  const bookObservedAt = book.observedAt.getTime();
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(bboObservedAt) ||
    !Number.isFinite(bookObservedAt) ||
    bboObservedAt > checkedAt ||
    bookObservedAt > checkedAt
  ) {
    reject(
      "INVALID_MARKET_CONSTRAINTS",
      "Quote or order-book observation time is invalid",
    );
  }
  const yesBid = bbo.yes.bid;
  const yesAsk = bbo.yes.ask;
  if (yesBid !== undefined && yesAsk !== undefined && yesBid.gt(yesAsk)) {
    reject("CROSSED_BOOK", "YES order book is crossed");
  }

  const bestBookBid = book.yesBids.reduce<Decimal | undefined>(
    (best, level) =>
      best === undefined || level.price.gt(best) ? level.price : best,
    undefined,
  );
  const bestBookAsk = book.yesAsks.reduce<Decimal | undefined>(
    (best, level) =>
      best === undefined || level.price.lt(best) ? level.price : best,
    undefined,
  );
  if (
    bestBookBid !== undefined &&
    bestBookAsk !== undefined &&
    bestBookBid.gt(bestBookAsk)
  ) {
    reject("CROSSED_BOOK", "Fresh full order book is crossed");
  }
}

function validateSideAndAction(
  proposal: RiskProposal,
  positions: readonly Position[],
  acceptedEntrySide: OutcomeSide | undefined,
): Position | undefined {
  const held = positionFor(positions, proposal.marketSlug, proposal.side);
  const opposite = positionFor(
    positions,
    proposal.marketSlug,
    proposal.side === "YES" ? "NO" : "YES",
  );
  if (proposal.action === "SELL") {
    if (held === undefined || held.availableQuantity.lte(0)) {
      reject(
        "NO_POSITION",
        "A SELL must reduce an available position on that side",
      );
    }
    return held;
  }
  if (
    opposite?.quantity.gt(0) === true ||
    (acceptedEntrySide !== undefined && acceptedEntrySide !== proposal.side)
  ) {
    reject(
      "SIDE_MISMATCH",
      "An opposite-side position or accepted entry already exists for this market",
    );
  }
  return held;
}

function canonicalSpread(bbo: MarketBbo, side: OutcomeSide): Decimal {
  const quote = side === "YES" ? bbo.yes : bbo.no;
  if (quote.bid === undefined || quote.ask === undefined) {
    reject("MISSING_QUOTE", `Missing ${side} bid or ask`);
  }
  const spread = quote.ask.minus(quote.bid);
  if (spread.lt(0)) reject("CROSSED_BOOK", `${side} quote is crossed`);
  return spread;
}

export function riskAdjustedProbability(
  proposal: Pick<
    RiskProposal,
    | "action"
    | "estimatedProbability"
    | "probabilityLowerBound"
    | "probabilityUpperBound"
  >,
  uncertaintyBoundWeight: Decimal,
): Decimal {
  const adverseBound =
    proposal.action === "BUY"
      ? proposal.probabilityLowerBound
      : proposal.probabilityUpperBound;
  return proposal.estimatedProbability.plus(
    adverseBound
      .minus(proposal.estimatedProbability)
      .mul(uncertaintyBoundWeight),
  );
}

function automaticPositiveEdgeLimit(
  proposal: RiskProposal,
  market: Market,
  exchangeId: string,
  uncertaintyBoundWeight: Decimal,
): Decimal {
  const tick = market.priceTick;
  const maximumPrice = new Decimal(1).minus(tick);
  const authorizationProbability = riskAdjustedProbability(
    proposal,
    uncertaintyBoundWeight,
  );
  let candidate =
    proposal.action === "BUY"
      ? floorToTick(Decimal.min(authorizationProbability, maximumPrice), tick)
      : ceilToTick(Decimal.max(authorizationProbability, tick), tick);

  while (candidate.gte(tick) && candidate.lte(maximumPrice)) {
    const fee = estimateExchangeTakerFeePerContract(exchangeId, candidate);
    const positive =
      proposal.action === "BUY"
        ? calculateNetEdge(authorizationProbability, candidate, fee).gt(0)
        : candidate.minus(fee).gt(authorizationProbability);
    if (positive) return candidate;
    candidate =
      proposal.action === "BUY" ? candidate.minus(tick) : candidate.plus(tick);
  }

  reject(
    "NON_POSITIVE_EDGE",
    proposal.action === "BUY"
      ? "Policy-adjusted authorization probability leaves no valid tick-aligned immediate entry price after fees"
      : "Policy-adjusted authorization probability leaves no valid tick-aligned immediate exit price after fees",
  );
}

function alignedLimit(
  proposal: RiskProposal,
  market: Market,
  exchangeId: string,
  uncertaintyBoundWeight: Decimal,
): Decimal {
  const raw =
    proposal.action === "BUY"
      ? proposal.maximumEntryPrice
      : proposal.minimumExitPrice;
  if (raw === undefined) {
    return automaticPositiveEdgeLimit(
      proposal,
      market,
      exchangeId,
      uncertaintyBoundWeight,
    );
  }
  const aligned =
    proposal.action === "BUY"
      ? floorToTick(raw, market.priceTick)
      : ceilToTick(raw, market.priceTick);
  const maximumPrice = new Decimal(1).minus(market.priceTick);
  if (aligned.lt(market.priceTick) || aligned.gt(maximumPrice)) {
    reject(
      "INVALID_PRICE",
      `Aligned canonical price is outside ${market.priceTick.toFixed()} through ${maximumPrice.toFixed()}`,
    );
  }
  return aligned;
}

function fitBuyQuantity(
  book: OrderBook,
  proposal: RiskProposal,
  market: Market,
  riskBudget: Decimal,
  limitPrice: Decimal,
  exchangeId: string,
  feeReserveForQuantity: (quantity: Decimal) => Decimal,
): {
  quantity: Decimal;
  depth: DepthResult;
  fees: Decimal;
  conservativeFeeReserve: Decimal;
  maximumExecutionSpend: Decimal;
} {
  const levels = canonicalBookLevels(book, proposal.side, "BUY").filter(
    (level) => level.price.lte(limitPrice),
  );
  const top = levels.at(0);
  if (top === undefined)
    reject("NO_DEPTH", "No ask is available within the entry limit");
  let quantity = alignQuantity(
    riskBudget.div(limitPrice),
    market.minimumTradeQuantity,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (quantity.lt(market.minimumTradeQuantity)) {
      reject(
        "MINIMUM_QUANTITY",
        "Risk budget cannot fund the minimum quantity",
      );
    }
    let depth = walkCanonicalBook(
      book,
      proposal.side,
      "BUY",
      quantity,
      limitPrice,
    );
    if (depth.fillableQuantity.lt(market.minimumTradeQuantity)) {
      reject(
        "NO_DEPTH",
        "Executable depth is below the market minimum quantity",
      );
    }
    if (!depth.fullyFillable) {
      quantity = alignQuantity(
        depth.fillableQuantity,
        market.minimumTradeQuantity,
      );
      depth = walkCanonicalBook(
        book,
        proposal.side,
        "BUY",
        quantity,
        limitPrice,
      );
    }
    const fees = estimateExchangeTakerFee(exchangeId, quantity, depth.vwap);
    const exchangeFeeReserve = feeReserveForQuantity(quantity);
    if (!exchangeFeeReserve.isFinite() || exchangeFeeReserve.lt(0)) {
      reject(
        "INVALID_MARKET_CONSTRAINTS",
        "Exchange returned an invalid conservative fee reserve",
      );
    }
    const conservativeFeeReserve = Decimal.max(fees, exchangeFeeReserve);
    const maximumExecutionSpend = quantity
      .mul(limitPrice)
      .plus(conservativeFeeReserve);
    if (maximumExecutionSpend.lte(riskBudget)) {
      return {
        quantity,
        depth,
        fees,
        conservativeFeeReserve,
        maximumExecutionSpend,
      };
    }
    const resized = alignQuantity(
      quantity.mul(riskBudget).div(maximumExecutionSpend),
      market.minimumTradeQuantity,
    );
    quantity = resized.lt(quantity)
      ? resized
      : quantity.minus(market.minimumTradeQuantity);
  }
  reject(
    "INSUFFICIENT_BUDGET",
    "Could not fit a tick-aligned size to the risk budget",
  );
}

function sizeExit(
  book: OrderBook,
  proposal: RiskProposal,
  market: Market,
  position: Position,
  limitPrice: Decimal,
  exchangeId: string,
): { quantity: Decimal; depth: DepthResult; fees: Decimal } {
  const levels = canonicalBookLevels(book, proposal.side, "SELL").filter(
    (level) => level.price.gte(limitPrice),
  );
  const top = levels.at(0);
  if (top === undefined)
    reject("NO_DEPTH", "No bid is available within the exit limit");
  const requested = Decimal.min(
    position.availableQuantity,
    proposal.maximumRiskUsd.div(top.price),
    proposal.maximumQuantity ?? position.availableQuantity,
  );
  let quantity = alignQuantity(requested, market.minimumTradeQuantity);
  if (quantity.lt(market.minimumTradeQuantity)) {
    reject(
      "MINIMUM_QUANTITY",
      "Exit size is below the market minimum quantity",
    );
  }
  let depth = walkCanonicalBook(
    book,
    proposal.side,
    "SELL",
    quantity,
    limitPrice,
  );
  if (!depth.fullyFillable) {
    quantity = alignQuantity(
      depth.fillableQuantity,
      market.minimumTradeQuantity,
    );
    if (quantity.lt(market.minimumTradeQuantity)) {
      reject(
        "NO_DEPTH",
        "Exit book depth is below the market minimum quantity",
      );
    }
    depth = walkCanonicalBook(
      book,
      proposal.side,
      "SELL",
      quantity,
      limitPrice,
    );
  }
  return {
    quantity,
    depth,
    fees: estimateExchangeTakerFee(exchangeId, quantity, depth.vwap),
  };
}

async function assessOne(
  proposal: RiskProposal,
  proposalIndex: number,
  input: ValidateProposalsInput,
  committedSellFees: Decimal,
  projectedSellPrincipal: Decimal,
  queuedByMarket: ReadonlyMap<string, Decimal>,
  acceptedEntrySide: OutcomeSide | undefined,
  now: () => Date,
): Promise<AssessedProposal> {
  if (!proposal.maximumRiskUsd.isFinite() || proposal.maximumRiskUsd.lte(0)) {
    reject("INVALID_PROPOSAL", "maximumRiskUsd must be positive and finite");
  }
  if (
    proposal.maximumQuantity !== undefined &&
    (!proposal.maximumQuantity.isFinite() || proposal.maximumQuantity.lte(0))
  ) {
    reject("INVALID_PROPOSAL", "maximumQuantity must be positive and finite");
  }
  if (
    input.permittedMarketSlugs !== undefined &&
    !input.permittedMarketSlugs.has(proposal.marketSlug) &&
    !input.snapshot.positions.some(
      (position) => position.marketSlug === proposal.marketSlug,
    )
  ) {
    reject(
      "MARKET_NOT_RESEARCHED",
      "Market details must be inspected before proposing a trade",
    );
  }
  let market: Market;
  try {
    market = await input.exchange.getMarketBySlug(proposal.marketSlug);
  } catch {
    reject("MARKET_NOT_FOUND", `Market '${proposal.marketSlug}' was not found`);
  }
  const [bbo, book] = await Promise.all([
    input.exchange.getBbo(market.id),
    input.exchange.getOrderBook(market.id),
  ]);
  input.signal?.throwIfAborted();
  validateFreshMarket(
    market,
    bbo,
    book,
    input.knownMarkets?.get(proposal.marketSlug),
    now(),
  );
  const spread = canonicalSpread(bbo, proposal.side);
  if (
    spread.gt(input.policy.maximumExecutionSpread) &&
    !(proposal.action === "SELL" && input.policy.emergencyExitEnabled)
  ) {
    reject(
      "SPREAD_TOO_WIDE",
      `Execution spread ${spread.toFixed()} exceeds policy`,
    );
  }

  const position = validateSideAndAction(
    proposal,
    input.snapshot.positions,
    acceptedEntrySide,
  );
  const authorizationProbability = riskAdjustedProbability(
    proposal,
    input.policy.uncertaintyBoundWeight,
  );
  const authorizedLimitPrice = alignedLimit(
    proposal,
    market,
    input.exchange.id,
    input.policy.uncertaintyBoundWeight,
  );
  const remainingCycleSpend = Decimal.max(
    0,
    input.valuation.riskEquity
      .mul(input.policy.maximumCycleSpendFraction)
      .minus(committedSellFees),
  );
  const independentSourceCount = countIndependentSources(proposal.evidence);
  if (
    proposal.action === "BUY" &&
    independentSourceCount < input.policy.minimumIndependentSources
  ) {
    reject(
      "INSUFFICIENT_SOURCES",
      `Entry has ${independentSourceCount} independent source domain(s); policy requires ${input.policy.minimumIndependentSources}`,
    );
  }

  if (proposal.action === "SELL") {
    if (position === undefined)
      reject("NO_POSITION", "No reducible position exists");
    const sized = sizeExit(
      book,
      proposal,
      market,
      position,
      authorizedLimitPrice,
      input.exchange.id,
    );
    const feePerContract = sized.fees.div(sized.quantity);
    const netEdge = calculateLiquidationEdge(
      authorizationProbability,
      sized.depth.vwap,
      feePerContract,
    );
    if (netEdge.lte(0) && !input.policy.emergencyExitEnabled) {
      reject(
        "NON_POSITIVE_EDGE",
        `Liquidation proceeds do not exceed the policy-adjusted authorization probability after fees; net exit edge is ${netEdge.toFixed()}`,
      );
    }
    if (sized.fees.gt(remainingCycleSpend)) {
      reject(
        "CYCLE_SPEND",
        "Expected fees exceed remaining cycle spend headroom",
      );
    }
    return {
      kind: "SELL",
      validated: {
        proposal,
        authorizationProbability,
        market,
        bbo,
        book,
        order: {
          marketId: market.id,
          marketSlug: market.slug,
          side: proposal.side,
          action: "SELL",
          canonicalLimitPrice: authorizedLimitPrice,
          quantity: sized.quantity,
        },
        depth: sized.depth,
        estimatedFees: sized.fees,
        expectedSpend: sized.fees,
        conservativeFeeReserve: sized.fees,
        minimumExecutionSpend: sized.fees,
        maximumExecutionSpend: sized.fees,
        riskBudget: proposal.maximumRiskUsd,
        netEdge,
      },
    };
  }

  const quote = proposal.side === "YES" ? bbo.yes : bbo.no;
  if (quote.ask === undefined || quote.ask.gt(authorizedLimitPrice)) {
    reject(
      "PRICE_LIMIT_EXCEEDED",
      "Fresh executable ask is above the entry limit",
    );
  }
  const topFee = estimateExchangeTakerFeePerContract(
    input.exchange.id,
    quote.ask,
  );
  const netEdgeAtTop = calculateNetEdge(
    authorizationProbability,
    quote.ask,
    topFee,
  );
  if (netEdgeAtTop.lte(0)) {
    reject(
      "NON_POSITIVE_EDGE",
      `Net edge ${netEdgeAtTop.toFixed()} is not positive after fees`,
    );
  }

  const riskEquity = input.valuation.riskEquity;
  if (riskEquity.lte(0))
    reject("INSUFFICIENT_BUDGET", "Risk equity is not positive");
  const existingCostBasis = position?.costBasis ?? new Decimal(0);
  const queued = queuedByMarket.get(market.slug) ?? new Decimal(0);
  const headroom = concentrationHeadroom(
    riskEquity,
    input.policy.maximumPositionCostBasisFraction,
    existingCostBasis,
    queued,
  );
  const remainingBuyingPower = Decimal.max(
    0,
    input.snapshot.buyingPower
      .plus(projectedSellPrincipal)
      .minus(committedSellFees),
  );
  if (headroom.lte(0)) {
    reject(
      "CONCENTRATION",
      `Position concentration headroom is exhausted at existing cost basis ${existingCostBasis.toFixed(4)} plus queued spend ${queued.toFixed(4)}`,
    );
  }
  if (remainingBuyingPower.lte(0)) {
    reject("BUYING_POWER", "Buying-power headroom is exhausted");
  }
  if (remainingCycleSpend.lte(0)) {
    reject("CYCLE_SPEND", "Cycle spend headroom is exhausted");
  }
  // Give a fast IOC two ticks of quote-movement tolerance. The limit remains a
  // worst-case spend and positive-edge guard; Kelly sizing uses executable book
  // prices so a slippage cushion does not masquerade as the expected entry.
  const limitPrice = Decimal.min(
    authorizedLimitPrice,
    quote.ask.plus(market.priceTick.mul(2)),
  );
  const minimumOrder: ImmediateOrder = {
    marketId: market.id,
    marketSlug: market.slug,
    side: proposal.side,
    action: "BUY",
    canonicalLimitPrice: limitPrice,
    quantity: market.minimumTradeQuantity,
  };
  const feeReserveForQuantity =
    await input.exchange.createImmediateOrderFeeReserveEstimator(minimumOrder);
  const minimumFeeReserve = feeReserveForQuantity(market.minimumTradeQuantity);
  if (!minimumFeeReserve.isFinite() || minimumFeeReserve.lt(0)) {
    reject(
      "INVALID_MARKET_CONSTRAINTS",
      "Exchange returned an invalid conservative fee reserve",
    );
  }
  const minimumEstimatedFee = estimateExchangeTakerFee(
    input.exchange.id,
    market.minimumTradeQuantity,
    limitPrice,
  );
  const minimumConservativeFeeReserve = Decimal.max(
    minimumFeeReserve,
    minimumEstimatedFee,
  );
  const minimumFeePerContract = minimumConservativeFeeReserve.div(
    market.minimumTradeQuantity,
  );
  const conservativeLimitEdge = calculateNetEdge(
    authorizationProbability,
    limitPrice,
    minimumFeePerContract,
  );
  if (conservativeLimitEdge.lte(0)) {
    reject(
      "NON_POSITIVE_EDGE",
      `Limit-price net edge ${conservativeLimitEdge.toFixed()} is not positive after conservative fees`,
    );
  }
  const kellyBudget = calculateKellyBudget(
    authorizationProbability,
    quote.ask.plus(minimumFeePerContract),
    riskEquity,
    input.policy.kellyFraction,
  );
  const kellyHeadroom = Decimal.max(
    0,
    kellyBudget.minus(existingCostBasis).minus(queued),
  );
  if (kellyHeadroom.lte(0)) {
    reject(
      "INSUFFICIENT_BUDGET",
      `Absolute Kelly budget ${kellyBudget.toFixed(4)} is fully consumed by existing cost basis ${existingCostBasis.toFixed(4)} and queued spend ${queued.toFixed(4)}; do not add to this position unless fresh evidence supports a materially different probability or entry price`,
    );
  }
  let individualRiskBudget = Decimal.min(
    proposal.maximumRiskUsd,
    kellyHeadroom,
    headroom,
    remainingBuyingPower,
    remainingCycleSpend,
  );
  if (individualRiskBudget.lte(0)) {
    reject(
      "INSUFFICIENT_BUDGET",
      "The target's requested incremental risk budget is exhausted",
    );
  }
  const minimumExecutionSpend = market.minimumTradeQuantity
    .mul(limitPrice)
    .plus(minimumConservativeFeeReserve);
  let maximumSized = fitBuyQuantity(
    book,
    proposal,
    market,
    individualRiskBudget,
    limitPrice,
    input.exchange.id,
    feeReserveForQuantity,
  );
  // Some exchange fee estimators are quantity-sensitive. Recompute absolute
  // Kelly headroom at the actual conservative per-contract fee and shrink
  // until the worst-price spend fits. This never increases a candidate.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sizedFeePerContract = maximumSized.conservativeFeeReserve.div(
      maximumSized.quantity,
    );
    const sizedKellyBudget = calculateKellyBudget(
      authorizationProbability,
      maximumSized.depth.vwap.plus(sizedFeePerContract),
      riskEquity,
      input.policy.kellyFraction,
    );
    const sizedKellyHeadroom = Decimal.max(
      0,
      sizedKellyBudget.minus(existingCostBasis).minus(queued),
    );
    if (maximumSized.maximumExecutionSpend.lte(sizedKellyHeadroom)) break;
    individualRiskBudget = Decimal.min(
      individualRiskBudget,
      sizedKellyHeadroom,
    );
    if (individualRiskBudget.lte(0)) {
      reject(
        "INSUFFICIENT_BUDGET",
        "Absolute Kelly headroom is exhausted at the executable depth price",
      );
    }
    maximumSized = fitBuyQuantity(
      book,
      proposal,
      market,
      individualRiskBudget,
      limitPrice,
      input.exchange.id,
      feeReserveForQuantity,
    );
  }
  const feePerContract = maximumSized.conservativeFeeReserve.div(
    maximumSized.quantity,
  );
  const finalKellyHeadroom = Decimal.max(
    0,
    calculateKellyBudget(
      authorizationProbability,
      maximumSized.depth.vwap.plus(feePerContract),
      riskEquity,
      input.policy.kellyFraction,
    )
      .minus(existingCostBasis)
      .minus(queued),
  );
  if (maximumSized.maximumExecutionSpend.gt(finalKellyHeadroom)) {
    reject(
      "INSUFFICIENT_BUDGET",
      "Could not fit a stable quantity within absolute Kelly headroom",
    );
  }
  const netEdge = calculateNetEdge(
    authorizationProbability,
    maximumSized.depth.vwap,
    feePerContract,
  );
  if (netEdge.lte(0)) {
    reject(
      "NON_POSITIVE_EDGE",
      `Limit-price net edge ${netEdge.toFixed()} is not positive after conservative fees`,
    );
  }
  if (maximumSized.maximumExecutionSpend.gt(headroom)) {
    reject(
      "CONCENTRATION",
      "Maximum execution spend exceeds concentration headroom",
    );
  }

  return {
    kind: "BUY",
    candidate: {
      id: `${market.slug}:${proposal.side}:${proposalIndex}`,
      conservativeNetEdge: netEdge,
      minimumSpend: minimumExecutionSpend,
      maximumSpend: maximumSized.maximumExecutionSpend,
      proposalIndex,
      proposal,
      authorizationProbability,
      market,
      bbo,
      book,
      limitPrice,
      minimumExecutionSpend,
      individualRiskBudget,
      maximumSized,
      feeReserveForQuantity,
    },
  };
}

function finalizeBuy(
  candidate: AssessedBuyCandidate,
  allocatedSpend: Decimal,
): ValidatedProposal {
  const usesMaximumSize = allocatedSpend.eq(candidate.maximumSpend);
  const sized = usesMaximumSize
    ? candidate.maximumSized
    : fitBuyQuantity(
        candidate.book,
        candidate.proposal,
        candidate.market,
        allocatedSpend,
        candidate.limitPrice,
        candidate.market.id.exchange,
        candidate.feeReserveForQuantity,
      );
  const feePerContract = sized.conservativeFeeReserve.div(sized.quantity);
  const netEdge = calculateNetEdge(
    candidate.authorizationProbability,
    sized.depth.vwap,
    feePerContract,
  );
  if (netEdge.lte(0)) {
    reject(
      "NON_POSITIVE_EDGE",
      `Executable-depth net edge ${netEdge.toFixed()} is not positive after conservative fees`,
    );
  }
  if (sized.maximumExecutionSpend.gt(allocatedSpend)) {
    throw new Error("Batch-sized proposal exceeds its allocated spend");
  }

  return {
    proposal: candidate.proposal,
    authorizationProbability: candidate.authorizationProbability,
    market: candidate.market,
    bbo: candidate.bbo,
    book: candidate.book,
    order: {
      marketId: candidate.market.id,
      marketSlug: candidate.market.slug,
      side: candidate.proposal.side,
      action: "BUY",
      canonicalLimitPrice: candidate.limitPrice,
      quantity: sized.quantity,
    },
    depth: sized.depth,
    estimatedFees: sized.fees,
    expectedSpend: sized.depth.principal.plus(sized.fees),
    conservativeFeeReserve: sized.conservativeFeeReserve,
    minimumExecutionSpend: candidate.minimumExecutionSpend,
    maximumExecutionSpend: sized.maximumExecutionSpend,
    riskBudget: usesMaximumSize
      ? candidate.individualRiskBudget
      : allocatedSpend,
    netEdge,
  };
}

function rejectionFromError(
  proposal: RiskProposal,
  error: unknown,
): RejectedProposal {
  if (error instanceof ProposalRejectedError) {
    return { proposal, code: error.code, reason: error.message };
  }
  return {
    proposal,
    code: "EXCHANGE_ERROR",
    reason: error instanceof Error ? error.message : "Unknown exchange error",
  };
}

export async function validateProposals(
  input: ValidateProposalsInput,
): Promise<ProposalValidationResult> {
  const acceptedSells: ValidatedProposal[] = [];
  const buyCandidates: AssessedBuyCandidate[] = [];
  const indexedRejections: IndexedRejection[] = [];
  const queuedByMarket = new Map<string, Decimal>();
  const acceptedEntrySideByMarket = new Map<string, OutcomeSide>();
  let committedSellFees = new Decimal(0);
  let projectedSellPrincipal = new Decimal(0);
  const configuredNow = input.now;
  const now =
    typeof configuredNow === "function"
      ? configuredNow
      : configuredNow === undefined
        ? () => new Date()
        : () => configuredNow;

  // Assess exits first regardless of model declaration order. The executor
  // likewise places all accepted SELLs before BUYs, so a later entry may be
  // sized against conservative same-cycle sale proceeds. Execution still
  // reconstructs the account after every mutation and skips a BUY when an
  // expected exit did not actually release enough buying power.
  const indexedProposals = input.proposals
    .map((proposal, proposalIndex) => ({ proposal, proposalIndex }))
    .sort((left, right) => {
      if (left.proposal.action !== right.proposal.action) {
        return left.proposal.action === "SELL" ? -1 : 1;
      }
      return left.proposalIndex - right.proposalIndex;
    });

  for (const {
    proposalIndex,
    proposal: submittedProposal,
  } of indexedProposals) {
    input.signal?.throwIfAborted();
    const freshProbability = input.freshProbabilityByMarketSlug?.get(
      submittedProposal.marketSlug,
    );
    if (
      input.requireFreshProbabilityMarketSlugs?.has(
        submittedProposal.marketSlug,
      ) === true &&
      freshProbability === undefined
    ) {
      indexedRejections.push({
        proposalIndex,
        rejection: {
          proposal: submittedProposal,
          code: "MARKET_CHANGED",
          reason:
            "Fresh official live event state was unavailable at validation; the model probability may be stale",
        },
      });
      continue;
    }
    const proposal =
      freshProbability === undefined
        ? submittedProposal
        : {
            ...submittedProposal,
            estimatedProbability: freshProbability,
            probabilityLowerBound: freshProbability,
            probabilityUpperBound: freshProbability,
          };
    try {
      const assessed = await assessOne(
        proposal,
        proposalIndex,
        input,
        committedSellFees,
        projectedSellPrincipal,
        queuedByMarket,
        acceptedEntrySideByMarket.get(proposal.marketSlug),
        now,
      );
      if (assessed.kind === "SELL") {
        acceptedSells.push(assessed.validated);
        committedSellFees = committedSellFees.plus(
          assessed.validated.maximumExecutionSpend,
        );
        projectedSellPrincipal = projectedSellPrincipal.plus(
          assessed.validated.order.quantity.mul(
            assessed.validated.order.canonicalLimitPrice,
          ),
        );
      } else {
        const { candidate } = assessed;
        buyCandidates.push(candidate);
        acceptedEntrySideByMarket.set(proposal.marketSlug, proposal.side);
        queuedByMarket.set(
          proposal.marketSlug,
          (queuedByMarket.get(proposal.marketSlug) ?? new Decimal(0)).plus(
            candidate.maximumSized.maximumExecutionSpend,
          ),
        );
      }
    } catch (error) {
      indexedRejections.push({
        proposalIndex,
        rejection: rejectionFromError(proposal, error),
      });
    }
  }

  const cycleSpendHeadroom = Decimal.max(
    0,
    input.valuation.riskEquity
      .mul(input.policy.maximumCycleSpendFraction)
      .minus(committedSellFees),
  );
  const buyingPowerHeadroom = Decimal.max(
    0,
    input.snapshot.buyingPower
      .plus(projectedSellPrincipal)
      .minus(committedSellFees),
  );
  const batch = allocateBatchBudget({
    cycleBudget: Decimal.min(cycleSpendHeadroom, buyingPowerHeadroom),
    candidates: buyCandidates,
  });
  for (const unfunded of batch.unfunded) {
    indexedRejections.push({
      proposalIndex: unfunded.candidate.proposalIndex,
      rejection: {
        proposal: unfunded.candidate.proposal,
        code: "CYCLE_SPEND",
        reason: "Batch cycle spend cannot fund the minimum quantity",
      },
    });
  }

  const acceptedBuys: ValidatedProposal[] = [];
  for (const allocation of batch.allocations) {
    input.signal?.throwIfAborted();
    try {
      acceptedBuys.push(
        finalizeBuy(allocation.candidate, allocation.allocatedSpend),
      );
    } catch (error) {
      indexedRejections.push({
        proposalIndex: allocation.candidate.proposalIndex,
        rejection: rejectionFromError(allocation.candidate.proposal, error),
      });
    }
  }

  indexedRejections.sort(
    (left, right) => left.proposalIndex - right.proposalIndex,
  );
  const accepted = [...acceptedSells, ...acceptedBuys];
  const committedCycleSpend = accepted.reduce(
    (total, validated) => total.plus(validated.maximumExecutionSpend),
    new Decimal(0),
  );
  return {
    accepted,
    rejected: indexedRejections.map(({ rejection }) => rejection),
    committedCycleSpend,
  };
}
