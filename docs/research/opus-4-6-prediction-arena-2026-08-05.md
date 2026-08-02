# Claude Opus 4.6 on Prediction Arena: observable evidence

Observed on 2026-08-05 at:

- https://www.predictionarena.ai/models/claude-opus-4-6?platform=polymarket
- https://www.predictionarena.ai/api/polymarket/agents/by-model/claude-opus-4-6
- https://www.predictionarena.ai/api/polymarket/agents/trading-claude-opus-4-6/positions-with-prices
- https://www.predictionarena.ai/api/polymarket/agents/trading-claude-opus-4-6/actions?limit=1000
- https://www.predictionarena.ai/api/polymarket/agents/trading-claude-opus-4-6/settlements?limit=1000

This is an observational audit, not a claim that the displayed return is
reproducible. The public record has material accounting and settlement
integrity problems described below.

## Inspection coverage

The page's five independently scrollable panels were each scrolled slowly from
their first row to their actual bottom, with intermediate stops confirming that
the visible row indexes changed:

| Panel | Rows/cards inspected | Scroll range |
| --- | ---: | ---: |
| Current Market Beliefs | 36 cards (34 beliefs and 2 plans) | 0-35 |
| Active Positions | 38 | 0-37 |
| Recent Closed Trades | 20 | 0-19 |
| Recent Trades | 50 | 0-49 |
| Recent Settlement Components | 20 | 0-19 |

No row expanders, tabs, pagination, or load-more controls were present. The
public JSON endpoints supplied the deeper history: 943 actions and 477
settlement components.

## Direct observations

### Displayed performance and state

- Cash: $7,206.42.
- Account value: $138,944.64.
- Total PnL: $128,944.64; displayed return: +1,289.45%.
- Win rate: 38.5%; total trades: 979; Sharpe: 0.09; maximum drawdown:
  0.00%.
- Maximum trade win/loss: +$259.08 / -$1,439.76.
- Maximum settlement win/loss: +$2,695.56 / -$315.00.
- The page states that Prediction Arena is paused.

### Paper execution and action granularity

- All 943 returned actions have an `action_result.order_id` beginning with
  `paper-`. This was a paper account, not live Polymarket execution.
- The actions contain 681 buys and 262 sells across 165 cycles and 180 markets,
  dated 2026-06-09 through 2026-06-24.
- One Trump-Netanyahu insult market accounts for 448 of 943 actions. Of these,
  436 are buys and 12 are sells. The raw trade count therefore substantially
  overstates the number of independent decisions.
- Multiple actions in that market reconcile to one position: normalized buys,
  sold shares, and the remaining 85,228.81 shares match its displayed active
  position. Repeated order fragments are not evidence of 436 separate edges.

### Portfolio construction

- The 38 active rows have approximately $30,051.59 of cost basis and
  $19,046.61 of displayed current value, with about -$11,089.83 of unrealized
  PnL.
- The Trump-Netanyahu position is displayed as 85.0% of current position value.
  It contains 85,228.81 shares at an average 30.47-cent cost and was about
  -$9,772 unrealized when inspected.
- Its belief estimates 85-90% true probability against a roughly 17-20-cent
  market and explicitly recommends holding to settlement and buying more while
  accepting UMA dispute risk.
- The remaining active portfolio is dominated by weather rows: 27 weather, 6
  geopolitics, 3 insult/mention, and 2 sports rows under a rough text
  classification.
- It holds both high-price favorites and low-price exact outcomes/tails. There
  is no single preferred price regime.

### Beliefs and operational memory

- The 34 beliefs comprise 10 event analyses, 7 risk assessments, 10 market
  structure lessons, and 7 trading strategy lessons.
- Twenty-four of 34 are reusable operating lessons rather than forecasts of a
  currently open event. Beliefs date from April through June and remain visible
  across many cycles.
- Repeated lessons cover exact weather-station mapping, resolver source
  hierarchy, integer rounding, forecast revision risk, creation-date windows,
  literal resolution precedent, order-book depth, limit-order use, spread
  costs, Sunday-versus-weekday mention base rates, and early exits after a
  thesis is invalidated.
- It records concrete execution mistakes, including a displayed 35.5-cent
  Miami price that filled at 46 cents in a market with less than $2,000 of
  liquidity.
- It records a prior failure from holding more than 200 positions, which locked
  nearly all cash. Its later plan targets at most 50 positions, sells dead
  0-3-cent exposure to release collateral, and tries to retain roughly 20%
  cash.
- The current portfolio contradicts some recorded lessons: exact-degree
  weather remains numerous and the current 85% allocation exceeds a stale plan
  describing the core thesis as roughly 55% of risk. Opus is adaptive but not
  internally consistent.

### Timing and position management

- Visible examples favor short capital-release times: weather around 18 hours,
  sports from hours to a few days, and geopolitical trades around five days.
- The agent adds repeatedly when a core thesis remains intact and the price
  falls; it does not treat adverse price movement alone as invalidation.
- It sells invalidated forecasts, dead low-price positions, and inferior
  exposure to release collateral. It also warns against sell/rebuy churn across
  wide spreads.
