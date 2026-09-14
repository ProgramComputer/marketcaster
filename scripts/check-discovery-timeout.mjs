import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RepositoryConfigSchema } from "../dist/src/config/schema.js";
import {
  StageTimeoutError,
  withStageTimeout,
} from "../dist/src/utilities/time.js";

const defaults = JSON.parse(await readFile("config/default.json", "utf8"));

test("only discovery can omit its independent deadline", () => {
  const original = RepositoryConfigSchema.parse(defaults);
  assert.equal(original.cycle.stageBudgetsSeconds.marketDiscovery, 60);

  const input = globalThis.structuredClone(defaults);
  input.cycle.stageBudgetsSeconds.marketDiscovery = null;
  // An uncapped discovery stage can share the overall deadline even when the
  // remaining finite stage limits add up to less than the overall allowance.
  input.cycle.timeoutSeconds = 2_000;
  const parsed = RepositoryConfigSchema.parse(input);
  assert.equal(parsed.cycle.stageBudgetsSeconds.marketDiscovery, null);
  assert.equal(parsed.cycle.timeoutSeconds, 2_000);

  input.cycle.stageBudgetsSeconds.marketDiscovery = 120;
  assert.equal(RepositoryConfigSchema.safeParse(input).success, false);
  input.cycle.timeoutSeconds = defaults.cycle.timeoutSeconds;
  for (const invalid of [0, -1, 1.5, "null", undefined]) {
    input.cycle.stageBudgetsSeconds.marketDiscovery = invalid;
    assert.equal(RepositoryConfigSchema.safeParse(input).success, false);
  }
  input.cycle.stageBudgetsSeconds.marketDiscovery = null;
  for (const stage of [
    "agentResearch",
    "validationExecution",
    "reconciliationReporting",
  ]) {
    const invalid = globalThis.structuredClone(input);
    invalid.cycle.stageBudgetsSeconds[stage] = null;
    assert.equal(RepositoryConfigSchema.safeParse(invalid).success, false);
  }
});

test("uncapped discovery can complete beyond the former deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = withStageTimeout("market-discovery", null, async (signal) => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 180_000));
    signal.throwIfAborted();
    return "complete catalog";
  });
  t.mock.timers.tick(180_000);
  assert.equal(await result, "complete catalog");
});

test("uncapped discovery still observes the overall cycle deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new globalThis.AbortController();
  const reason = new Error("Synthetic overall cycle deadline");
  globalThis.setTimeout(() => parent.abort(reason), 200_000);
  let discoverySignal;
  const result = withStageTimeout(
    "market-discovery",
    null,
    (signal) => {
      discoverySignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    parent.signal,
  );
  t.mock.timers.tick(120_001);
  assert.equal(discoverySignal.aborted, false);
  t.mock.timers.tick(79_999);
  await assert.rejects(result, (error) => error === reason);
});

test("an expired overall deadline prevents a new stage from starting", async () => {
  for (const budget of [null, 120_000]) {
    const parent = new globalThis.AbortController();
    const reason = new Error("Synthetic already-expired cycle");
    parent.abort(reason);
    let called = false;
    await assert.rejects(
      withStageTimeout(
        "market-discovery",
        budget,
        async () => {
          called = true;
        },
        parent.signal,
      ),
      (error) => error === reason,
    );
    assert.equal(called, false);
  }
});

test("finite stage deadlines still abort with their original reason", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = withStageTimeout("synthetic-stage", 50, (signal) => {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  t.mock.timers.tick(50);
  await assert.rejects(
    result,
    (error) =>
      error instanceof StageTimeoutError && error.stage === "synthetic-stage",
  );
});
