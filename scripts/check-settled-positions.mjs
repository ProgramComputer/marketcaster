import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import {
  loadEntryFills,
  summarizeSettledPositions,
} from "../src/agent/settled-positions.ts";
import { buildAgentContext } from "../src/agent/context-builder.ts";
import { RepositoryConfigSchema } from "../src/config/schema.ts";
import { mapActivity } from "../src/exchanges/polymarket-us/mappers.ts";
import { ActivitySchema } from "../src/exchanges/polymarket-us/schemas.ts";

// Wholly synthetic markets and accounts; nothing here contacts an exchange.
const fill = (marketSlug, enteredAt, overrides = {}) => ({
  marketSlug,
  side: "YES",
  action: "BUY",
  quantity: new Decimal(10),
  averagePrice: new Decimal("0.40"),
  fees: new Decimal("0.10"),
  enteredAt: new Date(enteredAt),
  ...overrides,
});
const resolution = (marketSlug, realizedPnl, resolvedAt) => ({
  kind: "RESOLUTION",
  marketSlug,
  realizedPnl: new Decimal(realizedPnl),
  resolvedAt: new Date(resolvedAt),
});

// Settlements join only to the recorded BUY fills that opened them.
{
  const positions = summarizeSettledPositions(
    [
      resolution("alpha", "1", "2040-01-02T00:00:00Z"),
      resolution("alpha", "11.9", "2040-01-03T00:00:00Z"),
      resolution("bravo", "0", "2040-01-03T00:00:00Z"),
      resolution("charlie", "-4", "2040-01-03T00:00:00Z"),
      resolution("delta", "-4", "2040-01-03T00:00:00Z"),
      resolution("echo", "-4", "2040-01-03T00:00:00Z"),
      resolution("foxtrot", "-4.1", "2040-01-04T00:00:00Z"),
    ],
    [
      fill("alpha", "2040-01-01T13:00:00Z"),
      fill("alpha", "2040-01-01T14:00:00Z", {
        quantity: new Decimal(30),
        averagePrice: new Decimal("0.20"),
        estimatedProbability: new Decimal("0.6"),
        authorizationProbability: new Decimal("0.55"),
      }),
      fill("bravo", "2040-01-01T13:00:00Z", { side: "NO" }),
      fill("charlie", "2040-01-01T13:00:00Z"),
      fill("charlie", "2040-01-01T15:00:00Z", { action: "SELL" }),
      fill("delta", "2040-01-01T13:00:00Z"),
      fill("delta", "2040-01-01T15:00:00Z", { side: "NO" }),
      fill("echo", "2040-01-05T13:00:00Z"),
      fill("foxtrot", "2040-01-01T13:00:00Z"),
    ],
  );
  assert.deepEqual(
    positions.map((position) => position.marketSlug),
    ["foxtrot", "alpha", "bravo", "charlie", "delta"],
    "newest settlement first; fills after settlement are omitted",
  );
  assert.equal(
    positions.find((position) => position.marketSlug === "delta").side,
    undefined,
    "a market bought on both sides has no single side",
  );
  const alpha = positions.find((position) => position.marketSlug === "alpha");
  assert.equal(alpha.outcome, "WON");
  assert.equal(alpha.realizedPnl.toString(), "11.9", "latest settlement wins");
  assert.equal(alpha.quantity.toString(), "40");
  assert.equal(alpha.averageEntryPrice.toString(), "0.25");
  assert.equal(alpha.costUsd.toString(), "10.2", "notional plus fees");
  assert.equal(alpha.firstEnteredAt.toISOString(), "2040-01-01T13:00:00.000Z");
  assert.equal(alpha.estimatedProbability.toString(), "0.6");
  assert.equal(alpha.authorizationProbability.toString(), "0.55");
  const bravo = positions.find((position) => position.marketSlug === "bravo");
  assert.equal(bravo.side, "NO");
  assert.equal(bravo.outcome, "UNKNOWN", "zero realized PnL is not a result");
  assert.equal(bravo.estimatedProbability, undefined);
  assert.equal(
    positions.find((position) => position.marketSlug === "foxtrot").outcome,
    "LOST",
  );
}

