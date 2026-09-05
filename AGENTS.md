# Repository ownership

This is the public reusable MarketCaster engine. Keep exchange adapters, neutral
extension contracts, arithmetic, evidence and risk validation, execution,
reconciliation, persistence, and reporting here.

Production market selection, ranking, forecasting assumptions, source recipes,
allocation choices, tuned parameters, experiments, lessons, baselines, and account
outcomes belong in the private deployment repository. Add a generic extension
contract when a private policy needs a capability; do not embed the policy here.

Use synthetic fixtures and examples. Never commit credentials or generated
account state, logs, reports, or private policy modules. Preserve unrelated work.
Do not run live trading during research, review, migration, or verification.
