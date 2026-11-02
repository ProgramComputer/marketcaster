# Review diagnostics

Cycles with report writing enabled produce three optional JSON files beside the
run journal: `execution-diagnostics.json`, `history-attribution.json`, and
`evidence-receipts.json`. They contain account comparisons and reconciliation
results, entry provenance and exclusion reasons, and receipts derived from
already retained research responses.

These files are review byproducts. They are not registered in the mandatory
journal manifest and are not loaded into model requests, memory, plans, cycle
reports, or previous-cycle summaries. They add no research requests. Independent
artifact writes run after cycle processing, including failure handling; a failed
write neither changes a completed result nor masks the original failure.

Evidence receipts preserve available structured metadata. Missing source dates,
locations, and forecast or observation designations remain unknown. Encrypted
provider results remain opaque. Receipts do not infer forecast attribution or
change evidence validation. Original transcripts remain the underlying record.

Collection redacts known credential values and common sensitive fields. Event,
text, depth, and size limits are explicit; omitted events and truncated values
are counted. Missing files, incomplete metadata, and truncated receipts must not
be interpreted as proof that an event did not happen. Runner loss or failure to
store the resulting files can still prevent review.

Recovered entry history is separate from these diagnostics: the history reader
accepts original intent and terminal resolution records through the existing
recovery verifier. It deduplicates known executions and uses original fill or
submission timing, never the later repair time. Unavailable decision fields
remain absent. Original journal records are not rewritten.

Embedding callers can set `CycleDependencies.reviewDiagnostics` to `false`.
Optional execution and history observers must not perform decision work or
mutate their inputs. Deployment owners control access and retention for all run
evidence; account data and diagnostic files must not be committed to source.
