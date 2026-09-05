import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import {
  FileExecutionHealth,
  executionFailureCode,
} from "../src/execution/execution-health.ts";
import { ExchangeError } from "../src/exchanges/exchange.ts";
import {
  executeValidatedOrders,
  ExecutionJournalError,
} from "../src/execution/executor.ts";

// Every exchange call below is a local fake. No credentials or network access.
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "marketcaster-execution-health-"),
);
const decimal = (value = 0) => new Decimal(value);
const timestamp = "2026-01-02T00:00:00.000Z";
const now = () => new Date(timestamp);
const healthOptions = {
  rootDirectory: temporaryDirectory,
  exchangeId: "kalshi",
  accountScope: "fixture-account",
  cooldownMilliseconds: { RATE_LIMITED: 1_000, PREVIEW_REJECTED: 2_000 },
};
const healthKey = { marketSlug: "fixture-market", side: "YES", action: "BUY" };
const baseFailure = {
  ...healthKey,
  marketSlug: "fixture-market",
  failureCode: "RATE_LIMITED",
  phase: "PRECHECK",
  observedAt: timestamp,
  mutationMayHaveOccurred: false,
};

try {
  const health = new FileExecutionHealth(healthOptions);
  assert.equal(await health.blockedUntil(healthKey, now()), undefined);
  await health.recordFailure(baseFailure);
  const reload = new FileExecutionHealth(healthOptions);
  assert.equal(
    (await reload.blockedUntil(healthKey, now())).retryAfter,
    "2026-01-02T00:00:01.000Z",
  );
  assert.equal(
    await reload.blockedUntil(healthKey, new Date("2026-01-02T00:00:01Z")),
    undefined,
    "Cooldown expires at equality",
  );
  assert.equal(
    await reload.blockedUntil(
      { ...healthKey, marketSlug: "unrelated-market" },
      now(),
    ),
    undefined,
  );
  assert.equal(
    await reload.blockedUntil({ ...healthKey, action: "SELL" }, now()),
    undefined,
    "A failed entry must not block an exit",
  );
  assert.equal(
    await reload.blockedUntil({ ...healthKey, side: "NO" }, now()),
    undefined,
    "Opposite outcomes have separate cooldowns",
  );
  assert.equal(
    await new FileExecutionHealth({
      ...healthOptions,
      accountScope: "other-account",
    }).blockedUntil(healthKey, now()),
    undefined,
  );
  assert.equal(
    await new FileExecutionHealth({
      ...healthOptions,
      exchangeId: "polymarket-us",
    }).blockedUntil(healthKey, now()),
    undefined,
  );
  assert.equal(
    await new FileExecutionHealth({
      ...healthOptions,
      cooldownMilliseconds: {},
    }).blockedUntil(healthKey, now()),
    undefined,
    "No implicit cooldown policy",
  );
  assert.throws(
    () =>
      new FileExecutionHealth({
        ...healthOptions,
        accountScope: "../other-account",
      }),
  );
  assert.throws(
    () =>
      new FileExecutionHealth({ ...healthOptions, accountScope: "unscoped" }),
  );
  assert.throws(
    () =>
      new FileExecutionHealth({
        ...healthOptions,
        cooldownMilliseconds: { RATE_LIMITED: -1 },
      }),
  );
  assert.equal(
    executionFailureCode(new ExchangeError("synthetic text", "UNSUPPORTED")),
    "UNSUPPORTED",
  );
  assert.equal(
    executionFailureCode(
      new Error("rate limit words are not authoritative codes"),
    ),
    "UNKNOWN",
  );
  await assert.rejects(
    health.recordFailure({
      ...baseFailure,
      message: "raw content must never enter health storage",
    }),
  );

  const snapshot = {
    observedAt: now(),
    currentBalance: decimal(10),
    buyingPower: decimal(10),
    assetNotional: decimal(0),
    assetAvailable: decimal(0),
    openOrderValue: decimal(0),
    unsettledFunds: decimal(0),
    marginRequirement: decimal(0),
    positions: [],
    openOrders: [],
    recentActivities: [],
  };
  const market = {
    id: { exchange: "kalshi", value: "fixture-market" },
    slug: "fixture-market",
    active: true,
    closed: false,
    archived: false,
    priceTick: decimal("0.01"),
    minimumTradeQuantity: decimal(1),
  };
  const order = {
    marketId: market.id,
    marketSlug: market.slug,
    side: "YES",
    action: "BUY",
    quantity: decimal(1),
    canonicalLimitPrice: decimal("0.4"),
    executionPolicy: "IOC",
  };
  const validated = {
    market,
    order,
    proposal: { action: "BUY" },
    authorizationProbability: decimal("0.8"),
    conservativeFeeReserve: decimal(0),
    maximumExecutionSpend: decimal("0.4"),
    riskBudget: decimal(1),
  };
  const calls = { read: 0, preview: 0, place: 0 };
  let rejectPreview = true;
  let placementResult = {
    status: "NO_FILL",
    filledQuantity: decimal(0),
    fees: decimal(0),
    finalState: "CANCELED",
  };
  const exchange = {
    id: "kalshi",
    memoryScope: "fixture-account",
    getOpenOrders: async () => {
      calls.read += 1;
      return [];
    },
    getPositions: async () => {
      calls.read += 1;
      return [];
    },
    getActivities: async () => {
      calls.read += 1;
      return { items: [], eof: true };
    },
    getMarketBySlug: async () => {
      calls.read += 1;
      return market;
    },
    getBbo: async () => {
      calls.read += 1;
      return {
        yes: { bid: decimal("0.39"), ask: decimal("0.4") },
        no: { bid: decimal("0.6"), ask: decimal("0.61") },
      };
    },
    getOrderBook: async () => {
      calls.read += 1;
      return {
        yesBids: [{ price: decimal("0.39"), quantity: decimal(5) }],
        yesAsks: [{ price: decimal("0.4"), quantity: decimal(5) }],
      };
    },
    previewImmediateOrder: async () => {
      calls.preview += 1;
      return {
        accepted: !rejectPreview,
        estimatedFees: decimal(0),
        warnings: [],
        rejectionReasons: rejectPreview ? ["Synthetic rejection"] : [],
      };
    },
    placeImmediateOrder: async () => {
      calls.place += 1;
      return placementResult;
    },
    getAccountSnapshot: async () => snapshot,
  };
  const input = {
    mode: "live",
    exchange,
    snapshot,
    riskEquity: decimal(10),
    validated: [validated],
    now,
    policy: {
      maximumCycleSpendFraction: decimal(1),
      duplicateWindowMinutes: 1,
      maximumExecutionSpread: decimal("0.1"),
      emergencyExitEnabled: false,
    },
    intentIdPrefix: "fixture-cycle",
  };

  const blocked = await executeValidatedOrders({
    ...input,
    executionHealth: health,
  });
  assert.equal(
    calls.read + calls.preview + calls.place,
    0,
    "Persisted cooldown runs before any exchange access",
  );
  assert.equal(blocked.attempts[0].intentId, "fixture-cycle:1");
  assert.equal(blocked.attempts[0].cooldown.failureCode, "RATE_LIMITED");
  const beforeSkipped = await readFile(
    join(
      temporaryDirectory,
      "execution-health",
      "kalshi",
      "fixture-account",
      "index.json",
    ),
    "utf8",
  );
  await executeValidatedOrders({ ...input, executionHealth: health });
  assert.equal(
    await readFile(
      join(
        temporaryDirectory,
        "execution-health",
        "kalshi",
        "fixture-account",
        "index.json",
      ),
      "utf8",
    ),
    beforeSkipped,
    "Skipping does not extend the cooldown",
  );

  const freshHealth = new FileExecutionHealth({
    ...healthOptions,
    accountScope: "fixture-preview",
  });
  const rejected = await executeValidatedOrders({
    ...input,
    executionHealth: freshHealth,
  });
  assert.equal(calls.preview, 1);
  assert.equal(calls.place, 0);
  assert.equal(rejected.attempts[0].failure.failureCode, "PREVIEW_REJECTED");
  assert.equal(rejected.attempts[0].failure.mutationMayHaveOccurred, false);
  assert.equal(
    (await freshHealth.blockedUntil(healthKey, now())).failureCode,
    "PREVIEW_REJECTED",
  );
  const storedPreview = await readFile(
    join(
      temporaryDirectory,
      "execution-health",
      "kalshi",
      "fixture-preview",
      "index.json",
    ),
    "utf8",
  );
  assert.equal(
    storedPreview.includes("Synthetic rejection"),
    false,
    "Health records exclude raw rejection text",
  );

  rejectPreview = false;
  const recorded = [];
  const journal = {
    recordIntent: async (event) => recorded.push(event),
    recordSubmissionOutcome: async (event) => recorded.push(event),
    recordReconciliationOutcome: async (event) => recorded.push(event),
    recordAttempt: async (event) => recorded.push(event),
  };
  const noFill = await executeValidatedOrders({ ...input, journal });
  assert.equal(calls.place, 1);
  assert.equal(noFill.attempts[0].failure.failureCode, "NO_FILL");
  assert.ok(recorded.every((event) => event.intentId === "fixture-cycle:1"));
  assert.equal(recorded.length, 4);

  placementResult = {
    status: "AMBIGUOUS",
    filledQuantity: decimal(0),
    fees: decimal(0),
    finalState: "UNKNOWN",
  };
  const ambiguous = await executeValidatedOrders({
    ...input,
    validated: [validated, validated],
  });
  assert.equal(
    calls.place,
    2,
    "An ambiguous placement is never retried or followed by the next order",
  );
  assert.equal(ambiguous.attempts.length, 1);
  assert.equal(ambiguous.stoppedForAmbiguity, true);
  assert.equal(ambiguous.attempts[0].failure.failureCode, "AMBIGUOUS");

  const brokenHealth = {
    blockedUntil: async () => undefined,
    recordFailure: async () => {
      throw new Error("Synthetic write failure");
    },
  };
  await assert.rejects(
    executeValidatedOrders({ ...input, executionHealth: brokenHealth }),
    (error) =>
      error instanceof ExecutionJournalError &&
      error.phase === "EXECUTION_HEALTH" &&
      error.mutationMayHaveOccurred,
  );
  assert.equal(
    calls.place,
    3,
    "A health-write failure after a mutation does not resubmit",
  );
  const brokenPath = join(
    temporaryDirectory,
    "execution-health",
    "kalshi",
    "fixture-account",
    "index.json",
  );
  await writeFile(brokenPath, "invalid");
  await assert.rejects(
    executeValidatedOrders({ ...input, executionHealth: health }),
    (error) =>
      error instanceof ExecutionJournalError && !error.mutationMayHaveOccurred,
  );
  assert.equal(
    calls.place,
    3,
    "Invalid persisted health must prevent submission",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
