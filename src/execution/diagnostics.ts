import type { AccountSnapshot } from "../domain/account.js";
import type { ExchangeOrder } from "../domain/order.js";
import type { Position } from "../domain/position.js";

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue };

/** Review evidence only. These observers never authorize or journal an order. */
export interface ExecutionDiagnostic {
  readonly kind:
    "PORTFOLIO_PRECHECK" | "POST_FILL_ACCOUNT" | "BUY_RECONCILIATION";
  readonly observedAt: string;
  readonly verdict: "PASSED" | "SKIPPED" | "OBSERVED" | "RETRY" | "FAILED";
  readonly proposalIndex?: number;
  readonly intentId?: string;
  readonly marketSlug?: string;
  readonly reason?: string;
  readonly data: Readonly<Record<string, DiagnosticValue>>;
}

export type ExecutionDiagnosticObserver = (
  event: ExecutionDiagnostic,
) => void | Promise<void>;

export function emitExecutionDiagnostic(
  observer: ExecutionDiagnosticObserver | undefined,
  event: () => ExecutionDiagnostic,
): Promise<void> {
  if (observer === undefined) return Promise.resolve();
  try {
    // A review sink may stall or reject. Execution never waits for that sink.
    void Promise.resolve(observer(event())).catch(() => undefined);
  } catch {
    // Optional review output must never alter submission or mandatory journals.
  }
  return Promise.resolve();
}

export function diagnosticPositions(
  positions: readonly Position[],
): readonly DiagnosticValue[] {
  return positions.map((position) => ({
    marketSlug: position.marketSlug,
    side: position.side,
    exchange: position.marketId.exchange,
    marketId: position.marketId.value,
    quantity: position.quantity.toFixed(),
    availableQuantity: position.availableQuantity.toFixed(),
    costBasis: position.costBasis.toFixed(),
    realizedPnl: position.realizedPnl.toFixed(),
    expired: position.expired,
    updatedAt: position.updatedAt?.toISOString() ?? null,
  }));
}

export function diagnosticAccount(account: AccountSnapshot): DiagnosticValue {
  return {
    observedAt: account.observedAt.toISOString(),
    currentBalance: account.currentBalance.toFixed(),
    buyingPower: account.buyingPower.toFixed(),
    assetNotional: account.assetNotional.toFixed(),
    assetAvailable: account.assetAvailable.toFixed(),
    unsettledFunds: account.unsettledFunds.toFixed(),
    marginRequirement: account.marginRequirement.toFixed(),
    openOrderValue: account.openOrderValue.toFixed(),
    positions: diagnosticPositions(account.positions),
    openOrders: account.openOrders.map(diagnosticOrder),
  };
}

export function diagnosticOrder(order: ExchangeOrder): DiagnosticValue {
  return {
    orderId: order.id,
    exchange: order.marketId.exchange,
    marketId: order.marketId.value,
    marketSlug: order.marketSlug,
    side: order.side,
    action: order.action,
    executionPolicy: order.executionPolicy ?? "IOC",
    restUntil: order.restUntil?.toISOString() ?? null,
    state: order.state,
    quantity: order.quantity.toFixed(),
    canonicalPrice: order.canonicalPrice.toFixed(),
    filledQuantity: order.filledQuantity.toFixed(),
    remainingQuantity: order.remainingQuantity?.toFixed() ?? null,
    averageFillPrice: order.averageFillPrice?.toFixed() ?? null,
    fees: order.fees?.toFixed() ?? null,
    updatedAt: order.updatedAt?.toISOString() ?? null,
    lastTransactAt: order.lastTransactAt?.toISOString() ?? null,
  };
}

/** Exact differences, including duplicate/missing rows; no tolerance implied. */
export function diagnosticDifferences(
  expected: AccountSnapshot,
  observed: AccountSnapshot | undefined,
  positions: readonly Position[],
): readonly DiagnosticValue[] {
  const differences: DiagnosticValue[] = [];
  const difference = (
    field: string,
    wanted: string | number | boolean | null,
    actual: string | number | boolean | null,
  ): void => {
    if (wanted !== actual)
      differences.push({ field, expected: wanted, observed: actual });
  };
  if (observed !== undefined)
    for (const field of [
      "currentBalance",
      "buyingPower",
      "marginRequirement",
      "openOrderValue",
    ] as const)
      difference(field, expected[field].toFixed(), observed[field].toFixed());
  difference("positions.length", expected.positions.length, positions.length);
  const key = (position: Position): string =>
    `${position.marketSlug}:${position.side}`;
  const keys = new Set([...expected.positions, ...positions].map(key));
  for (const name of keys) {
    const before = expected.positions.filter(
      (position) => key(position) === name,
    );
    const after = positions.filter((position) => key(position) === name);
    difference(`${name}.rows`, before.length, after.length);
    const wanted = before[0];
    const actual = after[0];
    if (wanted === undefined || actual === undefined) continue;
    difference(
      `${name}.exchange`,
      wanted.marketId.exchange,
      actual.marketId.exchange,
    );
    difference(
      `${name}.marketId`,
      wanted.marketId.value,
      actual.marketId.value,
    );
    for (const field of [
      "quantity",
      "availableQuantity",
      "costBasis",
      "realizedPnl",
    ] as const)
      difference(
        `${name}.${field}`,
        wanted[field].toFixed(),
        actual[field].toFixed(),
      );
    difference(`${name}.expired`, wanted.expired, actual.expired);
  }
  return differences;
}
