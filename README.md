# MarketCaster

MarketCaster is an open-source prediction-market trading engine for Polymarket
US and Kalshi. Each cycle reconstructs the selected exchange account, discovers
and researches active markets, asks a model for desired total portfolio
exposures, reconciles those targets against current positions, and applies
deterministic validation before any order can reach an exchange.

MarketCaster runs in observe mode by default. Its reference mode presents the
exchange catalog and allocates no BUY capital. Optional modules provide
selection, forecast, and allocation policies through a versioned interface.

> [!WARNING]
> MarketCaster is experimental software, not financial, investment, legal, or
> tax advice. Prediction-market trading can lose all committed funds. Models,
> market data, and exchange APIs can be wrong, stale, or unavailable. You are
> responsible for exchange rules and applicable law. Use this software at your
> own risk.

## Reference behavior and extensions

MarketCaster includes exchange adapters, account reconstruction, market
discovery, research tools, provider integrations, portfolio reconciliation,
risk and evidence validation, execution guards, reporting, persistent state,
and a command-line interface.

The reference configuration and prompt support catalog inspection and request
no BUY allocations. Optional trusted policy modules can customize selection,
forecasting, and allocation through a [versioned contract](docs/strategy-policy.md).
They cannot replace deterministic validation or submit orders through that API.
An explicitly configured missing or invalid module stops initialization.

## Supported exchanges

| Exchange      | `EXCHANGE_ID`   |
| ------------- | --------------- |
| Polymarket US | `polymarket-us` |
| Kalshi        | `kalshi`        |

Polymarket support targets the Polymarket US retail API. It does not implement
Polymarket International wallet authentication, USDC collateral, or the
international CLOB.

Kalshi support targets the Prediction Trade API v2, including live and
historical data tiers. Trading is intentionally limited to primary subaccount 0
and exchange index 0. Multivariate markets and nonzero exchange shards are
excluded until their account and settlement semantics are modeled.

## Architecture

```mermaid
flowchart TD
  A[Load configuration and strategy] --> B[Reconstruct account from exchange]
  B --> C[Restore account-scoped advisory state]
  C --> D[Discover and inspect markets]
  D --> E[Research current evidence and estimate probabilities]
  E --> F[Model submits desired total portfolio targets]
  F --> G[Reconcile targets to current positions]
  G --> H[Read-only deterministic review]
  H -->|Repairable rejection| E
  H --> I[Refresh market, quote, book, fees, and buying power]
  I -->|Rejected| M[Write report]
  I --> J{Execution mode}
  J -->|Observe| M
  J -->|Live| K[Preview and submit marketable IOC order]
  K --> L[Reconstruct exchange state again]
  L --> M
```

The exchange remains the source of truth for balances, positions, open orders,
fills, settlements, and recent account activity. Local state is advisory; it
does not reconstruct the trading account or authorize an order.

## Market discovery and research

The full supported exchange catalog is available through paginated discovery.
A bounded opportunity board provides a starting point while category, tag,
event, series, keyword, volume, movement, spread, depth, open-interest, price,
expiry, and data-age filters can explore the wider universe. Exact market and
market-family tools fetch settlement rules and current quotes on demand.

The public reference board uses exchange order. Optional grouping and bounded
enrichment mechanisms accept optional callbacks. Reference configuration
values are illustrative safety and resource limits.

On Polymarket US the catalog is listed twice. Markets in ascending ID order
define membership, because volume order shifts between page requests and can
repeat or skip rows. A volume listing with an ID tie-breaker ranks the members,
and a market it returns that the membership list skipped is kept. An empty page
directly after a full page is re-requested with increasing waits before it is
accepted as the end of the list. Each cycle records page-level acquisition and
reports `COMPLETE` or `DEGRADED` coverage; a few repeated membership rows from
markets opening or closing mid-scan are reported without degrading coverage.

`marketSelection.catalogSupplements` can list exchange categories, or a
close-time horizon in hours, whose complete listings are merged into the
catalog. A supplement that fails or is unsupported by the exchange degrades
coverage. `marketSelection.degradedCatalogPolicy` is `WARN` by default;
`BLOCK_NEW_ENTRIES` refuses BUY actions in markets without a current position
while coverage is degraded, and tells the model so before research.

Discovery output is untrusted catalog evidence. It never establishes settlement
identity, source validity, correlation, executable liquidity, or permission to
trade. Those facts are checked later against exact market details and refreshed
exchange state.

Set `cycle.stageBudgetsSeconds.marketDiscovery` to `null` in the
complete configuration to use the overall cycle deadline without a separate
discovery timer. A positive integer retains a discovery limit in seconds.
The overall `cycle.timeoutSeconds` and other stage budgets still apply.
Polymarket US quote sides returned as `null` are treated as absent liquidity;
any present side retains the normal quote validation.

Research tools support current web search, bounded reads of URLs already
observed in the cycle, market analysis, and non-binding trade previews. Evidence
used for a probability-bearing decision must match an observed URL and exact
source excerpt. Deterministic validation checks evidence provenance, freshness,
source independence, settlement facts, and decision coverage.