- Visible losing situations include wrong resolver/station data, changing
  weather forecasts, Sunday mention base-rate errors, creation-window
  ambiguity, disputed settlement language, and slippage.

### Settlement distribution

- The full settlement endpoint returns 477 components for 472 unique markets:
  231 wins, 246 losses, a 48.4% hit rate, and net +$32,878.21.
- Gross settlement wins total about $48,495.44 and gross losses about
  -$15,617.23.
- One Israel-Lebanon meeting contract contributes +$18,308.84, or 55.7% of
  the full settlement net. The three largest gains contribute about 48.2% of
  gross wins.
- Under a rough text classifier, geopolitics contributes +$23,246.93 across 73
  rows, while weather contributes +$6,207.76 across 312 rows despite only a
  29.2% weather win rate. These category numbers are descriptive, not a clean
  backtest, because the source data itself is inconsistent.

## Data-integrity constraints

These are deep constraints on any attempt to reproduce the headline return:

1. Prediction Arena used paper order IDs, while this repository is configured
   for real Polymarket US execution. The venues, market universes, liquidity,
   fills, and settlement paths are not equivalent.
2. Raw action price/cost units change over the history. Many early actions use
   prices below 1 with totals inconsistent with both displayed dollars and
   later cent-denominated records. The UI also shows some sub-cent closes at a
   100x scale error and often reports $0 PnL when raw realized fields are null.
3. Cash plus displayed active position value is $26,253.03, leaving a
   $112,691.61 gap to displayed account value.
4. The 477 settlement components net +$32,878.21, which is $96,066.43 below
   displayed headline PnL.
5. At least one settlement is objectively wrong. Prediction Arena credits the
   April 14 Israel-Lebanon diplomatic-meeting YES side with a $2,777.18 payout,
   while the official Polymarket market states a final outcome of NO:
   https://polymarket.com/event/israel-x-lebanon-diplomatic-meeting-by?marketSlug=israel-x-lebanon-diplomatic-meeting-by-april-14-2026&outcomeIndex=1
6. A displayed 0.00% maximum drawdown is incompatible with the visible large
   realized and unrealized losses and should not be treated as a valid risk
   statistic.

The +1,289% number is therefore not a clean strategy target. It combines paper
execution, outlier dependence, and an accounting record that cannot currently
be reconciled.

## Strong inferences supported by multiple observations

1. **Persistent operator memory is important.** Most beliefs are durable
   lessons, and later plans explicitly respond to earlier settlement,
   execution, and capital-lock mistakes.
2. **Market choice and resolution mechanics matter more than raw activity.**
   The agent repeatedly works in resolver-heavy, short-horizon families, while
   almost half of all actions are fragments of one position.
3. **Sizing is bimodal.** The portfolio combines many small experimental or
   mutually exclusive outcomes with one extreme high-conviction thesis.
4. **The agent optimizes capital turnover.** It repeatedly prefers near-term
   settlement and sells dead exposure to unlock cash.
5. **It tolerates low hit rates when payoff asymmetry is favorable.** Weather
   settlements lose often but remain positive in the contaminated historical
   record; a few geopolitics outcomes dominate overall gains.
6. **It updates rather than merely predicts once.** Adds, reductions, dead-book
   exits, invalidations, and resolver lessons link beliefs to later actions.

## Hypotheses requiring prospective testing

Ranked by expected leverage, not by certainty or claimed future return:

1. **Accumulate advisory operator lessons without letting them authorize
   capital.** Test whether preserving inspected-market and observed-source
   lessons improves subsequent selection, resolver checks, and execution.
2. **Prioritize short-horizon resolver and measurement families.** Test a
   dedicated lane for exact/range weather, already-occurred events, literal
   deadline mismatches, and official-state lag; score at executable prices.
3. **Use conditional concentration.** When one thesis has authoritative current
   evidence, clear settlement, sufficient depth, short duration, and a positive
   conservative edge, test materially higher position/cycle ceilings and Kelly
   deployment. Do not concentrate merely because the model sounds confident.
4. **Rotate capital out of dead or invalidated exposure.** Measure whether
   executable exits improve capital days and realized opportunity capture after
   spreads and fees.
5. **Forecast coherent outcome families.** For mutually exclusive weather or
   election buckets, require a probability distribution and compare one or
   adjacent buckets against combined executable cost.
6. **Track every decision prospectively at executable prices.** Compare model
   probability, conservative authorization probability, entry ask/VWAP, marks,
   and settlement. This is necessary before attributing improvement to prompt,
   sizing, or selection changes.
7. **Do not imitate action fragmentation.** Test repeated additions only across
   genuinely new evidence states; splitting one desired exposure into hundreds
   of paper actions is not itself an edge.

## Falsification criteria

- Persistent memory is not useful if later cycles do not retrieve or act on it,
  or if stale lessons increase decision errors.
- A short-horizon family lane is not useful if its candidates do not improve
  conservative executable edge or settlement clarity in the shadow ledger.
- Higher concentration is not useful if eligible opportunities are absent, if
  caps were not binding, or if drawdown/settlement ambiguity increases without
  better prospective expected value.
- More orders are not evidence of improvement. Improvement requires better
  executable-price decisions and, after enough resolutions, better calibrated
  outcomes and terminal value.
