import { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { ExecutionResult } from "../domain/execution.js";
import type { ExchangeOrder, ImmediateOrder } from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import { reconstructAccount } from "../portfolio/reconstruct.js";
import { matchesSubmittedOrder } from "./reconcile.js";

const ACTIVE = new Set(["NEW", "OPEN", "INFLIGHT", "PARTIALLY_FILLED"]);
const TERMINAL = new Set([
  "FILLED",
  "CLEARED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
]);
// Arithmetic tolerance only; exchange price rounding is checked separately.
const PRECISION = new Decimal("0.00000001");
const equal = (a: Decimal, b: Decimal): boolean =>
  a.minus(b).abs().lte(PRECISION);
const MAXIMUM_PRINCIPAL_TOTALS = 4_096;
// Polymarket US may round the fee it adds to position cost differently from
// the fee reported on the order; observed differences are under a tenth of a
// cent. A cost that includes the fee therefore fixes the principal to a cent.
const FEE_IN_COST_ROUNDING = new Decimal("0.01");

/** A principal the position cost change allows, within `slack`. */
interface PrincipalChoice {
  readonly principal: Decimal;
  readonly slack: Decimal;
}

interface SubmittedBuy {
  readonly order: ImmediateOrder;
  readonly orderId: string;
  readonly reservedSpend: Decimal;
  readonly priceTick: Decimal;
}

export interface ManagedBuyCheck {
  readonly account: AccountSnapshot;
  readonly orders: readonly ExchangeOrder[];
}

export class ManagedBuyStateError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedBuyStateError";
  }
}

function fail(message: string): never {
  throw new ManagedBuyStateError(message);
}

function key(position: { marketSlug: string; side: string }): string {
  return `${position.marketSlug}:${position.side}`;
}

function sameOrder(a: ExchangeOrder, b: ExchangeOrder): boolean {
  return (
    a.id === b.id &&
    a.state === b.state &&
    a.filledQuantity.eq(b.filledQuantity) &&
    a.remainingQuantity?.toFixed() === b.remainingQuantity?.toFixed() &&
    a.averageFillPrice?.toFixed() === b.averageFillPrice?.toFixed() &&
    a.fees?.toFixed() === b.fees?.toFixed() &&
    a.canonicalPrice.eq(b.canonicalPrice) &&
    a.quantity.eq(b.quantity) &&
    a.marketId.exchange === b.marketId.exchange &&
    a.marketId.value === b.marketId.value &&
    a.marketSlug === b.marketSlug &&
    a.side === b.side &&
    a.action === b.action &&
    a.executionPolicy === b.executionPolicy &&
    a.restUntil?.getTime() === b.restUntil?.getTime()
  );
}

/** Orders the batch can track: current-cycle Polymarket US GTD BUYs. */
export function isManagedBuyOrder(order: ImmediateOrder): boolean {
  return (
    order.action === "BUY" &&
    order.executionPolicy === "GTD" &&
    order.marketId.exchange === "polymarket-us"
  );
}

/** Whether a principal choice fits this order's fill and reservation. */
function fitsFill(
  { principal, slack }: PrincipalChoice,
  order: ExchangeOrder,
  buy: SubmittedBuy,
): boolean {
  const unfilled = buy.order.quantity
    .minus(order.filledQuantity)
    .mul(buy.order.canonicalLimitPrice);
  return (
    principal.isFinite() &&
    principal.gte(0) &&
    principal
      .minus(slack)
      .lte(order.filledQuantity.mul(buy.order.canonicalLimitPrice)) &&
    principal
      .minus(slack)
      .plus(order.fees ?? 0)
      .plus(unfilled)
      .lte(buy.reservedSpend) &&
    (order.filledQuantity.eq(0) ||
      principal
        .div(order.filledQuantity)
        .minus(order.averageFillPrice ?? 0)
        .abs()
        .lte(
          buy.priceTick
            .div(2)
            .plus(slack.div(order.filledQuantity))
            .plus(PRECISION),
        ))
  );
}

/** Every total of one principal choice per order, bounded. */
function principalTotals(
  choices: readonly (readonly PrincipalChoice[])[],
): readonly PrincipalChoice[] {
  let totals: PrincipalChoice[] = [
    { principal: new Decimal(0), slack: new Decimal(0) },
  ];
  for (const options of choices) {
    const next = new Map<string, PrincipalChoice>();
    for (const total of totals)
      for (const option of options) {
        const sum = {
          principal: total.principal.plus(option.principal),
          slack: total.slack.plus(option.slack),
        };
        next.set(`${sum.principal.toFixed()}:${sum.slack.toFixed()}`, sum);
      }
    if (next.size > MAXIMUM_PRINCIPAL_TOTALS)
      fail("Managed BUY cost reconciliation has too many fee interpretations");
    totals = [...next.values()];
  }
  return totals;
}

