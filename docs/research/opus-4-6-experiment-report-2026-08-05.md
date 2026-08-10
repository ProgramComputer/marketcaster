# Opus 4.6 Prediction Arena reverse-engineering and live experiments

Date: 2026-08-05

This report distinguishes observable facts, inferences, and experiments. It
does not treat Prediction Arena's displayed return as a reproducible result and
does not claim that the local agent will earn similar returns.

## Bottom line

The local system genuinely improved as an auditable trading operator:

- it now selects short-horizon measurement families that the prior filter
  suppressed;
- it retains resolver and execution lessons without allowing memory to
  authorize capital;
- it separates contract context from externally attributed facts;
- it audits both YES and NO executable asks before accepting a no-edge pass;
- it records prospective executable-price decisions before account reporting;
- it can reconstruct fractional Polymarket US fills and continue after an IOC;
- it successfully placed and reconciled two live NO positions; and
- its position, cycle, and fractional-Kelly ceilings are materially higher.

That is an engineering and decision-process improvement, not evidence of
improved returns. The persistent ledger has 52 observations but only two
settled observations, no resolved authorized buy, and no resolved executable
pass counterfactual. Calibration and P&L conclusions would be unsupported.

## Network and environment verification

- Outbound networking worked from the sandbox.
- The Prediction Arena page and its public model, position, action, and
  settlement endpoints were reachable.
- Live cycles reached Polymarket US, official evidence pages, and Anthropic.
- The active local configuration was Polymarket US, Claude Opus 4.6, and live
  mode.
- `.env` contents and secret values were never printed or modified.
- No live mode was enabled by code; it was already explicitly selected and was
  used at the user's direction.

## Prediction Arena inspection coverage

The Chrome integration was used on:

https://www.predictionarena.ai/models/claude-opus-4-6?platform=polymarket

Every nested panel was independently scrolled from beginning to actual bottom,
with intermediate checks that its rows changed:

| Panel                        |                          Inspected |
| ---------------------------- | ---------------------------------: |
| Current Market Beliefs       | 36 cards: 34 beliefs and two plans |
| Active Positions             |                            38 rows |
| Recent Closed Trades         |                            20 rows |
| Recent Trades                |                            50 rows |
| Recent Settlement Components |                            20 rows |

No expansion, tab, pagination, or load-more control was present. Public JSON
endpoints extended the sample to 943 actions and 477 settlement components.
The detailed browser/API audit is in
`docs/research/opus-4-6-prediction-arena-2026-08-05.md`.

## Directly observed facts about Opus 4.6

### Displayed performance is not trustworthy enough to copy

- Prediction Arena displayed $7,206.42 cash, $138,944.64 account value,
  $128,944.64 PnL, +1,289.45% return, 38.5% win rate, 979 trades, 0.09
  Sharpe, and 0.00% maximum drawdown.
- Every one of the 943 API action order IDs began with `paper-`; this was paper
  execution, not the live Polymarket US venue used locally.
- Cash plus displayed active-position value was only $26,253.03, leaving a
  $112,691.61 gap to displayed account value.
- All settlement components netted +$32,878.21, $96,066.43 below headline PnL.
- Prediction Arena credited an April 14 Israel-Lebanon meeting YES settlement
  that official Polymarket resolved NO.
- One Israel-Lebanon settlement contributed $18,308.84, or 55.7% of full
  settlement net. The return is strongly outlier-dependent.
- A displayed 0.00% drawdown is incompatible with visible large realized and
  unrealized losses.

The highest-probability explanation of the displayed 10x is therefore a mix of
paper fills, accounting/settlement defects, and a small number of outliers—not
a stable 10x strategy that can be inferred from the page.

### Observable operating behavior

- The 34 beliefs included 24 reusable operating lessons. They covered station
  identity, resolver hierarchy, rounding, forecast changes, market-creation
  windows, literal resolution precedent, spreads, liquidity, slippage, base
  rates, and early exits after invalidation.
- The agent recorded its own mistakes and later plans referred to them. One
  lesson described a displayed 35.5-cent weather price filling at 46 cents;
  another described more than 200 positions locking nearly all cash.
- It traded short-horizon weather, sports, mention, and geopolitics markets,
  mixed favorites with low-probability outcomes, and compared belief with
  price rather than using one price regime.
- It added repeatedly when evidence still supported a core thesis, sold dead
  or invalidated positions, and warned against spread-heavy sell/rebuy churn.
