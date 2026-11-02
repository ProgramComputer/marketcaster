import assert from "node:assert/strict";
import { log } from "node:console";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Decimal } from "decimal.js";
import pino from "pino";
import { runCycle } from "../src/agent/cycle.ts";
import { loadRuntimeConfiguration } from "../src/config/runtime-overrides.ts";

const directory = await mkdtemp(join(tmpdir(), "marketcaster-review-cycle-"));
const previousSummary = process.env.GITHUB_STEP_SUMMARY;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network is forbidden in the diagnostic integration check");
};
const kinds = [
  "execution-diagnostics",
  "history-attribution",
  "evidence-receipts",
];
try {
  process.env.GITHUB_STEP_SUMMARY = join(directory, "summary.md");
  const runtime = await loadRuntimeConfiguration({});
  const now = () => new Date("2026-01-01T00:00:00Z");
  const snapshot = {
    observedAt: now(),
    currentBalance: new Decimal(100),
    buyingPower: new Decimal(100),
    assetNotional: new Decimal(0),
    assetAvailable: new Decimal(0),
    openOrderValue: new Decimal(0),
    unsettledFunds: new Decimal(0),
    marginRequirement: new Decimal(0),
    positions: [],
    openOrders: [],
    recentActivities: [],
  };
  const run = async (
    name,
    enabled,
    failure = false,
    blockWrite = false,
    cycleId = "synthetic-cycle",
  ) => {
    const root = join(directory, name);
    const runDirectory = join(root, "runs", "synthetic-run", cycleId);
    const calls = [];
    const forbidden = () => {
      throw new Error("Unexpected exchange read or mutation");
    };
    const exchange = {
      id: "kalshi",
      memoryScope: "synthetic-review",
      getAccountSnapshot: async () => {
        calls.push("snapshot");
        return snapshot;
      },
      listMarkets: async () => {
        calls.push("markets");
        return { items: [], eof: true };
      },
      getPositions: async () => [],
      getOpenOrders: async () => [],
      getActivities: async () => ({ items: [], eof: true }),
      getMarket: forbidden,
      getMarketBySlug: forbidden,
      getBbo: forbidden,
      getOrderBook: forbidden,
      getSettlement: forbidden,
      getOrder: forbidden,
      previewImmediateOrder: forbidden,
      createImmediateOrderFeeReserveEstimator: forbidden,
      placeImmediateOrder: forbidden,
      cancelOrder: forbidden,
    };
    const config = {
      ...runtime.config,
      reporting: {
        ...runtime.config.reporting,
        directory: root,
        shadowLedger: {
          ...runtime.config.reporting.shadowLedger,
          enabled: false,
        },
      },
      agent: {
        ...runtime.config.agent,
        memory: { ...runtime.config.agent.memory, enabled: false },
        state: { ...runtime.config.agent.state, enabled: false },
        passResearch: Object.fromEntries(
          Object.keys(runtime.config.agent.passResearch).map((key) => [key, 0]),
        ),
      },
    };
    let capturedPrompt;
    const promise = runCycle({
      ...runtime,
      config,
      exchange,
      mode: "observe",
      logger: pino({ level: "silent" }),
      now,
      runId: "synthetic-run",
      cycleId,
      reviewDiagnostics: enabled,
      provenanceIdentity: {
        engineSha: null,
        productionSha: null,
        secretValues: [],
      },
      decisionProvider: {
        providerId: "synthetic",
        modelId: "synthetic",
        decide: async ({
          prompt,
          researchTools,
          limits,
          signal,
          recordTranscriptRound,
        }) => {
          capturedPrompt = JSON.stringify(prompt);
          await recordTranscriptRound({
            round: 1,
            response: {},
            providerWebSearchCount: 0,
            toolCalls: [
              {
                callId: "receipt",
                name: "read_evidence_source",
                input: { url: "https://example.com/synthetic" },
              },
            ],
            toolResults: [
              {
                callId: "receipt",
                name: "read_evidence_source",
                result: {
                  kind: "TOOL_RESULT",
                  isError: false,
                  content: {
                    text: "Synthetic review-only receipt",
                    retrieval: { retrievedAt: now().toISOString() },
                  },
                },
              },
            ],
          });
          if (blockWrite)
            await writeFile(
              join(runDirectory, "execution-diagnostics.json"),
              "existing review file\n",
            );
          if (failure) throw new Error("Synthetic provider failure");
          const result = await researchTools.createSession(limits).execute(
            "submit_trade_plan",
            {
              cycleSummary: "Synthetic empty catalog.",
              portfolioTargets: [],
              candidateDispositions: [],
            },
            signal,
          );
          assert.equal(result.kind, "DECISION");
          return result.decision;
        },
      },
    });
    let report;
    if (failure) await assert.rejects(promise, /Synthetic provider failure/u);
    else report = await promise;
    const manifest = JSON.parse(
      await readFile(join(runDirectory, "manifest.json"), "utf8"),
    );
    for (const kind of kinds)
      assert.equal(
        kind in manifest.artifacts,
        false,
        "optional files must bypass mandatory journal queue",
      );
    const receipts = enabled
      ? JSON.parse(
          await readFile(join(runDirectory, "evidence-receipts.json"), "utf8"),
        )
      : undefined;
    if (enabled) {
      assert.equal(receipts.accountScope, "synthetic-review");
      assert.equal(
        receipts.data.events[0].text,
        "Synthetic review-only receipt",
      );
    } else {
      for (const kind of kinds)
        await assert.rejects(readFile(join(runDirectory, `${kind}.json`)), {
          code: "ENOENT",
        });
    }
    if (blockWrite)
      assert.equal(
        await readFile(
          join(runDirectory, "execution-diagnostics.json"),
          "utf8",
        ),
        "existing review file\n",
      );
    return { report, capturedPrompt, calls, manifest };
  };
  const off = await run("disabled", false);
  const on = await run("enabled", true);
  assert.equal(
    on.capturedPrompt,
    off.capturedPrompt,
    "diagnostics must leave exact model input unchanged",
  );
  assert.deepEqual(
    on.report,
    off.report,
    "diagnostics must leave decision and execution report unchanged",
  );
  assert.deepEqual(
    on.calls,
    off.calls,
    "diagnostics must not add exchange reads",
  );
  const nextOff = await run("disabled", false, false, false, "next-cycle");
  const nextOn = await run("enabled", true, false, false, "next-cycle");
  assert.equal(
    nextOn.capturedPrompt,
    nextOff.capturedPrompt,
    "retained review files must not enter a later cycle's model input or recap",
  );
  const blocked = await run("write-failure", true, false, true);
  assert.deepEqual(
    blocked.report,
    off.report,
    "optional write failure must preserve successful result",
  );
  assert.equal(blocked.manifest.stage, off.manifest.stage);
  const failed = await run("failed-cycle", true, true);
  assert.equal(failed.manifest.stage, "FAILED");
  log(
    JSON.stringify({
      status: "PASS",
      checks: "diagnostic cycle isolation and failure preservation",
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  await rm(directory, { recursive: true, force: true });
}