export function managedBuyResult(order: ExchangeOrder): ExecutionResult {
  const working = ACTIVE.has(order.state);
  return {
    orderId: order.id,
    status: working
      ? "WORKING"
      : order.filledQuantity.eq(order.quantity)
        ? "FILLED"
        : order.filledQuantity.gt(0)
          ? "PARTIAL"
          : "NO_FILL",
    filledQuantity: order.filledQuantity,
    remainingQuantity: working
      ? order.quantity.minus(order.filledQuantity)
      : new Decimal(0),
    fees: order.fees ?? new Decimal(0),
    finalState: order.state,
    ...(order.averageFillPrice === undefined
      ? {}
      : { averageFillPrice: order.averageFillPrice }),
  };
}

/** Current-cycle Polymarket US GTD buys only; never adopts existing orders. */
export class ManagedBuyBatch {
  private readonly buys: SubmittedBuy[] = [];
  private readonly lastFilled = new Map<string, Decimal>();

  public constructor(private readonly baseline: AccountSnapshot) {}

  public hasMarket(marketSlug: string): boolean {
    return this.buys.some((buy) => buy.order.marketSlug === marketSlug);
  }

  public register(
    order: ImmediateOrder,
    orderId: string | undefined,
    reservedSpend: Decimal,
    priceTick: Decimal,
    filledQuantity: Decimal,
  ): void {
    if (
      orderId === undefined ||
      this.buys.some((buy) => buy.orderId === orderId)
    ) {
      fail("Managed BUY submission has a missing or duplicate order ID");
    }
    if (!isManagedBuyOrder(order) || this.hasMarket(order.marketSlug)) {
      fail(
        "Managed BUY continuation requires independent current-cycle markets",
      );
    }
    if (
      !priceTick.isFinite() ||
      priceTick.lte(0) ||
      !filledQuantity.isFinite() ||
      filledQuantity.lt(0) ||
      filledQuantity.gt(order.quantity)
    ) {
      fail("Managed BUY has invalid price precision or fill quantity");
    }
    this.buys.push({ order: { ...order }, orderId, reservedSpend, priceTick });
    this.lastFilled.set(orderId, filledQuantity);
  }

  public availableBuyingPower(snapshot: AccountSnapshot): Decimal {
    // Do not add back NO sale proceeds or release the unfilled reservation.
    // Exchange buying power may already lock resting collateral: use min,
    // rather than subtracting our reservation from that value a second time.
    const reserved = this.buys.reduce(
      (sum, buy) => sum.plus(buy.reservedSpend),
      new Decimal(0),
    );
    return Decimal.max(
      0,
      Decimal.min(
        snapshot.buyingPower,
        this.baseline.buyingPower.minus(reserved),
      ),
    );
  }

  private verifyOrder(buy: SubmittedBuy, reported: ExchangeOrder): void {
    const filled = reported.filledQuantity;
    const remaining = reported.remainingQuantity;
    const active = ACTIVE.has(reported.state);
    if (
      reported.id !== buy.orderId ||
      !matchesSubmittedOrder(reported, buy.order) ||
      (!active && !TERMINAL.has(reported.state)) ||
      !filled.isFinite() ||
      filled.lt(this.lastFilled.get(buy.orderId) ?? 0) ||
      filled.gt(buy.order.quantity) ||
      (active &&
        (filled.gte(buy.order.quantity) ||
          remaining?.eq(buy.order.quantity.minus(filled)) !== true)) ||
      (!active && remaining?.eq(0) === false) ||
      (["FILLED", "CLEARED"].includes(reported.state) &&
        !filled.eq(buy.order.quantity))
    ) {
      fail(
        "Managed BUY order identity, state, or quantities could not be verified",
      );
    }
    if (
      filled.gt(0) &&
      (reported.averageFillPrice === undefined || reported.fees === undefined)
    ) {
      fail("Managed BUY fill is missing authoritative price or fees");
    }
    const price = reported.averageFillPrice ?? new Decimal(0);
    const fees = reported.fees ?? new Decimal(0);
    if (
      !price.isFinite() ||
      price.lt(0) ||
      price.gt(buy.order.canonicalLimitPrice) ||
      !fees.isFinite() ||
      fees.lt(0) ||
      filled
        .mul(price)
        .plus(fees)
        .plus(
          buy.order.quantity.minus(filled).mul(buy.order.canonicalLimitPrice),
        )
        .gt(buy.reservedSpend)
    ) {
      fail("Managed BUY fill exceeds its reserved cost or limit");
    }
  }

