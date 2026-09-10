import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentState } from "../src/agent/agent-state.ts";
import { FileAgentMemory } from "../src/agent/memory.ts";
import {
  MutationProvenanceError,
  validateMutationProvenance,
  StagedMutationLedger,
  PersistenceTransaction,
} from "../src/agent/persistence-transaction.ts";
import { DecisionResearchTools } from "../src/llm/research-tools.ts";
import { DEFAULT_DECISION_LIMITS } from "../src/llm/decision-provider.ts";
import { loadPromptBundle } from "../src/config/prompts.ts";
import { reviewForecastMemory } from "../src/agent/forecast-memory.ts";
import { checkCycleForecastMemory } from "./check-memory-cycle.mjs";

const dir = await mkdtemp(join(tmpdir(), "marketcaster-memory-feedback-"));
const now = () => new Date("2026-01-02T12:00:00Z");
const scope = {
  observedCurrentUrls: new Set(["https://example.com/source"]),
  currentCycleMarketBasisSlugs: new Set(["fixture-market"]),
};
const validate = (reference) => {
  const issues = validateMutationProvenance(reference, scope);
  if (issues.length) throw new MutationProvenanceError(issues);
};
const readOrMissing = async (path) =>
  readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
try {
  const transaction = await PersistenceTransaction.begin({
    memoryFilePath: join(dir, "notes.jsonl"),
    stateFilePath: join(dir, "state.json"),
    stagingDirectory: join(dir, "staging"),
    migrationMarkerPath: join(dir, "marker.json"),
    manifestPath: join(dir, "manifest.json"),
    cycleId: "fixture",
    now,
  });
  const state = new FileAgentState({
    filePath: transaction.stagedStateFilePath,
    now,
  });
  const notes = new FileAgentMemory({
    filePath: transaction.stagedMemoryFilePath,
    now,
    maximumNotes: 1,
    maximumContextNotes: 1,
    maximumPersistedEvents: 2,
  });
  const ledger = new StagedMutationLedger();
  const beforePersist = (reference) => {
    validate(reference);
    ledger.record(reference);
  };
  const prompts = await loadPromptBundle();
  const tools = new DecisionResearchTools({
    prompts: prompts.research,
    agentStateHandler: (operation, signal) =>
      state.manage(operation, signal, beforePersist),
    agentNotesHandler: (operation) => notes.manage(operation, beforePersist),
  });
  const session = tools.createSession({
    ...DEFAULT_DECISION_LIMITS,
    maximumNoteOperations: 12,
  });
  const signal = new globalThis.AbortController().signal;
  const execute = async (name, input) =>
    JSON.parse((await session.execute(name, input, signal)).content);
  const denied = await execute("manage_state", {
    action: "SET_NEXT_CYCLE_PLAN",
    content: "Review synthetic contract",
    marketSlugs: ["fixture-market"],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.staged, false);
  assert.equal(denied.committed, false);
  assert.ok(
    denied.issues.some(
      (issue) =>
        issue.code === "MISSING_BASIS" &&
        /marketSlugs alone/u.test(issue.message),
    ),
  );
  assert.equal(denied.remainingMemoryOperations, 11);
  assert.equal(
    await readOrMissing(transaction.stagedStateFilePath),
    null,
    "Invalid mutation must not create even a staged file",
  );
  const repaired = await execute("manage_state", {
    action: "SET_NEXT_CYCLE_PLAN",
    content: "Review synthetic contract",
    marketSlugs: ["fixture-market"],
    basisMarketSlugs: ["fixture-market"],
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.staged, true);
  assert.equal(repaired.committed, false);
  assert.deepEqual(repaired.nextCyclePlan.basisMarketSlugs, ["fixture-market"]);
  assert.equal(
    await readOrMissing(join(dir, "state.json")),
    null,
    "Successful staging is not commitment",
  );
  const added = await state.manage(
    {
      action: "ADD_BELIEF",
      type: "EVENT_ANALYSIS",
      confidence: 50,
      content: "Synthetic thesis",
      marketSlugs: ["fixture-market"],
      evidenceUpdatedAt: now().toISOString(),
      invalidationConditions: [],
      evidenceUrls: ["https://example.com/source"],
      thesisId: "synthetic-thesis",
      familyKey: "synthetic-family",
      forecastYesProbability: 0,
    },
    signal,
    beforePersist,
  );
  await state.manage(
    {
      action: "UPDATE_BELIEF",
      beliefId: added.mutatedBeliefId,
      confidence: 51,
    },
    signal,
    beforePersist,
  );
  const belief = (await state.load()).beliefs[0];
  assert.deepEqual(belief.evidenceUrls, ["https://example.com/source"]);
  assert.equal(belief.forecastYesProbability, 0);
  const snapshot = await readFile(transaction.stagedStateFilePath, "utf8");
  scope.observedCurrentUrls.clear();
  await assert.rejects(
    state.manage(
      { action: "UPDATE_BELIEF", beliefId: belief.id, confidence: 52 },
      signal,
      beforePersist,
    ),
    MutationProvenanceError,
  );
  assert.equal(
    await readFile(transaction.stagedStateFilePath, "utf8"),
    snapshot,
    "An update validates inherited evidence before writing",
  );
  await state.manage(
    {
      action: "UPDATE_BELIEF",
      beliefId: belief.id,
      evidenceUrls: [],
      basisMarketSlugs: ["fixture-market"],
      status: "INVALIDATED",
    },
    signal,
    beforePersist,
  );
  assert.equal((await state.load()).beliefs.length, 0);
  assert.equal(
    (await state.loadAudit()).beliefs[0].status,
    "INVALIDATED",
    "Audit preserves inactive thesis revisions without presenting them as current context",
  );
  const noteAdded = await execute("manage_notes", {
    action: "ADD",
    content: "Synthetic note",
    basisMarketSlugs: ["fixture-market"],
  });
  await execute("manage_notes", {
    action: "UPDATE",
    noteId: noteAdded.mutatedNoteId,
    content: "Updated synthetic note",
  });
  await execute("manage_notes", {
    action: "UPDATE",
    noteId: noteAdded.mutatedNoteId,
    content: "Compacted synthetic note",
  });
  assert.deepEqual(
    (await notes.load()).notes[0].basisMarketSlugs,
    ["fixture-market"],
    "Note update and compaction preserve provenance",
  );
  assert.equal(ledger.validate(scope).valid, true);
  transaction.markMutated();
  await transaction.commit();
  assert.equal(
    (
      await new FileAgentState({
        filePath: join(dir, "state.json"),
        now,
      }).loadAudit()
    ).beliefs[0].thesisId,
    "synthetic-thesis",
  );
  assert.deepEqual(
    (
      await new FileAgentMemory({
        filePath: join(dir, "notes.jsonl"),
        now,
      }).load()
    ).notes[0].basisMarketSlugs,
    ["fixture-market"],
  );

  // Advisory write failures do not taint the terminal decision session. Order
  // authorization remains a separate responsibility of the cycle risk checks.
  const invalidUnrelatedNote = await execute("manage_notes", {
    action: "UPDATE",
    noteId: noteAdded.mutatedNoteId,
    content: "Unobserved synthetic update",
    basisMarketSlugs: ["uninspected-unrelated-market"],
  });
  assert.equal(invalidUnrelatedNote.ok, false);
  const submitted = await session.execute(
    "submit_trade_plan",
    {
      cycleSummary:
        "Synthetic target remains eligible despite unrelated bad note",
      portfolioTargets: [
        {
          marketSlug: "fixture-market",
          side: "YES",
          targetCostBasisFraction: "0.25",
          estimatedProbability: "0.8",
          probabilityLowerBound: "0.7",
          probabilityUpperBound: "0.9",
          maximumEntryPrice: "0.6",
          minimumExitPrice: null,
          confidence: "MEDIUM",
          thesis: "Synthetic probabilistic inference",
          settlementVerification: "Synthetic independent settlement",
          invalidationConditions: "Synthetic forecast revision",
          evidence: [],
          evidenceBundleIds: [],
        },
      ],
      candidateDispositions: [],
    },
    signal,
  );
  assert.equal(submitted.kind, "DECISION");
  assert.equal(
    submitted.decision.portfolioTargets[0].estimatedProbability.toFixed(),
    "0.8",
  );

  let forecastClock = "2026-01-02T12:01:00.000Z";
  const forecastState = new FileAgentState({
    filePath: join(dir, "forecast-state.json"),
    now: () => new Date(forecastClock),
  });
  const forecastNote = {
    action: "ADD_BELIEF",
    type: "EVENT_ANALYSIS",
    confidence: 60,
    content: "Synthetic analysis remains usable when a scalar needs review",
    marketSlugs: ["fixture-market"],
    evidenceUpdatedAt: forecastClock,
    invalidationConditions: [],
    forecastYesProbability: 0.2,
  };
  const forecastAdded = await forecastState.manage(forecastNote);
  const draft = (await forecastState.loadAudit()).beliefs[0];
  const review = (beliefs, submittedForecasts) =>
    reviewForecastMemory({
      beliefs,
      cycleStartedAt: "2026-01-02T12:00:00.000Z",
      submittedForecasts,
    });
  const target = (
    side,
    estimatedProbability,
    submittedAt = "2026-01-02T12:02:00.000Z",
  ) => ({
    marketSlug: "fixture-market",
    side,
    estimatedProbability,
    submittedAt,
  });
  assert.equal(review([draft], [target("YES", "0.2")]).issues.length, 0);
  assert.equal(
    review([draft], [target("NO", "0.8")]).issues.length,
    0,
    "Selected-side NO forecasts are converted to YES exactly once",
  );
  assert.equal(
    review(
      [{ ...draft, forecastYesProbability: 1 / 3 }],
      [target("YES", "0.333333333333333333333")],
    ).issues.length,
    0,
    "Decimal precision beyond the JSON memory scalar is not a disagreement",
  );
  const conflict = review([draft], [target("YES", "0.8")]);
  assert.equal(conflict.issues[0].originalYesProbability, 0.2);
  assert.equal(conflict.issues[0].targetYesProbability, 0.8);
  assert.equal(
    review(
      [draft],
      [target("YES", "0.8"), target("YES", "0.2", "2026-01-02T12:03:00.000Z")],
    ).issues.length,
    0,
    "The latest target revision replaces prior submissions for comparison",
  );
  const revisedDraft = {
    ...draft,
    forecastYesProbability: 0.7,
    updatedAt: "2026-01-02T12:04:00.000Z",
  };
  const laterNote = review([revisedDraft], [target("YES", "0.8")]);
  assert.equal(laterNote.issues.length, 0);
  assert.equal(
    laterNote.unverifiedBeliefs[0].reason,
    "BELIEF_AFTER_SUBMISSION",
    "A later forecast revision is not forced to match an earlier target",
  );
  assert.equal(
    review(
      [{ ...draft, updatedAt: "2026-01-01T12:00:00.000Z" }],
      [target("YES", "0.8")],
    ).issues.length,
    0,
    "Historical beliefs do not constrain current forecasts",
  );
  assert.equal(
    review([draft], []).unverifiedBeliefs[0].reason,
    "NO_MATCHING_SUBMISSION",
  );
  assert.equal(
    review(
      [{ ...draft, marketSlugs: ["fixture-market", "other-market"] }],
      [target("YES", "0.8")],
    ).issues[0].code,
    "AMBIGUOUS_FORECAST_MARKET",
  );

  forecastClock = "2026-01-02T12:03:00.000Z";
  const quarantined = await forecastState.quarantineForecasts(conflict.issues);
  assert.deepEqual(quarantined, [forecastAdded.mutatedBeliefId]);
  const quarantinedNote = (await forecastState.load()).beliefs[0];
  assert.equal(quarantinedNote.forecastYesProbability, null);
  assert.equal(quarantinedNote.content, forecastNote.content);
  assert.equal(quarantinedNote.forecastReview.originalYesProbability, 0.2);
  assert.equal(quarantinedNote.forecastReview.targetYesProbability, 0.8);
  assert.equal(
    conflict.issues[0].originalYesProbability,
    0.2,
    "Immutable review artifact retains the original value alongside the target",
  );
  forecastClock = "2026-01-02T12:04:00.000Z";
  await forecastState.manage({
    action: "UPDATE_BELIEF",
    beliefId: forecastAdded.mutatedBeliefId,
    forecastYesProbability: 0.7,
  });
  assert.deepEqual(
    await forecastState.quarantineForecasts(conflict.issues),
    [],
    "A delayed quarantine cannot clear a subsequent correction",
  );
  const correctedNote = (await forecastState.load()).beliefs[0];
  assert.equal(correctedNote.forecastYesProbability, 0.7);
  assert.equal(correctedNote.forecastReview, undefined);

  const selectorPath = join(dir, "selector.json");
  const selectorState = new FileAgentState({
    filePath: selectorPath,
    now,
    maximumContextBeliefs: 1,
    selectContextBeliefs: ({ beliefs, marketSlugs }) =>
      beliefs
        .filter((entry) =>
          entry.marketSlugs.some((slug) => marketSlugs.includes(slug)),
        )
        .map((entry) => entry.id)
        .slice(0, 1),
  });
  for (const slug of ["older-related", "newer-unrelated"])
    await selectorState.manage({
      action: "ADD_BELIEF",
      type: "EVENT_ANALYSIS",
      confidence: 50,
      content: slug,
      marketSlugs: [slug],
      evidenceUpdatedAt: now().toISOString(),
      invalidationConditions: [],
    });
  assert.equal(
    (await selectorState.load({ marketSlugs: ["older-related"] })).beliefs[0]
      .content,
    "older-related",
    "Selector receives all stored active beliefs before truncation",
  );
  const invalidSelector = new FileAgentState({
    filePath: selectorPath,
    now,
    selectContextBeliefs: () => ["unknown"],
  });
  await assert.rejects(invalidSelector.load(), /distinct active belief IDs/u);
  await checkCycleForecastMemory(dir, prompts);
  globalThis.console.log(
    "Memory feedback, atomic staging, merged provenance, audit history, and context contract checks passed.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