## Decision providers

Built-in providers support OpenAI's Responses API and Anthropic. An optional
`LLM_CATALOG_MODEL` can perform the bounded catalog-narrowing phase before the
primary `LLM_MODEL` takes ownership of web research, evidence reads, analysis,
previews, state changes, final decisions, and repair rounds.

The provider does not place orders. It returns desired total exposures and
supporting audit fields. The same deterministic validator reviews terminal
plans for both providers and may return structured read-only repair feedback.
Any repaired plan is validated again against fresh exchange state.

## Portfolio reconciliation and execution

The model returns `targetCostBasisFraction`: desired total same-side cost basis
as a fraction of current risk equity. It does not return a one-shot order size.
An explicit zero requests an exit. Every holding must receive a target.

A pure reconciler computes the remaining BUY or SELL delta from the
authoritative cycle-start position. Kelly sizing, concentration, buying power,
cycle spend, spread, fees, source requirements, and book depth can shrink or
reject it. A later cycle recomputes only the remaining gap from newly
reconstructed exchange state.

Live orders use marketable limits. SELLs and configurations without managed
resting BUYs use immediate-or-cancel, so any unfilled remainder is canceled.
Polymarket US also supports configurable, bounded good-till-date BUY
execution. When enabled, marketable quantity may fill immediately and any
remainder may rest until the runtime-set expiration. Configuration limits that
lifetime to at most 15 minutes.

A verified current-cycle GTD BUY does not stop later independent BUYs. Before
continuing, execution reconciles every tracked order by ID and verifies that
its fills explain the account's positions and cash. Full submission cost
remains reserved through the batch, including unfilled quantity. Available
capital is bounded by both fresh exchange buying power and the batch's cash
budget; exchange collateral is not deducted twice. This continuation applies
only to current-cycle buys in distinct markets. Existing or unknown open
orders, unexplained state changes, and ambiguous outcomes still stop execution.
No working remainder is automatically cancelled or resubmitted.

Reports distinguish processing every accepted proposal with working remainders
from an early stop. `executionCompletion` identifies unattempted proposals and
the stop reason; `ORDER_WORKING` alone does not mean the batch stopped early.

`risk.allowPositionReductions` defaults to `true`. Set it to `false` in the
existing JSON configuration to reject canonical SELL YES and SELL NO actions,
including trims, zero-target exits, and emergency exits, with
`POSITION_REDUCTION_DISABLED`. BUY actions keep every existing safeguard; BUY
NO remains a BUY even when its exchange order side is SELL. Cancellations and
exchange settlement are unaffected. Validation excludes blocked sale proceeds
from allocation, and execution independently checks the actual order before
submission. Agent context (including custom prompts), previews, and observe
mode use the same capability. Blocked targets remain recorded as requested
reductions with their rejection and cannot be repaired into a policy override.

Merge this single field into the existing `risk` object of the complete file
selected by `MARKETCASTER_CONFIG_PATH`; no additional environment or prompt
setting is needed. Omission or `true` preserves existing behavior; other types
are invalid.

```json
{
  "risk": {
    "allowPositionReductions": false
  }
}
```

## Safety and correctness

Safety mechanisms remain part of the application:

- Observe mode submits no orders.
- Prices, quantities, fees, PnL, and exposure use decimal arithmetic.
- Account state is reconstructed from exchange data before and after decisions.
- Every live order refreshes market state, quote, order book, fees, and buying
  power and performs the exchange-specific preview or equivalent validation.
- Stale state, invalid settlement data, unsupported evidence, wide spreads,
  insufficient depth, and invalid sizes fail closed.
- Naked shorts, leverage, unmanaged or unbounded resting orders, duplicate
  orders, and automatic create-order retries are prohibited.
- Unexpected open orders disable live execution for that cycle.
- Partial fills are accepted and reconciled. An ambiguous submission stops the
  remaining cycle.
- Account-scoped state cannot cross exchange accounts or configured model
  profiles.
- Live cycles use a per-exchange lock and inspect durable journals before new
  account or order work.

The checked-in values in `config/default.json` are conservative reference
values. Review them and complete observe-mode validation before enabling live
execution.

## Installation

Requirements:

- Node.js 22.x
- npm
- A dedicated Polymarket US or Kalshi account with API credentials
- An OpenAI or Anthropic API key

Copy `.env.example` to `.env`, fill in the selected exchange credentials,
provider, model, and `LLM_API_KEY`, and leave `TRADING_MODE=observe` during
setup. MarketCaster reads process environment variables and does not load
`.env` automatically.

```sh
npm ci
npm run build
node --env-file=.env dist/src/index.js
```

All three commands run from this checkout.

## Observe and live modes

`TRADING_MODE=observe` performs account reconstruction, discovery, research,
target reconciliation, deterministic validation, simulated execution reporting,
and state/report persistence without submitting orders.

`TRADING_MODE=live` enables order submission only after the same checks pass. It
must be set explicitly. A missing or unrecognized value resolves to observe for
mode selection and is rejected by full environment validation when invalid.