  private verifyAccount(
    account: AccountSnapshot,
    orders: readonly ExchangeOrder[],
  ): void {
    const expected = new Map<string, Position>();
    for (const position of this.baseline.positions) {
      if (expected.has(key(position))) fail("Duplicate baseline position");
      expected.set(key(position), position);
    }
    let expectedCash = this.baseline.currentBalance;
    const principalChoices: PrincipalChoice[][] = [];
    for (const order of orders) {
      const opposite = expected.get(
        key({ ...order, side: order.side === "YES" ? "NO" : "YES" }),
      );
      if (opposite?.quantity.gt(0))
        fail("Managed BUY would net an opposite position");
      const buy = this.buys.find((entry) => entry.orderId === order.id);
      if (buy === undefined) fail("Untracked BUY in account reconciliation");
      const old = expected.get(key(order));
      const actual = account.positions.find(
        (position) => key(position) === key(order),
      );
      // Order averages can be rounded to the exchange's price tick. Position
      // cost basis retains the actual principal, including mixed-price fills.
      // Polymarket US debits a fill's fee from cash when it executes but may
      // add it to the position's cost a moment later, so the cost change is
      // the principal alone or the principal plus this order's reported fee.
      const costChange = (actual?.costBasis ?? new Decimal(0)).minus(
        old?.costBasis ?? 0,
      );
      const fees = order.fees ?? new Decimal(0);
      const exact = { principal: costChange, slack: new Decimal(0) };
      const principals = (
        fees.isZero()
          ? [exact]
          : [
              exact,
              {
                principal: costChange.minus(fees),
                slack: FEE_IN_COST_ROUNDING,
              },
            ]
      ).filter((choice) => fitsFill(choice, order, buy));
      if (principals.length === 0) {
        fail(
          "Position cost does not match the verified BUY fill and reservation",
        );
      }
      principalChoices.push(principals);
      // Polymarket US represents BUY NO as selling YES against $1 collateral.
      expectedCash = expectedCash
        .plus(order.side === "NO" ? order.filledQuantity : 0)
        .minus(fees);
      if (order.filledQuantity.eq(0)) continue;
      expected.set(key(order), {
        ...(old ?? {
          marketId: order.marketId,
          marketSlug: order.marketSlug,
          side: order.side,
          realizedPnl: new Decimal(0),
          expired: false,
        }),
        quantity: (old?.quantity ?? new Decimal(0)).plus(order.filledQuantity),
        availableQuantity: (old?.availableQuantity ?? new Decimal(0)).plus(
          order.filledQuantity,
        ),
        costBasis: (old?.costBasis ?? new Decimal(0)).plus(costChange),
      });
    }
    // Cash already reflects every fee, so it decides between the principals
    // when a fee is too small to tell them apart by fill price.
    const cashSpentOnPrincipal = expectedCash.minus(account.currentBalance);
    if (
      !principalTotals(principalChoices).some(({ principal, slack }) =>
        cashSpentOnPrincipal.minus(principal).abs().lte(slack.plus(PRECISION)),
      )
    )
      fail("Account capital changed beyond verified current-cycle BUY fills");
    if (account.positions.length !== expected.size)
      fail("Account positions changed beyond verified current-cycle BUY fills");
    const seen = new Set<string>();
    for (const actual of account.positions) {
      const wanted = expected.get(key(actual));
      if (
        wanted === undefined ||
        seen.has(key(actual)) ||
        actual.marketId.exchange !== wanted.marketId.exchange ||
        actual.marketId.value !== wanted.marketId.value ||
        !equal(actual.quantity, wanted.quantity) ||
        !equal(actual.availableQuantity, wanted.availableQuantity) ||
        !equal(actual.costBasis, wanted.costBasis) ||
        !equal(actual.realizedPnl, wanted.realizedPnl) ||
        actual.expired !== wanted.expired
      ) {
        fail(
          "Account positions changed beyond verified current-cycle BUY fills",
        );
      }
      seen.add(key(actual));
    }
    const active = orders.filter((order) => ACTIVE.has(order.state));
    if (
      account.openOrders.length !== active.length ||
      new Set(account.openOrders.map((order) => order.id)).size !==
        active.length ||
      account.openOrders.some(
        (order) => !active.some((known) => sameOrder(order, known)),
      )
    ) {
      fail(
        "Unknown or inconsistent open order during managed BUY continuation",
      );
    }
  }

  public async reconcile(
    exchange: PredictionExchange,
    signal?: AbortSignal,
  ): Promise<ManagedBuyCheck> {
    let lastError: unknown;
    for (const delay of [0, 150, 350]) {
      signal?.throwIfAborted();
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      try {
        // Sandwich the non-atomic account read with exact-order reads. If a
        // fill races any read, retry reads only; never resubmit a mutation.
        const before = await Promise.all(
          this.buys.map((buy) => exchange.getOrder(buy.orderId)),
        );
        const account = await reconstructAccount(exchange);
        const orders = await Promise.all(
          this.buys.map((buy) => exchange.getOrder(buy.orderId)),
        );
        signal?.throwIfAborted();
        for (const [index, buy] of this.buys.entries()) {
          const first = before[index];
          const last = orders[index];
          if (first === undefined || last === undefined)
            fail("Missing managed BUY order");
          this.verifyOrder(buy, last);
          if (!sameOrder(first, last))
            fail("Managed BUY filled during account reconstruction");
        }
        this.verifyAccount(account, orders);
        for (const order of orders)
          this.lastFilled.set(order.id, order.filledQuantity);
        return { account, orders };
      } catch (error) {
        lastError = error;
      }
    }
    signal?.throwIfAborted();
    throw new ManagedBuyStateError(
      lastError instanceof Error
        ? lastError.message
        : "Managed BUY state could not be reconciled",
      { cause: lastError },
    );
  }
}
