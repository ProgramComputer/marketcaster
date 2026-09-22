# Policy extension contract

Set `MARKETCASTER_STRATEGY_PATH` to a trusted local ESM module exporting a default
factory. The factory receives `strategyApi` and returns a version 1 `StrategyPolicy`.
These contracts are defined in `src/strategy/policy.ts`. Explicit import failures,
unsupported versions, or missing required hooks stop initialization.

The module receives Decimal arithmetic, neutral family grouping, and guarded
evidence retrieval utilities. It receives no exchange mutation methods. Modules
run as trusted local code, not in a sandbox.

- Selection returns a bounded research board and optional required inspections.
- Forecasting returns derived probabilities and an agreement tolerance. A forecast
  is distinct from an observed source fact and authoritative settlement.
- Allocation receives scalar copies of already-assessed candidates and returns
  candidate IDs with requested spends. The engine rejects unknown or repeated IDs,
  nonfinite amounts, candidate-bound violations, and aggregate overspending.
- Optional cooldown durations apply to typed execution failures. State is isolated
  by account, exchange, market, outcome side, and action; it contains no raw errors.
- An optional version 1 `evidenceContentAdapter` can extract text from a fetched
  response. Its synchronous `extractText` method receives `source`, `requestedUrl`,
  `finalUrl`, and `contentType`, and returns text or `undefined`. The engine retains
  URL and redirect validation, response-size and timeout bounds, source identity, retrieval
  timestamps, and raw-content provenance. Returning text does not authorize another
  retrieval or make a derived estimate a source quotation.

The reference configuration selects `EXCHANGE_RANK`, disables family ranking, and
requests no BUY allocations. It is useful for inspecting application behavior.
Custom selection variants require an explicit module and have no automatic
fallback. No module is required to build or run the synthetic checks.

Use absolute paths or paths relative to the process working directory. Explicitly
configured modules, configuration files, and prompt files must exist and validate.
Keep credentials out of source files and logs.

Allocation and forecast hooks do not bypass evidence validation, fresh quote and
depth checks, concentration and spend ceilings, durable intent journaling, or
duplicate-submission guards. Observe mode never submits orders.

Beliefs retain evidence URLs, inspected-market references, review/expiry times,
and explicit invalidation or supersession. Historical records remain available
for audit; expired and superseded beliefs are excluded from active context.
Reports preserve exchange order/fill identifiers. Unknown realized profit or
settlement payout remains unknown, and activity joins require exact order IDs.
