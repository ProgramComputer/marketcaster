import { Decimal } from "decimal.js";
import pLimit from "p-limit";
import type { AccountSnapshot } from "../domain/account.js";
import type { DepthResult } from "../domain/execution.js";
import type { Position } from "../domain/position.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import { walkCanonicalBook } from "../execution/depth.js";

export interface PositionValuation {
  readonly marketSlug: string;
  readonly side: Position["side"];
  readonly quantity: Decimal;
  readonly liquidation: DepthResult;
  readonly liquidationValue: Decimal;
  readonly fullyLiquid: boolean;
}

export interface PortfolioValuation {
  readonly exchangeReportedValue: Decimal;
  readonly arenaAccountValue: Decimal;
  readonly riskEquity: Decimal;
  readonly spendableCapital: Decimal;
  readonly positions: readonly PositionValuation[];
  readonly warnings: readonly string[];
}

export async function valuePortfolio(
  exchange: PredictionExchange,
  snapshot: AccountSnapshot,
  maximumConcurrency = 4,
): Promise<PortfolioValuation> {
  const warnings: string[] = [];
  const missingExchangeCashValues = snapshot.positions.filter(
    (position) => position.exchangeCashValue === undefined,
  );
  const exchangePositionValue =
    missingExchangeCashValues.length === 0
      ? snapshot.positions.reduce(
          (total, position) => total.plus(position.exchangeCashValue ?? 0),
          new Decimal(0),
        )
      : snapshot.assetNotional;
  if (missingExchangeCashValues.length > 0) {
    warnings.push(
      `Per-position exchange cash value missing for ${missingExchangeCashValues
        .map((position) => position.marketSlug)
        .join(", ")}; used the exchange-reported aggregate asset value`,
    );
  }
  // Polymarket US represents canonical NO inventory as a short YES position.
  // Opening a short credits sale proceeds to currentBalance while locking one
  // dollar of margin per contract. Buying power already nets that collateral;
  // adding position value to currentBalance would count the short proceeds a
  // second time. The exchange's documented portfolio-value identity is buying
  // power plus marked position value for both long and short positions.
  const exchangeReportedValue = snapshot.buyingPower.plus(
    exchangePositionValue,
  );

  const limit = pLimit(maximumConcurrency);
  const positions = await Promise.all(
    snapshot.positions.map((position) =>
      limit(async (): Promise<PositionValuation> => {
        const book = await exchange.getOrderBook(position.marketId);
        const liquidation = walkCanonicalBook(
          book,
          position.side,
          "SELL",
          position.quantity,
          new Decimal(0),
        );
        if (liquidation.fillableQuantity.isZero()) {
          warnings.push(
            `No executable liquidation bid for ${position.marketSlug} ${position.side}; conservative value is zero`,
          );
        } else if (!liquidation.fullyFillable) {
          warnings.push(
            `Insufficient book depth to liquidate all of ${position.marketSlug} ${position.side}; unfilled quantity is valued at zero`,
          );
        }
        return {
          marketSlug: position.marketSlug,
          side: position.side,
          quantity: position.quantity,
          liquidation,
          liquidationValue: liquidation.principal,
          fullyLiquid: liquidation.fullyFillable,
        };
      }),
    ),
  );

  const liquidationValue = positions.reduce(
    (total, position) => total.plus(position.liquidationValue),
    new Decimal(0),
  );
  const arenaAccountValue = snapshot.buyingPower.plus(liquidationValue);

  return {
    exchangeReportedValue,
    arenaAccountValue,
    riskEquity: Decimal.min(exchangeReportedValue, arenaAccountValue),
    spendableCapital: snapshot.buyingPower,
    positions,
    warnings,
  };
}