- It was highly concentrated. One Trump-Netanyahu position was 85% of current
  active-position value and approximately -$9,772 unrealized when inspected.
- It was not internally consistent: 27 of 38 open rows were weather despite
  several weather-risk lessons, and the 85% position exceeded a stale plan's
  roughly 55% core allocation.
- Of 943 actions, 448 belonged to one Trump-Netanyahu market. Those were order
  fragments associated with one position, not 448 independent ideas.
- The full settlement history had 231 wins and 246 losses. Under a rough text
  classifier, weather was positive despite a 29.2% hit rate, while geopolitics
  supplied most net gains. The contaminated source data prevents a clean
  strategy attribution.

## Strong inferences

1. **Durable operator memory matters.** Multiple later plans explicitly encode
   earlier resolver, execution, and capital-lock lessons.
2. **Selection and settlement mechanics matter more than action count.** Raw
   actions are heavily fragmented, while beliefs repeatedly emphasize exact
   resolution mechanics.
3. **Sizing is conditional and bimodal.** Many small positions coexist with a
   single extreme thesis. The extreme example also demonstrates why copying
   concentration without independent evidence is dangerous.
4. **Capital turnover matters.** Near-term weather and sports positions, dead
   position exits, and cash-release language recur across the record.
5. **The payoff distribution is right-tailed.** A low hit rate can coexist with
   gains when a few payoffs are large, although the Arena record is too flawed
   to estimate the true distribution.
6. **The agent revises positions rather than making one static forecast.** Adds,
   reductions, invalidations, and resolver lessons link beliefs to actions.

## What cannot honestly be inferred

- The hidden system prompt, exact tool results, model temperature, full market
  universe, and rejected-candidate history are unavailable.
- Belief timestamps cannot be reliably matched to every action or fill.
- Paper action rows do not establish executable live prices, fees, queue
  priority, or available depth.
- The full accounting identity, deposits, withdrawals, and correct settlement
  history cannot be reconstructed.
- The sample does not identify whether forecasting, sizing, selection,
  execution, data errors, or luck caused the headline return.
- Prediction Arena's international/paper universe and local Polymarket US live
  universe are not interchangeable.
- The 85% concentration is an observation, not proof that 85% is optimal. It
  was the largest current loser when inspected.

These are the deepest constraints on reverse-engineering Opus. More confidence
or more prompt wording cannot recover missing causal data.

## Ranked suggestions most likely to explain or produce very large returns

This ranking separates the displayed 10x from robust local improvements.

1. **Arena accounting/settlement artifacts plus paper execution.** Most likely
   contributor to the displayed magnitude; not a strategy to reproduce.
2. **A few concentrated outlier winners.** Directly supported by the settlement
   distribution; also creates severe drawdown and selection risk.
3. **Resolver-aware selection of short-horizon mispricings.** The strongest
   plausible repeatable operator edge.
4. **Persistent learning from execution and settlement mistakes.** Likely
   improves later selection and avoids repeated failure modes.
5. **Fast capital recycling and invalidation exits.** Increases opportunity
   throughput without requiring more independent forecasts.
6. **Coherent family forecasting and two-sided price comparison.** Prevents the
   exact local error where a rejected YES concealed an attractive NO.
7. **Conditional concentration after evidence, settlement, and depth checks.**
   Potentially high impact, but only after an opportunity exists; the observed
   Opus concentration also produced a large loss.
8. **More raw orders.** Unlikely to be causal. Arena's largest action cluster
   was fragmentation of one position.

## Repository assumptions challenged

- Advisory state had been coupled to trade-grade evidence authorization. That
  discarded useful operator lessons merely because they could not authorize a
  current order.
- The high-leverage market filter effectively excluded exact/range weather
  unless a favorite exceeded 65%, even though weather dominated Opus activity.
- Evidence validation treated market-title and settlement-rule numbers as if
  every number had to appear in an external article excerpt.
- A `NO_POSITIVE_EDGE` pass trusted the one side the model named. The model
  could reject YES while its own interval implied positive NO edge.
- The priority research gate could make an unrelated passed candidate's
  citation delay a separately supported target.
- Three preview calls were insufficient once a family and both sides were
  evaluated.
- Polymarket US `qty` was assumed positive even when its lossy integer field
  reports `0` alongside the authoritative `qtyDecimal="0.3000"`. This broke
  every account snapshot after the first fractional fill.
