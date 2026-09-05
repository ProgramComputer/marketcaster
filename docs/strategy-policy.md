# Deployment policy contract

Set `MARKETCASTER_STRATEGY_PATH` to a trusted local ESM module exporting a default
factory. The factory receives `strategyApi` and returns a version 1 `StrategyPolicy`.
These contracts are defined in `src/strategy/policy.ts`. Explicit import failures,
unsupported versions, or missing required hooks stop initialization.

The module can import adjacent deployment files. It receives Decimal arithmetic,
neutral family grouping, and evidence retrieval/parsing utilities. It receives
no exchange mutation methods. It runs as trusted local code, not in a sandbox.

- Selection returns a bounded research board and optional required inspections.
- Forecasting supplies source recipes and derived probabilities with a deployment
  agreement tolerance. A forecast is distinct from authoritative settlement.
- Allocation receives scalar copies of already-assessed candidates and returns
  candidate IDs with requested spends. The engine rejects unknown or repeated IDs,
  nonfinite amounts, candidate-bound violations, and aggregate overspending.
- Optional cooldown durations apply to typed execution failures. State is isolated
  by account, exchange, market, outcome side, and action; it contains no raw errors.

The reference configuration selects `EXCHANGE_RANK`, disables family ranking, and
requests no BUY allocations. It is useful for inspecting engine behavior. Custom
selection variants require an explicit module and have no automatic fallback.
No module is required to build the engine or run the synthetic checks.

A reusable workflow caller may provide `strategy_path` relative to its own
repository. Use a private caller for private modules, prompts, and generated
research artifacts. Pin both the reusable workflow and engine checkout to the
same tested commit. Keep strategy modules outside this public repository.

Allocation and forecast hooks do not bypass evidence validation, fresh quote and
depth checks, concentration and spend ceilings, durable intent journaling, or
exactly-once submission. Observe mode never submits orders.

Beliefs retain evidence URLs, inspected-market references, review/expiry times,
and explicit invalidation or supersession. Historical records remain available
for audit; expired and superseded beliefs are excluded from active context.
Reports preserve exchange order/fill identifiers. Unknown realized profit or
settlement payout remains unknown, and activity joins require exact order IDs.