Do not perform a live run merely to test configuration changes. Revoke the
selected exchange key if an active process must lose access immediately.

## Configuration

The full schema and reference defaults live in
[`config/default.json`](config/default.json). Runtime settings are supplied by
environment variables:

| Name                                | Use                                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| `EXCHANGE_ID`                       | `polymarket-us` or `kalshi`.                                    |
| `TRADING_MODE`                      | `observe` or `live`; defaults to `observe`.                     |
| `LLM_PROVIDER`                      | `openai` or `anthropic`.                                        |
| `LLM_BASE_URL`                      | Optional trusted OpenAI-compatible API root.                    |
| `LLM_MODEL`                         | Primary decision and repair model.                              |
| `LLM_CATALOG_MODEL`                 | Optional same-provider catalog model.                           |
| `LLM_API_KEY`                       | Selected provider API key.                                      |
| `POLYMARKET_KEY_ID`                 | Polymarket US key identifier.                                   |
| `POLYMARKET_SECRET_KEY`             | Polymarket US signing secret.                                   |
| `KALSHI_API_KEY_ID`                 | Kalshi API key identifier.                                      |
| `KALSHI_PRIVATE_KEY`                | Kalshi RSA private key.                                         |
| `KALSHI_API_BASE_URL`               | Optional official Kalshi Trade API v2 root.                     |
| `AGENT_MEMORY_SCOPE`                | Optional stable non-secret profile label.                       |
| `MARKETCASTER_STRATEGY_PATH`        | Optional trusted ESM policy factory implementing API version 1. |
| `MARKETCASTER_CONFIG_PATH`          | Optional complete configuration JSON file.                      |
| `MARKETCASTER_DECISION_PROMPT_PATH` | Optional decision system-prompt file.                           |
| `MARKETCASTER_REPORT_DIR`           | Optional report and persistent-state root.                      |

Relative override paths resolve from the process working directory. Absolute
paths are also supported. An override is used only when explicitly supplied:

```text
override supplied -> read and validate that exact file/path
override absent   -> use the checked-in default
```

An explicit missing file, malformed JSON document, or schema-invalid
configuration fails the cycle. MarketCaster never silently falls back from an
explicitly requested file. `MARKETCASTER_CONFIG_PATH` replaces the complete config
rather than merging fragments, which keeps validation deterministic.

`MARKETCASTER_REPORT_DIR` changes the root without changing report or state
schemas. Notes, beliefs, advisories, histories, journals, locks, and the shadow
ledger keep their existing relative layout beneath that root.

## Policy and prompt configuration

The reference system prompt is
[`config/prompt/decision/reference/system.md`](config/prompt/decision/reference/system.md).
The adjacent user template, research-tool descriptions, and tool messages define
the application contract. `MARKETCASTER_DECISION_PROMPT_PATH` selects an optional
system-prompt file. It does not replace the agent loop, deterministic validation,
or execution checks.

Set `MARKETCASTER_STRATEGY_PATH` to a trusted ESM policy factory when using custom
selection, forecast, or allocation behavior. See the
[policy extension contract](docs/strategy-policy.md) for supported hooks and
failure behavior. Configuration overrides replace complete JSON documents;
they do not merge fragments.

## Reports and persistent state

Each cycle is journaled under `reports/runs/<runId>/<cycleId>/` by default.
Decision, validation, order intent, provider rounds, execution outcome, and
reconciliation records are written incrementally. The report schemas are
unchanged by path overrides.

`reports/current/index.json` atomically points to one terminal run. A bounded
account history lives under `reports/history/`, while completed advisories,
notes, typed beliefs, plans, and shadow-ledger state retain their existing
account-scoped locations. Missing, corrupt, incompatible, or cross-account
advisory state is ignored or quarantined according to the existing fail-closed
rules; it never changes exchange balances or positions.

`reports/` is ignored by Git, but ignoring a path does not make it confidential.
Reports can contain account balances, positions, trades, evidence, model output,
and execution history. Restrict filesystem access and never upload report roots
as public build artifacts. Preserve the complete report root when changing its
location, including order-intent journals and lock files. Advisory caches do not
replace durable recovery records.

GitHub job summaries contain only a generic completion message by default.
Detailed reports remain in the configured report root. Setting
`MARKETCASTER_SUMMARY_DETAIL=full` includes account information in job summaries;
review access controls before enabling it in an automated environment.

## Development and contributions

Regression scripts are defined in `package.json`:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run check:overrides
```

`check:overrides` is a configuration regression check. It verifies default
loading, explicit config and prompt selection, report-root precedence, fallback
restoration after removing overrides, malformed configuration failure, and
explicit missing-file failure.

For runtime changes, use offline fixtures and mocked exchange/provider responses
with reference defaults and temporary override files. Do not use a live cycle
as a smoke test.

Contributions should keep exchange behavior, reconciliation, deterministic
validation, report formats, state isolation, and failure semantics explicit and
reviewable. Strategy experiments should use configuration or alternate prompts
when they do not require an engine change.

## License

Licensed under the [ISC License](LICENSE).