- Shadow observations were persisted only after final account reporting. An
  account API failure could therefore preserve a run artifact but omit the
  decision from the cross-cycle ledger.
- The 20% cycle spend ceiling was assumed not to matter. In the first audited
  two-target cycle it bound exactly and resized the second target from $8.719
  requested risk to $1.744 maximum spend.
- Greater capacity was sometimes discussed as if it should itself create
  trades. The final cycle showed that depth and opportunity quality can remain
  the actual constraints.

## Important implementation changes

### Prospective executable-price ledger

- Added an append-only, account-scoped shadow ledger with immutable
  observations, marks, settlements, calibration, authorized-buy P&L,
  accepted-sell value added, and pass counterfactuals.
- Captures point/lower/upper probability, conservative authorization
  probability, contemporaneous bid/ask/depth, estimated taker fee, settlement
  rules and hash, evidence times, risk disposition, and decision text.
- Records passed candidates separately from authorized trades and never counts
  their counterfactual P&L as strategy profit.
- Persists the capture before final account reporting, so an account-reporting
  failure cannot erase the prospective decision record.
- Persistent index:
  `reports/shadow-ledger/polymarket-us/account-984c680115449273279a95cf67da12a3/index.json`.

### Market selection and forecasting

- Added an explicit short-horizon measurement-family lane for exact/range
  temperature markets closing within 36 hours.
- Requires family inspection, making neighboring mutually exclusive buckets
  available before choosing a side.
- Preserved category diversity and existing high-leverage lanes rather than
  replacing the universe with weather.
- Added treatment/control market-selection artifacts and a frozen-snapshot
  experiment command.

### Memory

- Advisory beliefs may now cite a source observed this cycle or an inspected
  market as their basis.
- Bad supplied URLs still fail. Persisted memory remains untrusted and cannot
  authorize an order without fresh terminal evidence.
- Memory mutations, provenance decisions, before/after state, and treatment
  results are reported.

### Evidence and decision guards

- Separated authoritative contract context from externally attributed source
  claims. Contract title, slug, rules, and validated metadata dates do not need
  to be copied from an external article.
- Invalid redundant citations are advisory after the configured valid current
  domain requirement is met; they are excluded rather than allowed to
  authorize exposure.
- Added a deterministic both-sides audit for `NO_POSITIVE_EDGE`. It freezes a
  fresh BBO, transforms the interval to the opposite side, applies the same
  uncertainty policy and fee model, and requests a bounded model repair when a
  material executable edge was omitted.
- The audit never submits an order directly; the repaired target still passes
  ordinary evidence, settlement, book, risk, preview, and execution checks.
- Audit history is retained so a successful repair does not erase evidence
  that the guard fired earlier.

### Research and execution throughput

- Increased the preview budget from three to six so family and opposite-side
  audits can be completed in one cycle.
- Restricted passed-priority external-source research from delaying a
  separately grounded new-market exposure. It still applies before an all-pass
  decision, and target evidence remains fully blocking.
- Fixed fractional trade activity parsing: a zero-valued legacy integer `qty`
  is accepted only when a positive `qtyDecimal` exists. Submitted order
  quantities remain strictly positive.
- Preserved live execution journals, IOC previews, post-order account
  reconstruction, ambiguity stops, open-order checks, settlement checks, and
  exact account-scoped recovery.

### Sizing

- Current ceilings are 75% maximum same-position cost basis, 50% maximum cycle
  spend, and 85% fractional Kelly.
- The uncertainty-bound weight remains 25%, maximum execution spread remains
  10 cents, and at least one independent current source remains required.
- Higher ceilings do not bypass price, evidence, settlement, fee, depth,
  correlation, duplicate-order, or account-state checks.
- Added a concentration experiment artifact reporting capacity, utilization,
  accepted/rejected targets, and the exact binding baseline.

### Prompt caching and diagnostics

- Kept the one-hour system/tool prompt-cache breakpoints and top-level
  ephemeral automatic caching.
- Kept the cache-diagnostics beta and previous-message chaining.
- Reports aggregate cache reads, cache-create tokens, read fraction, raw
  diagnostic states, miss reasons, and missed input tokens.
- Final cycle: 17/17 rounds had cache reads; cache-read fraction was 0.932622.
  Diagnostics were 13 null results and four misses: one `messages_changed`, one
  `unavailable`, and two `previous_message_not_found`.
