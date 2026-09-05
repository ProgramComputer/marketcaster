import type { AccountSnapshot } from "../domain/account.js";
import type { PredictionExchange } from "../exchanges/exchange.js";

export class IncompleteExchangeStateError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IncompleteExchangeStateError";
  }
}

export async function reconstructAccount(
  exchange: PredictionExchange,
): Promise<AccountSnapshot> {
  let snapshot: AccountSnapshot;
  try {
    snapshot = await exchange.getAccountSnapshot();
  } catch (cause) {
    throw new IncompleteExchangeStateError(
      "The authoritative exchange account snapshot could not be reconstructed",
      { cause },
    );
  }

  const requiredValues = [
    ["currentBalance", snapshot.currentBalance],
    ["buyingPower", snapshot.buyingPower],
    ["assetNotional", snapshot.assetNotional],
    ["assetAvailable", snapshot.assetAvailable],
    ["openOrderValue", snapshot.openOrderValue],
    ["unsettledFunds", snapshot.unsettledFunds],
    ["marginRequirement", snapshot.marginRequirement],
  ] as const;

  for (const [name, value] of requiredValues) {
    if (!value.isFinite()) {
      throw new IncompleteExchangeStateError(`${name} was not finite`);
    }
  }
  if (snapshot.buyingPower.lt(0)) {
    throw new IncompleteExchangeStateError("buyingPower was negative");
  }
  if (Number.isNaN(snapshot.observedAt.getTime())) {
    throw new IncompleteExchangeStateError("Snapshot timestamp was invalid");
  }

  return snapshot;
}
