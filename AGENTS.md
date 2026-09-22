# Contribution guidance

Keep exchange adapters, extension contracts, arithmetic, evidence and risk
validation, execution, reconciliation, persistence, and reporting reusable.
Document optional interfaces and validate explicitly configured extensions before
account initialization. Preserve the default reference behavior with no BUY
allocations and fail-closed handling of invalid configuration.

Use synthetic fixtures and examples. Never commit credentials or generated
account state, logs, reports, or real research records. Preserve unrelated work.
Do not run live trading during research, review, migration, or verification.

Run formatting, lint, type, build, and relevant regression checks from
`package.json`. Keep local validation free of exchange/provider credentials
and use mocked responses. Order-path changes must preserve durable intent
journaling, duplicate prevention, and ambiguous-submission recovery.
