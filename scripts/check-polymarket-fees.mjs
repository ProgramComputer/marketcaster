import assert from "node:assert/strict";
import { log } from "node:console";
import { Decimal } from "decimal.js";
import {
  estimateTakerFee,
  estimateExchangeTakerFee,
  estimateExchangeTakerFeePerContract,
  estimatePolymarketUsFillFee,
  estimatePolymarketUsTakerFeeUpperBound,
} from "../dist/src/risk/edge.js";
import { PolymarketUsExchange } from "../dist/src/exchanges/polymarket-us/adapter.js";

const d = (v) => new Decimal(v);
// Official schedule: https://docs.polymarket.us/fees (2026-09-17).
for (const [price, taker, maker] of [
  ["0.01", "0.07", "-0.01"],
  ["0.10", "0.63", "-0.11"],
  ["0.25", "1.30", "-0.23"],
  ["0.50", "1.74", "-0.31"],
  ["0.75", "1.30", "-0.23"],
  ["0.90", "0.63", "-0.11"],
  ["0.99", "0.07", "-0.01"],
]) {
  assert.equal(
    estimateExchangeTakerFee("polymarket-us", d(100), d(price)).toFixed(2),
    taker,
  );
  assert.equal(
    estimatePolymarketUsFillFee(d(100), d(price), "MAKER").toFixed(2),
    maker,
  );
}
assert(
  estimateExchangeTakerFeePerContract("polymarket-us", d("0.5")).eq("0.017375"),
);
assert(
  estimateExchangeTakerFeePerContract("polymarket-us", d("0.5"))
    .div("0.5")
    .eq("0.03475"),
);
// Exact half-cent ties in both directions, including negative maker rebates.
assert(estimatePolymarketUsFillFee(d(40), d("0.5"), "TAKER").eq("0.70")); // .695
assert(estimatePolymarketUsFillFee(d(120), d("0.5"), "TAKER").eq("2.08")); // 2.085
assert(estimatePolymarketUsFillFee(d(8), d("0.5"), "MAKER").eq("-0.02")); // -.025
assert(estimatePolymarketUsFillFee(d("11.2"), d("0.5"), "MAKER").eq("-0.04")); // -.035
assert(estimatePolymarketUsFillFee(d("0.01"), d("0.01"), "TAKER").isZero());
assert(estimatePolymarketUsFillFee(d(0), d("0.5"), "TAKER").isZero());

// Synthetic fragmented fills: independently rounded fees may exceed the cap.
// Apply the published per-order adjustment and verify the adapter's reserve.
for (const action of ["BUY", "SELL"]) {
  for (const limit of ["0.01", "0.10", "0.49", "0.5", "0.51", "0.90", "0.99"]) {
    const estimate =
      await PolymarketUsExchange.prototype.createImmediateOrderFeeReserveEstimator.call(
        {},
        { action, canonicalLimitPrice: d(limit) },
      );
    for (const quantities of [
      [1],
      [1, 1, 1],
      ["0.01", "0.99", 8, 120],
      [100, 1000],
    ]) {
      let cumulativeExact = d(0);
      let collected = d(0);
      let totalQuantity = d(0);
      for (const [index, quantity] of quantities.entries()) {
        const price =
          action === "BUY"
            ? d(limit).mul(index % 2 ? "0.5" : 1)
            : d(limit).plus(
                d(1)
                  .minus(limit)
                  .mul(index % 2 ? "0.5" : 0),
              );
        cumulativeExact = cumulativeExact.plus(
          estimateTakerFee(d(quantity), price),
        );
        const roundedFill = estimatePolymarketUsFillFee(
          d(quantity),
          price,
          "TAKER",
        );
        const cap = cumulativeExact.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
        const adjusted = Decimal.min(roundedFill, cap.minus(collected));
        assert(adjusted.gte(0) && adjusted.lte(roundedFill));
        collected = collected.plus(adjusted);
        totalQuantity = totalQuantity.plus(quantity);
        assert(collected.lte(estimate(totalQuantity)));
      }
      assert(
        estimate(totalQuantity).eq(
          estimatePolymarketUsTakerFeeUpperBound(
            totalQuantity,
            d(limit),
            action,
          ),
        ),
      );
    }
  }
}
assert(
  estimatePolymarketUsTakerFeeUpperBound(d(1), d("0.99"), "BUY").eq("0.02"),
);
assert(
  estimatePolymarketUsTakerFeeUpperBound(d(1), d("0.99"), "SELL").isZero(),
);
// Other exchange rounding is unchanged.
assert(estimateExchangeTakerFee("kalshi", d(100), d("0.5")).eq("1.76"));
log(
  "Polymarket US rates, half-even rounding, maker rebates, and fragmented-fill adapter reserves passed.",
);