- Null diagnostics do not imply a miss; they mean no divergence reason was
  returned. The miss reasons should continue to be monitored.

Official references:

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics

## Iteration results

| Experiment                    | Hypothesis                                                                                 | Prospective result                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A: advisory operator memory   | Useful lessons should survive without becoming trade evidence                              | Improved: two mutations committed with zero provenance issues versus two discarded mutations and three issues in baseline. No decision-quality conclusion yet.                                                                                   |
| B: measurement-family lane    | Short-horizon exact weather was being filtered out                                         | Improved selection coverage: frozen replay moved treatment climate rows from zero measurement families to four; live run inspected NYC/LAX families. No order and no return conclusion.                                                          |
| C: source/contract separation | Contract numbers were causing false external-evidence vetoes                               | Improved: verified current sources rose from zero to two and blocking issues fell to zero in the treatment run. It exposed a separate two-sided decision error.                                                                                  |
| D: both-sides pass audit      | A rejected named side could conceal opposite-side edge                                     | Improved: audit rejected the LAX pass with 9.3174 cents estimated NO edge after fees. Repaired plan contained NYC and LAX NO targets. NYC IOC filled 12.3 at 0.40; post-fill reporting then exposed the fractional-activity schema bug.          |
| E: execution throughput       | Fixing activity parsing, preview budget, and pass-gate scope would allow a full live cycle | Improved: LAX NO filled 8.3 at 0.29; account reconciliation succeeded; no ambiguity stop; ledger persisted and the run ended `SUCCESS`.                                                                                                          |
| F: conditional concentration  | Higher ceilings would deploy more capital when caps bind                                   | Inconclusive in the treatment cycle: $43.5683 capacity, $0 committed. Only about six LAX and 0.3 NYC contracts were visible within preview limits; the model held rather than chasing. Keep the higher ceilings, but depth—not caps—was binding. |

The D order result was known and durable despite its reporting failure: the IOC
filled 12.0 and 0.3 NYC NO contracts at a 0.40 average, then expired. The
current account snapshot confirmed 12.3 available contracts and $5.093 cost
basis. The ledger capture was recovered idempotently after the parser fix.

The E order filled 8.3 LAX NO contracts at 0.29, paid $0.10 reported fees, and
reconciled to 8.3 available contracts with $2.514 cost basis.

## Reports examined

Primary baselines and formative runs:

- `reports/runs/3ef336d9-f5dd-4e78-b68e-d4ea72dafdf8/3d15feb7-0a8f-4580-90af-c872269522ae`
- `reports/runs/ba5551e7-f692-454a-bc08-7e16cefa241e/f357d48e-7420-4cca-8eb0-dd223c277528`
- `reports/runs/b3ee4b22-44b4-4f87-844b-96fe785f5967/4f6b0556-46a0-4a3b-9c7a-4f4499c19b8e`
- `reports/runs/85bec8df-2baf-4b90-bd6b-724ca2ff9a89/022fcd87-448c-482b-b542-b4bdc819d26d`
- `reports/runs/0913509d-c08e-482f-a134-b1982926088e/d0e5a7cb-0376-41c1-ac56-e7a51820d3b3`
- `reports/runs/f5a49b08-097b-4768-8b39-946e4261169e/78124db0-6773-4085-8f15-1f4024afc24a`
- `reports/runs/642b2a56-bee4-4ff0-94a2-6d26586d58e7/c21d231d-11dd-4cef-8b40-f3d853fbd3f2`

Experiments A-F:

- `reports/runs/a26f7f20-45c0-4123-8ffc-7d4cd7a933a4/963c118a-3a14-46a0-8536-e2a7ae694820`
- `reports/runs/f4793abc-7cf9-46eb-bc47-c9bf1a295e1a/25367c5c-2f74-42ef-9721-a53b49d6694c`
- `reports/runs/3a6a8880-17c8-4e25-b55b-00268c0b4780/94e2bfe4-d31b-4168-89d9-3d54c7bc2b60`
- `reports/runs/03b34e88-0df5-47da-a84b-d194f2f1fe89/c1e05356-7f4e-4c21-a89d-e2565cf4f665`
- `reports/runs/2740d8ee-56fa-4bd6-8bb2-3af8d5e7aa8e/510336a4-7ffa-4d7f-9d51-608efc58b2dc`
- `reports/runs/36a517d2-0f82-41c5-baa4-a696bbb96e6f/6b85834f-4cee-499b-96ef-3e64525eb99a`