// Fills come from the history index; each entry's own report supplies the
// probability, and unreadable or out-of-root reports only drop probabilities.
{
  const root = await mkdtemp(join(tmpdir(), "marketcaster-settled-"));
  try {
    const scope = "account-fixture";
    const execution = (marketSlug, filledQuantity) => ({
      marketSlug,
      side: "YES",
      action: "BUY",
      quantity: "10",
      canonicalLimitPrice: "0.5",
      executionPolicy: "IOC",
      status: "FILLED",
      filledQuantity,
      averageFillPrice: "0.45",
      fees: "0.05",
      finalState: "FILLED",
    });
    const entry = (cycleId, completedAt, reportPath, executions) => ({
      runId: "run-1",
      cycleId,
      reportPath,
      mode: "live",
      status: "SUCCESS",
      outcome: "FILLED",
      completedAt,
      account: {},
      performanceChange: {},
      exchangeObservedActivity: { after: {}, newlyObserved: {} },
      agentState: {},
      agentStateChanges: {},
      currentCycleExecutions: executions,
    });
    const reportPath = "runs/run-1/cycle-a/cycle-report.json";
    await mkdir(join(root, "runs/run-1/cycle-a"), { recursive: true });
    await writeFile(
      join(root, reportPath),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        cycleId: "cycle-a",
        accountScope: scope,
        recordedAt: "2040-01-01T00:00:00.000Z",
        kind: "cycle-report",
        data: {
          risk: {
            accepted: [
              {
                marketSlug: "alpha",
                side: "YES",
                action: "BUY",
                estimatedProbability: "0.7",
                riskAdjustedProbability: "0.65",
              },
            ],
          },
        },
      }),
    );
    await mkdir(join(root, "history/polymarket-us", scope), {
      recursive: true,
    });
    await writeFile(
      join(root, "history/polymarket-us", scope, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        exchangeId: "polymarket-us",
        accountScope: scope,
        updatedAt: "2040-01-02T00:00:00.000Z",
        maximumEntries: 100,
        entries: [
          entry("cycle-b", "2040-01-02T00:00:00.000Z", "../outside.json", [
            execution("bravo", "3"),
            execution("charlie", "0"),
            { malformed: true },
          ]),
          // Points at another cycle's report, so it borrows no probability.
          entry("cycle-c", "2040-01-01T12:00:00.000Z", reportPath, [
            execution("alpha", "4"),
          ]),
          entry("cycle-a", "2040-01-01T00:00:00.000Z", reportPath, [
            execution("alpha", "10"),
          ]),
        ],
      }),
    );
    const fills = await loadEntryFills({
      rootDirectory: root,
      exchangeId: "polymarket-us",
      accountScope: scope,
    });
    assert.deepEqual(
      fills.map((item) => item.marketSlug),
      ["bravo", "alpha", "alpha"],
      "unfilled and malformed executions are skipped",
    );
    assert.equal(fills[0].estimatedProbability, undefined);
    assert.equal(fills[1].estimatedProbability, undefined);
    assert.equal(fills[2].estimatedProbability.toString(), "0.7");
    assert.equal(fills[2].authorizationProbability.toString(), "0.65");
    assert.equal(fills[2].enteredAt.toISOString(), "2040-01-01T00:00:00.000Z");
    assert.deepEqual(
      await loadEntryFills({
        rootDirectory: root,
        exchangeId: "kalshi",
        accountScope: scope,
      }),
      [],
      "a missing history index is no history",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A later, verified terminal resolution restores the original entry even if
// the completed-history index omitted the ambiguous cycle or does not exist.
// Every ID, timestamp, quantity, and probability in these fixtures is synthetic.
{
  const root = await mkdtemp(join(tmpdir(), "marketcaster-recovered-entry-"));
  const scope = "account-fixture";
  const input = {
    rootDirectory: root,
    exchangeId: "polymarket-us",
    accountScope: scope,
  };
  const startedAt = "2040-01-01T00:00:00.000Z";
  const filledAt = "2040-01-01T00:00:01.000Z";
  const repairTime = "2040-01-04T00:00:00.000Z";
  const kind = "order-resolution.source-run.source-cycle.0001";
  const order = {
    marketId: { exchange: "polymarket-us", value: "fixture-market" },
    marketSlug: "recovered-market",
    side: "YES",
    action: "BUY",
    canonicalLimitPrice: "0.3",
    quantity: "10",
    executionPolicy: "IOC",
  };
  const validated = {
    order,
    proposal: {
      marketSlug: order.marketSlug,
      side: "YES",
      action: "BUY",
      estimatedProbability: "0.7",
    },
    authorizationProbability: "0.66",
  };
  const intentData = {
    intentId: "source-cycle-intent-1",
    attemptSequence: 1,
    submittedAt: startedAt,
    validated,
  };
  const result = {
    status: "PARTIAL",
    filledQuantity: "4",
    averageFillPrice: "0.25",
    fees: "0.1",
    finalState: "CANCELED",
  };
  const proofData = {
    target: { runId: "source-run", cycleId: "source-cycle", attemptId: "0001" },
    attemptSequence: 1,
    submittedAt: startedAt,
    validated: { order },
    result,
    evidence: {
      window: { from: startedAt, to: "2040-01-01T00:01:00.000Z" },
      trades: [
        {
          tradeId: "fixture-trade",
          quantity: "4",
          price: "0.25",
          createdAt: filledAt,
        },
      ],
    },
  };
  const envelope = (
    runId,
    cycleId,
    artifactKind,
    data,
    accountScope = scope,
  ) => ({
    schemaVersion: 1,
    runId,
    cycleId,
    accountScope,
    kind: artifactKind,
    recordedAt: runId === "source-run" ? startedAt : repairTime,
    data,
  });
  const sourceDirectory = join(root, "runs/source-run/source-cycle");
  const repairDirectory = join(root, "runs/repair-run/repair-cycle");
  const sourceManifest = {
    schemaVersion: 1,
    runId: "source-run",
    cycleId: "source-cycle",
    mode: "live",
    exchangeId: "polymarket-us",
    accountScope: scope,
    stage: "AMBIGUOUS",
    startedAt,
    updatedAt: startedAt,
    completedAt: "2040-01-01T00:01:00.000Z",
    history: [],
    artifacts: {
      "order.0001.intent": "orders/0001-intent.json",
      "order.0001.submission": "orders/0001-submission.json",
    },
  };
  const repairManifest = {
    ...sourceManifest,
    runId: "repair-run",
    cycleId: "repair-cycle",
    stage: "SUCCESS",
    startedAt: repairTime,
    updatedAt: repairTime,
    completedAt: repairTime,
    artifacts: { [kind]: "resolutions/proof.json" },
  };
  const sourceEnvelope = envelope(
    "source-run",
    "source-cycle",
    "order.0001.intent",
    intentData,
  );
  const sourceSubmission = envelope(
    "source-run",
    "source-cycle",
    "order.0001.submission",
    {
      ...intentData,
      kind: "THREW",
      orderId: "fixture-order",
    },
  );
  const proofEnvelope = envelope("repair-run", "repair-cycle", kind, proofData);
  const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
  const historyPath = join(root, "history/polymarket-us", scope, "index.json");
  const history = (executions) => ({
    schemaVersion: 1,
    exchangeId: "polymarket-us",
    accountScope: scope,
    updatedAt: startedAt,
    maximumEntries: 100,
    entries: [
      {
        runId: "source-run",
        cycleId: "source-cycle",
        reportPath: "runs/source-run/source-cycle/cycle-report.json",
        mode: "live",
        status: "AMBIGUOUS",
        outcome: "AMBIGUOUS",
        completedAt: "2040-01-01T00:01:00.000Z",
        account: {},
        performanceChange: {},
        exchangeObservedActivity: { after: {}, newlyObserved: {} },
        agentState: {},
        agentStateChanges: {},
        currentCycleExecutions: executions,
      },
    ],
  });
  const ordinary = {
    ...order,
    intentId: intentData.intentId,
    orderId: "fixture-order",
    status: "PARTIAL",
    filledQuantity: "4",
    averageFillPrice: "0.25",
    fees: "0.1",
    tradeIds: ["fixture-trade"],
  };
  try {
    await mkdir(join(sourceDirectory, "orders"), { recursive: true });
    await mkdir(join(repairDirectory, "resolutions"), { recursive: true });
    await mkdir(join(root, "history/polymarket-us", scope), {
      recursive: true,
    });
    const reset = async () => {
      await writeJson(join(sourceDirectory, "manifest.json"), sourceManifest);
      await writeJson(
        join(sourceDirectory, "orders/0001-intent.json"),
        sourceEnvelope,
      );
      await writeJson(
        join(sourceDirectory, "orders/0001-submission.json"),
        sourceSubmission,
      );
      await writeJson(join(repairDirectory, "manifest.json"), repairManifest);
      await writeJson(
        join(repairDirectory, "resolutions/proof.json"),
        proofEnvelope,
      );
    };
    await reset();
    const immutableIntent = await readFile(
      join(sourceDirectory, "orders/0001-intent.json"),
      "utf8",
    );
    const immutableProof = await readFile(
      join(repairDirectory, "resolutions/proof.json"),
      "utf8",
    );
    const diagnostics = [];
    const recovered = await loadEntryFills({
      ...input,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    assert.equal(
      recovered.length,
      1,
      "verified original entry survives a missing history index",
    );
    assert.equal(
      recovered[0].quantity.toString(),
      "4",
      "partial quantity comes from the terminal proof",
    );
    assert.equal(recovered[0].averagePrice.toString(), "0.25");
    assert.equal(recovered[0].fees.toString(), "0.1");
    assert.equal(
      recovered[0].enteredAt.toISOString(),
      filledAt,
      "repair time must never become entry time",
    );
    assert.equal(recovered[0].estimatedProbability.toString(), "0.7");
    assert.equal(recovered[0].authorizationProbability.toString(), "0.66");
    assert.deepEqual(recovered[0].tradeIds, ["fixture-trade"]);
    const observerMutation = await loadEntryFills({
      ...input,
      onDiagnostic: (event) => event.tradeIds?.push("observer-only-id"),
    });
    assert.deepEqual(
      observerMutation[0].tradeIds,
      ["fixture-trade"],
      "diagnostic observers cannot mutate fill identities",
    );
    assert.deepEqual(
      await loadEntryFills({
        ...input,
        onDiagnostic: async () => {
          throw new Error("async diagnostic unavailable");
        },
      }),
      recovered,
    );
    assert(diagnostics.some((event) => event.reason === "HISTORY_UNAVAILABLE"));
    assert(
      diagnostics.some(
        (event) =>
          event.reason === "ENTRY_INCLUDED" &&
          event.attemptId === "0001" &&
          event.probabilitySource === "ORIGINAL_DURABLE_INTENT",
      ),
    );
    const positions = summarizeSettledPositions(
      [
        resolution(order.marketSlug, "2.9", "2040-01-02T00:00:00Z"),
        resolution("unattributed-market", "-1", "2040-01-02T00:00:00Z"),
      ],
      recovered,
      (event) => diagnostics.push(event),
    );
    assert.equal(
      positions.length,
      1,
      "a resolution recorded after settlement still restores the original earlier entry",
    );
    assert.equal(positions[0].costUsd.toString(), "1.1");
    assert(
      diagnostics.some(
        (event) =>
          event.reason === "NO_RECORDED_BUY_ENTRY" &&
          event.marketSlug === "unattributed-market",
      ),
    );
    assert.deepEqual(
      await loadEntryFills({
        ...input,
        onDiagnostic: () => {
          throw new Error("diagnostic unavailable");
        },
      }),
      recovered,
    );
    assert.deepEqual(
      summarizeSettledPositions(
        [resolution(order.marketSlug, "2.9", "2040-01-02T00:00:00Z")],
        recovered,
        () => {
          throw new Error("diagnostic unavailable");
        },
      ),
      positions,
    );
    assert.equal(
      await readFile(join(sourceDirectory, "orders/0001-intent.json"), "utf8"),
      immutableIntent,
    );
    assert.equal(
      await readFile(join(repairDirectory, "resolutions/proof.json"), "utf8"),
      immutableProof,
    );

    await writeJson(historyPath, history([]));
    assert.equal(
      (await loadEntryFills(input)).length,
      1,
      "an empty original execution list does not hide recovery",
    );
    await writeJson(historyPath, { ...history([]), entries: [] });
    assert.equal(
      (await loadEntryFills(input)).length,
      1,
      "recovery does not require an index entry for the original cycle",
    );
    await writeJson(historyPath, { invalid: true });
    assert.equal(
      (await loadEntryFills(input)).length,
      1,
      "invalid history does not invalidate independent verified recovery",
    );
    await writeJson(historyPath, history([ordinary]));
    const duplicateEvents = [];
    assert.equal(
      (
        await loadEntryFills({
          ...input,
          onDiagnostic: (event) => duplicateEvents.push(event),
        })
      ).length,
      1,
      "ordinary order/intent identity is counted once",
    );
    assert(duplicateEvents.some((event) => event.reason === "DUPLICATE_ENTRY"));
    await writeJson(historyPath, history([ordinary, ordinary]));
    assert.equal(
      (await loadEntryFills(input)).length,
      1,
      "duplicate ordinary execution identities are also counted once",
    );
    await writeJson(
      historyPath,
      history([
        {
          ...ordinary,
          orderId: "different-order",
          intentId: "different-intent",
        },
      ]),
    );
    assert.equal(
      (await loadEntryFills(input)).length,
      1,
      "shared exchange trade IDs also prevent double counting",
    );
    await writeJson(
      historyPath,
      history([{ ...ordinary, filledQuantity: "3" }]),
    );
    const conflicts = [];
    assert.equal(
      (
        await loadEntryFills({
          ...input,
          onDiagnostic: (event) => conflicts.push(event),
        })
      )[0].quantity.toString(),
      "3",
      "a conflicting recovered identity does not overwrite ordinary history",
    );
    assert(conflicts.some((event) => event.reason === "CONFLICTING_ENTRY"));
    await writeJson(historyPath, history([]));

    await writeJson(join(sourceDirectory, "orders/0001-intent.json"), {
      ...sourceEnvelope,
      data: { ...intentData, validated: { order } },
    });
    assert.equal(
      (await loadEntryFills(input))[0].estimatedProbability,
      undefined,
      "unavailable original forecast stays unavailable",
    );
    await reset();
    await writeJson(join(repairDirectory, "resolutions/proof.json"), {
      ...proofEnvelope,
      data: { ...proofData, evidence: undefined },
    });
    assert.equal(
      (await loadEntryFills(input))[0].enteredAt.toISOString(),
      startedAt,
      "without complete trade timing, the original submission time is retained",
    );
    for (const tradeOverrides of [
      { marketSlug: "wrong-market" },
      { side: "NO" },
      { action: "SELL" },
      { orderId: "wrong-order" },
      { state: "TRADE_STATE_BUSTED" },
      { aggressor: false },
      // Journal timestamps require canonical UTC. This is the same instant,
      // but must not slip through a lexical window comparison.
      { createdAt: "2040-01-01T01:00:01.000+01:00" },
    ]) {
      await writeJson(join(repairDirectory, "resolutions/proof.json"), {
        ...proofEnvelope,
        data: {
          ...proofData,
          evidence: {
            ...proofData.evidence,
            trades: [{ ...proofData.evidence.trades[0], ...tradeOverrides }],
          },
        },
      });
      const entry = (await loadEntryFills(input))[0];
      assert.equal(
        entry.enteredAt.toISOString(),
        startedAt,
        "contradictory or noncanonical trade evidence cannot supply a fill timestamp",
      );
      assert.equal(
        entry.tradeIds,
        undefined,
        "contradictory trade evidence cannot supply exchange identity",
      );
    }

    const exclusions = [
      [
        "missing positive fill price",
        {
          ...proofEnvelope,
          data: {
            ...proofData,
            result: { ...result, averageFillPrice: undefined },
          },
        },
      ],
      [
        "mismatched attempt sequence",
        { ...proofEnvelope, data: { ...proofData, attemptSequence: 2 } },
      ],
      [
        "mismatched original cycle",
        {
          ...proofEnvelope,
          data: {
            ...proofData,
            target: { ...proofData.target, cycleId: "wrong-cycle" },
          },
        },
      ],
      [
        "wrong proof account scope",
        { ...proofEnvelope, accountScope: "different-account" },
      ],
      [
        "conflicting order fingerprint",
        {
          ...proofEnvelope,
          data: {
            ...proofData,
            validated: { order: { ...order, quantity: "11" } },
          },
        },
      ],
    ];
    for (const [label, proof] of exclusions) {
      await reset();
      await writeJson(join(repairDirectory, "resolutions/proof.json"), proof);
      assert.deepEqual(await loadEntryFills(input), [], label);
    }
    await reset();
    await writeJson(join(repairDirectory, "resolutions/proof.json"), {
      ...proofEnvelope,
      data: {
        ...proofData,
        result: {
          status: "NO_FILL",
          filledQuantity: "0",
          fees: "0",
          finalState: "CANCELED",
        },
      },
    });
    const zeroEvents = [];
    assert.deepEqual(
      await loadEntryFills({
        ...input,
        onDiagnostic: (event) => zeroEvents.push(event),
      }),
      [],
    );
    assert(zeroEvents.some((event) => event.reason === "ZERO_FILL"));
    await reset();
    await writeJson(join(sourceDirectory, "orders/0001-intent.json"), {
      ...sourceEnvelope,
      accountScope: "different-account",
    });
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "wrong intent account scope cannot authorize an entry",
    );
    await reset();
    await writeJson(join(repairDirectory, "manifest.json"), {
      ...repairManifest,
      exchangeId: "kalshi",
    });
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "foreign exchange resolution is excluded",
    );
    await reset();
    await writeJson(join(repairDirectory, "manifest.json"), {
      ...repairManifest,
      accountScope: "different-account",
    });
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "foreign account journal is excluded",
    );
    await reset();
    await rm(join(sourceDirectory, "orders/0001-intent.json"));
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "account facts without the durable original intent cannot synthesize an entry",
    );
    await reset();
    await writeJson(join(repairDirectory, "manifest.json"), {
      ...repairManifest,
      artifacts: { [kind]: "../outside-proof.json" },
    });
    await writeJson(
      join(root, "runs/repair-run/outside-proof.json"),
      proofEnvelope,
    );
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "a manifest path escape cannot supply recovery evidence",
    );
    await reset();
    await writeJson(join(sourceDirectory, "manifest.json"), {
      ...sourceManifest,
      artifacts: {
        ...sourceManifest.artifacts,
        "order.0001.intent": "../outside-intent.json",
      },
    });
    assert.deepEqual(
      await loadEntryFills(input),
      [],
      "an escaped original intent path remains excluded even if a local intent file exists",
    );
    await reset();
    const duplicateDirectory = join(root, "runs/duplicate-repair/repair-cycle");
    await mkdir(duplicateDirectory, { recursive: true });
    await writeJson(join(duplicateDirectory, "manifest.json"), {
      ...repairManifest,
      runId: "duplicate-repair",
      artifacts: { [kind]: "proof.json" },
    });
    for (const candidateResult of [
      result,
      { ...result, filledQuantity: "5" },
    ]) {
      await writeJson(join(duplicateDirectory, "proof.json"), {
        ...proofEnvelope,
        runId: "duplicate-repair",
        data: { ...proofData, result: candidateResult },
      });
      assert.deepEqual(
        await loadEntryFills(input),
        [],
        "multiple resolution candidates are excluded, including conflicting proofs",
      );
    }
    assert.deepEqual(
      await loadEntryFills({ ...input, accountScope: "different-account" }),
      [],
      "the caller's scope cannot borrow another account's entries",
    );
    assert.deepEqual(
      await loadEntryFills({ ...input, accountScope: "../escape" }),
      [],
      "invalid account scopes fail closed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The critical-learning policy receives settled positions, and the engine
// bounds the scorecard it returns.
{
  const zero = new Decimal(0);
  const input = (criticalLearningPolicy) => ({
    observedAt: new Date("2040-01-05T00:00:00Z"),
    exchangeId: "polymarket-us",
    exchangeName: "Fixture",
    account: {
      observedAt: new Date("2040-01-05T00:00:00Z"),
      currentBalance: new Decimal(100),
      buyingPower: new Decimal(100),
      assetNotional: zero,
      assetAvailable: zero,
      openOrderValue: zero,
      unsettledFunds: zero,
      marginRequirement: zero,
      positions: [],
      openOrders: [],
      recentActivities: [],
    },
    marketCatalog: { count: 0, categoryCounts: {} },
    preloadedMarkets: [],
    riskConstraints: {
      maximumPositionCostBasisFraction: new Decimal("0.5"),
      maximumCycleSpendFraction: new Decimal("0.5"),
      maximumExecutionSpread: new Decimal("0.1"),
      kellyFraction: new Decimal("0.5"),
      uncertaintyBoundWeight: new Decimal("0.25"),
      duplicateWindowMinutes: 30,
      minimumIndependentSources: 1,
      allowNakedShorts: false,
      emergencyExitEnabled: false,
      managedRestingBuyOrders: { enabled: false, maximumLifetimeMinutes: 15 },
    },
    criticalLearningPolicy,
    settledPositions: [{ marketSlug: "alpha" }],
  });
  const learning = (scorecard) => ({
    advisoryOnly: true,
    realizedOutcomeSampleSize: 0,
    profitableMarketSlugs: [],
    losingMarketSlugs: [],
    winningPatternAssessment: "none",
    losingPatternAssessment: "none",
    positionManagementReminders: [],
    ...(scorecard === undefined ? {} : { scorecard }),
  });
  const scorecard = {
    basis: "Synthetic settlements.",
    settledPositions: 1,
    groups: [
      {
        dimension: "side",
        group: "YES",
        settled: 1,
        won: 1,
        lost: 0,
        unknown: 0,
        costUsd: "10.2",
        realizedPnlUsd: "-1.5",
      },
    ],
    calibration: [
      {
        band: "50-75%",
        settled: 1,
        won: 1,
        meanProbability: "0.6",
        meanEntryPrice: "0.25",
      },
    ],
  };
  let received;
  const context = buildAgentContext(
    input((performance, previousCycle, settledPositions) => {
      received = settledPositions;
      return learning(scorecard);
    }),
  );
  assert.deepEqual(received, [{ marketSlug: "alpha" }]);
  assert.deepEqual(context.criticalLearning.scorecard, scorecard);
  assert.throws(
    () =>
      buildAgentContext(
        input(() => learning({ ...scorecard, basis: "x".repeat(401) })),
      ),
    /settlement scorecard is invalid/u,
  );
  assert.throws(
    () =>
      buildAgentContext(
        input(() =>
          learning({
            ...scorecard,
            groups: [{ ...scorecard.groups[0], won: 1.5 }],
          }),
        ),
      ),
    /settlement scorecard is invalid/u,
  );
  assert.equal(
    buildAgentContext(input(() => learning())).criticalLearning.scorecard,
    undefined,
    "a policy may omit the scorecard",
  );
}

// A settlement reported at zero realized PnL is derived from the resolution
// side and the position before settlement; reported results are unchanged.
{
  const amount = (value) => ({ value, currency: "USD" });
  const settle = (marketSlug, side, before, afterRealized = "0") =>
    mapActivity(
      ActivitySchema.parse({
        type: "ACTIVITY_TYPE_POSITION_RESOLUTION",
        positionResolution: {
          marketSlug,
          side,
          updateTime: "2040-01-03T00:00:00Z",
          beforePosition: { realized: amount("0"), ...before },
          afterPosition: { realized: amount(afterRealized), cost: amount("1") },
        },
      }),
    )[0].realizedPnl.toString();
  assert.equal(
    settle("alpha", "POSITION_RESOLUTION_SIDE_SHORT", {
      netPositionDecimal: "-80",
      cost: amount("20.8"),
      baseCost: amount("20"),
    }),
    "60",
    "a NO position on a market that settled NO is paid",
  );
  assert.equal(
    settle("bravo", "POSITION_RESOLUTION_SIDE_SHORT", {
      netPositionDecimal: "50",
      cost: amount("12.5"),
      baseCost: null,
    }),
    "-12.5",
    "a YES position on a market that settled NO loses its cost",
  );
  assert.equal(
    settle("charlie", "POSITION_RESOLUTION_SIDE_LONG", {
      netPosition: "10",
      cost: amount("4"),
    }),
    "6",
  );
  assert.equal(
    settle(
      "delta",
      "POSITION_RESOLUTION_SIDE_SHORT",
      { netPositionDecimal: "10", cost: amount("4") },
      "7.5",
    ),
    "7.5",
    "a reported result is kept",
  );
  assert.equal(
    settle("echo", "POSITION_RESOLUTION_SIDE_UNSPECIFIED", {
      netPositionDecimal: "10",
      cost: amount("4"),
    }),
    "0",
    "an unknown side leaves zero",
  );
}

// History is on by default and can be turned off.
{
  const agent = (overrides) => ({
    ...RepositoryConfigSchema.shape.agent.parse({
      maximumRounds: 10,
      maximumWebSearches: 1,
      maximumProviderWebSearchesPerResponse: 1,
      maximumEvidenceSourceReadRequests: 1,
      maximumMarketDiscoveryRequests: 1,
      maximumMarketDetailRequests: 1,
      maximumMarketAnalysisRequests: 1,
      maximumTradePreviewRequests: 1,
      maximumNoteOperations: 1,
      passResearch: {
        minimumDiscoveryRequests: 0,
        minimumDistinctDiscoveryModes: 0,
        minimumInspectedMarkets: 0,
        minimumDistinctEventFamilies: 0,
        minimumWebSearches: 0,
        minimumMarketAnalyses: 0,
        minimumTradePreviews: 0,
      },
      memory: {
        enabled: false,
        maximumNotes: 1,
        maximumContextNotes: 1,
        maximumNoteCharacters: 100,
      },
      state: {
        enabled: false,
        maximumBeliefs: 1,
        maximumContextBeliefs: 1,
        maximumBeliefCharacters: 100,
        maximumPlanCharacters: 100,
      },
      timeoutSeconds: 60,
      ...overrides,
    }),
  });
  assert.equal(agent({}).history.enabled, true);
  assert.equal(agent({ history: { enabled: false } }).history.enabled, false);
}

// Default critical learning lists each market once by its net realized PnL,
// and omitted history leaves out prior cycles, performance and the policy.
{
  const zero = new Decimal(0);
  const at = new Date("2040-01-05T00:00:00Z");
  const closed = (tradeId, marketSlug, realizedPnl) => ({
    tradeId,
    marketSlug,
    price: new Decimal("0.4"),
    quantity: new Decimal(5),
    costBasis: new Decimal(2),
    realizedPnl: new Decimal(realizedPnl),
    state: "TRADE_STATE_FILLED",
    aggressor: true,
    createdAt: at,
    updatedAt: at,
  });
  const base = {
    observedAt: at,
    exchangeId: "polymarket-us",
    exchangeName: "Fixture",
    account: {
      observedAt: at,
      currentBalance: new Decimal(100),
      buyingPower: new Decimal(100),
      assetNotional: zero,
      assetAvailable: zero,
      openOrderValue: zero,
      unsettledFunds: zero,
      marginRequirement: zero,
      positions: [],
      openOrders: [],
      recentActivities: [],
    },
    marketCatalog: { count: 0, categoryCounts: {} },
    preloadedMarkets: [],
    riskConstraints: {
      maximumPositionCostBasisFraction: new Decimal("0.5"),
      maximumCycleSpendFraction: new Decimal("0.5"),
      maximumExecutionSpread: new Decimal("0.1"),
      kellyFraction: new Decimal("0.5"),
      uncertaintyBoundWeight: new Decimal("0.25"),
      duplicateWindowMinutes: 30,
      minimumIndependentSources: 1,
      allowNakedShorts: false,
      allowPositionReductions: false,
      emergencyExitEnabled: false,
      managedRestingBuyOrders: { enabled: false, maximumLifetimeMinutes: 15 },
    },
    recentPerformance: {
      settlements: [
        { marketSlug: "alpha", realizedPnl: zero, resolvedAt: at },
        { marketSlug: "bravo", realizedPnl: new Decimal(3), resolvedAt: at },
      ],
      closedTrades: [
        closed("t1", "charlie", "-1"),
        closed("t2", "charlie", "-2"),
        closed("t3", "charlie", "-0.5"),
        closed("t4", "bravo", "-1"),
      ],
      settlementRealizedPnl: new Decimal(3),
      closedTradeRealizedPnl: new Decimal("-4.5"),
      profitableOutcomeCount: 1,
      losingOutcomeCount: 4,
      flatOutcomeCount: 1,
      bustedTradeCount: 0,
    },
  };
  const learning = buildAgentContext(base).criticalLearning;
  assert.deepEqual(learning.profitableMarketSlugs, ["bravo"]);
  assert.deepEqual(learning.losingMarketSlugs, ["charlie"]);
  assert.equal(learning.realizedOutcomeSampleSize, 3);

  let called = false;
  const omitted = buildAgentContext({
    ...base,
    historyEnabled: false,
    criticalLearningPolicy: () => {
      called = true;
      throw new Error("policy must not run without history");
    },
    previousCycle: { advisoryOnly: true },
  });
  assert.equal(called, false);
  assert.equal("previousCycle" in omitted, false);
  assert.equal("recentPerformance" in omitted, false);
  assert.deepEqual(omitted.criticalLearning.profitableMarketSlugs, []);
  assert.deepEqual(omitted.criticalLearning.losingMarketSlugs, []);
  assert.equal(omitted.criticalLearning.realizedOutcomeSampleSize, 0);
  assert.match(
    omitted.criticalLearning.positionManagementReminders.join(" "),
    /allowPositionReductions=false/u,
    "rules still reach the model",
  );
}

globalThis.console.log(JSON.stringify({ status: "PASS" }));