The final run's `cycle-report.json`, `decision.json`, `validation.json`,
`execution-report.json`, `shadow-ledger.json`,
`concentration-experiment.json`, `pass-edge-audit.json`,
`evidence-validation.json`, `agent-state.json`, and account snapshots were all
reviewed. It ended `PASS`, reconstructed the account successfully, recorded no
order attempt, and left no open order.

## Commands and verification

Repeated as source changed:

```text
npm run lint
npm run typecheck
npm run build
node --env-file=.env dist/src/index.js
```

Also run:

```text
npm run experiment:market-selection
git diff --check
```

Read-only account and API diagnostics were run through the compiled exchange
adapter without printing credentials. No test suite was run, following the
explicit instruction to use linting and type checking instead. The final lint,
typecheck, and build all passed. No test files or test script remain.

## Remaining differences and deep constraints

1. **Outcome evidence is immature.** Two settled ledger observations are not a
   calibration sample; none of the three authorized buys has resolved.
2. **Arena is paper and local execution is real.** Market availability,
   liquidity, fills, fees, and settlement behavior differ materially.
3. **Arena accounting is corrupted.** It prevents trustworthy attribution of
   its headline return.
4. **Local depth is often the binding constraint.** Raising caps cannot buy
   contracts that are not offered within a positive-edge price.
5. **Forecast quality remains the core unknown.** The agent can cite current
   NWS data and still miscalibrate an exact two-degree bucket.
6. **Evidence binding remains verbose and repair-prone.** The model sometimes
   puts market prices or its own probability calculations into a source's
   `relevance` field or cites an unread source. Validation correctly blocks
   those cases, but repairs cost rounds and latency.
7. **All-pass cycles remain slow.** The final cycle used 17 model rounds because
   it had to inspect and source a priority live event before passing.
8. **One dead Stevens position cannot be exited.** The exchange returns no
   usable BBO. The agent targets zero each cycle but must not invent liquidity.
9. **Family distributions are not yet a hard normalized object.** The prompt
   encourages family reasoning, but deterministic validation does not require
   probabilities across mutually exclusive outcomes to sum to one.
10. **The higher caps are only ceilings.** They have not yet been prospectively
    exercised on a deep, high-edge market.

## Strongest next experiments

1. **Wait for ledger outcomes.** Do not tune from two settlements. Reconcile
   the NYC and LAX weather outcomes and compare realized payoff with the frozen
   executable asks and forecast intervals.
2. **Normalized family forecast object.** Require every seriously considered
   mutually exclusive family to return probabilities that sum to one, an
   outside/tail allocation, and a resolver timestamp; compare every side at
   executable prices.
3. **Capital-days experiment.** Measure whether exits of invalidated/dead
   holdings release capital soon enough to improve subsequent executable
   opportunity capture after spreads and fees.
4. **Source-claim structure.** Separate `sourceClaim`, `contractContext`, and
   `modelInference` fields in the decision schema so a correct thesis does not
   need a repair merely because its explanatory relevance contains a market
   price.
5. **Priority audit efficiency.** Cache official live-event source bindings by
   immutable event/state timestamp within a cycle and evaluate whether an
   all-pass result can retain the same audit quality in fewer rounds.
6. **Deep-book concentration trial.** Only when an independently sourced,
   short-horizon target has sufficient depth, compare the old and new ceiling
   allocations prospectively. Record drawdown and capital days, not only P&L.
7. **Opus linkage sample.** Revisit Prediction Arena if it resumes and collect
   several complete belief-to-action-to-settlement sequences. Do not infer
   causality from the current snapshot.

## Final assessment

Yes, the system improved in ways directly demonstrated by live behavior:

- a missed opposite-side edge became an explicit target;
- two live orders filled at bounded prices;
- the fractional-fill account failure was reproduced, diagnosed, fixed, and
  re-verified;
- subsequent post-order reconciliation completed without ambiguity;
- shadow records survived and accumulated across cycles; and
- selection, evidence, audit, memory, and sizing decisions are substantially
  more inspectable.

No, there is not yet evidence that expected return, calibration, Sharpe, or
future P&L improved. The final system is more capable of producing and
measuring an Opus-like operator decision; only prospective outcomes can show
whether those decisions are actually better.
