import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";
import { Decimal } from "decimal.js";
import pino from "pino";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { runCycle } from "../dist/src/agent/cycle.js";
import { RepositoryConfigSchema } from "../dist/src/config/schema.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import {
  MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS,
  reviewDecisionSubmission,
} from "../dist/src/llm/decision-provider.js";
import { createRunJournal } from "../dist/src/reporting/run-journal.js";
import { referenceStrategy } from "../dist/src/strategy/policy.js";

// Exercise the full cycle with an in-memory provider/exchange and no reports.
// Trap any accidental HTTP request; no real provider or adapter is created.
const previousDispatcher = getGlobalDispatcher();
const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail("Unexpected network request");

const D = (value) => new Decimal(value);
const now = new Date("2026-01-01T12:00:00.000Z");
const defaults = RepositoryConfigSchema.parse(
  JSON.parse(await readFile("config/default.json", "utf8")),
);
const prompts = await loadPromptBundle();
const config = {
  ...defaults,
  risk: { ...defaults.risk, allowPositionReductions: false },
  reporting: {
    ...defaults.reporting,
    shadowLedger: { ...defaults.reporting.shadowLedger, enabled: false },
  },
};
const logger = pino({ level: "silent" });

function target(marketSlug, fraction, side = "YES") {
  return {
    marketSlug,
    side,
    targetCostBasisFraction: D(fraction),
    estimatedProbability: D("0.1"),
    probabilityLowerBound: D("0.1"),
    probabilityUpperBound: D("0.1"),
    confidence: "HIGH",
    thesis: "Synthetic reduction request.",
    settlementVerification: "Synthetic contract settlement.",
    invalidationConditions: "Synthetic contract changes.",
    evidence: [],
  };
}

function decision(portfolioTargets, candidateDispositions = []) {
  return {
    cycleSummary: "Synthetic cycle.",
    portfolioTargets,
    candidateDispositions,
    proposals: [],
  };
}

function fixture(heldSlugs) {
  const positions = heldSlugs.map((marketSlug) => ({
    marketId: { exchange: "polymarket-us", value: marketSlug },
    marketSlug,
    side: "YES",
    quantity: D(20),
    availableQuantity: D(20),
    costBasis: D(10),
    realizedPnl: D(0),
    exchangeCashValue: D(10),
    expired: false,
  }));
  const account = {
    observedAt: now,
    currentBalance: D(100 - positions.length * 10),
    buyingPower: D(100 - positions.length * 10),
    assetNotional: D(positions.length * 10),
    assetAvailable: D(positions.length * 10),
    openOrderValue: D(0),
    unsettledFunds: D(0),
    marginRequirement: D(0),
    positions,
    openOrders: [],
    recentActivities: [],
  };
  const markets = heldSlugs.map((slug) => ({
    id: { exchange: "polymarket-us", value: slug },
    slug,
    title: `Synthetic ${slug}`,
    description: "Synthetic fixture.",
    settlementRules: "Synthetic fixture settlement.",
    active: true,
    closed: false,
    archived: false,
    minimumTradeQuantity: D(1),
    priceTick: D("0.01"),
  }));
  const bySlug = new Map(markets.map((market) => [market.slug, market]));
  const calls = { placements: 0, cancellations: 0, previews: 0 };
  const exchange = {
    id: "polymarket-us",
    memoryScope: "synthetic-reduction-test",
    async listMarkets({ offset = 0 }) {
      return { items: offset === 0 ? markets : [], eof: true };
    },
    async getMarketBySlug(slug) {
      assert.ok(bySlug.has(slug));
      return bySlug.get(slug);
    },
    async getMarket(id) {
      return this.getMarketBySlug(id.value);
    },
    async getBbo(marketId) {
      const quote = { bid: D("0.5"), ask: D("0.51"), spread: D("0.01") };
      return { marketId, yes: quote, no: quote, observedAt: now };
    },
    async getOrderBook(marketId) {
      return {
        marketId,
        yesBids: [{ price: D("0.5"), quantity: D(1000) }],
        yesAsks: [{ price: D("0.51"), quantity: D(1000) }],
        observedAt: now,
      };
    },
    async getAccountSnapshot() {
      return account;
    },
    async getPositions() {
      return positions;
    },
    async getOpenOrders() {
      return [];
    },
    async getActivities() {
      return { items: [], eof: true };
    },
    async createImmediateOrderFeeReserveEstimator() {
      return () => D(0);
    },
    async previewImmediateOrder() {
      calls.previews += 1;
      assert.fail("Blocked reduction reached exchange preview");
    },
    async placeImmediateOrder() {
      calls.placements += 1;
      assert.fail("Observe cycle attempted an order");
    },
    async cancelOrder() {
      calls.cancellations += 1;
      assert.fail("Unexpected cancellation");
    },
    async getSettlement() {
      assert.fail("Unexpected settlement lookup");
    },
  };
  return { exchange, calls };
}

async function cycle(heldSlugs, candidates, options = {}) {
  const { exchange, calls } = fixture(heldSlugs);
  const reviews = options.reviews ?? [];
  const report = await runCycle({
    config,
    prompts,
    strategy: referenceStrategy,
    exchange,
    logger,
    mode: "observe",
    writeReports: false,
    runId: "synthetic",
    cycleId: "synthetic",
    now: () => now,
    decisionProvider: {
      providerId: "synthetic",
      modelId: "synthetic",
      async decide(input) {
        assert.match(JSON.stringify(input.prompt), /allowPositionReductions/u);
        const reviewedInput = {
          ...input,
          async reviewTerminalDecision(candidate, signal) {
            const review = await input.reviewTerminalDecision(
              candidate,
              signal,
            );
            reviews.push(review);
            return review;
          },
        };
        for (
          let offered = 0;
          offered <= MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS;
          offered += 1
        ) {
          const candidate =
            candidates[Math.min(offered, candidates.length - 1)];
          const disposition = await reviewDecisionSubmission(
            reviewedInput,
            candidate,
            input.signal,
            offered,
          );
          if (disposition.kind === "FINAL") return candidate;
        }
        assert.fail("Terminal repair exceeded the provider bound");
      },
    },
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.journal === undefined
      ? {}
      : { journal: options.journal, writeReports: true }),
  });
  assert.deepEqual(calls, { placements: 0, cancellations: 0, previews: 0 });
  return { report, reviews };
}

function assertBlockedReport(report, fraction) {
  assert.equal(report.outcome, "ALL_REJECTED");
  assert.equal(
    report.agent.portfolioTargets.find((item) => item.marketSlug === "held")
      .targetCostBasisFraction,
    fraction,
  );
  const reconciliation = report.agent.targetReconciliations.find(
    (item) => item.marketSlug === "held",
  );
  assert.equal(reconciliation.action, "SELL");
  assert.equal(
    reconciliation.targetCostBasisUsd,
    D(fraction).mul(100).toFixed(),
  );
  assert.ok(
    report.risk.rejected.some(
      (item) =>
        item.marketSlug === "held" &&
        item.code === "POSITION_REDUCTION_DISABLED",
    ),
  );
  assert.ok(
    !report.agent.candidateDispositions.some(
      (item) => item.marketSlug === "held",
    ),
  );
  assert.deepEqual(report.currentCycleExecutions, []);
}

try {
  for (const fraction of ["0", "0.05"]) {
    const result = await cycle(
      ["held"],
      [decision([target("held", fraction)])],
    );
    assert.deepEqual(
      result.reviews,
      [{ repair: false }],
      "Policy rejection alone must not request repair",
    );
    assertBlockedReport(result.report, fraction);
  }

  // An unrelated coverage problem requires one repair. Attempts to rewrite a
  // blocked trim as a hold, or omit it, must preserve its original target.
  for (const replacement of ["hold-target", "hold-disposition", "omitted"]) {
    const targets = [target("other", "0.1")];
    const dispositions = [];
    if (replacement === "hold-target") targets.push(target("held", "0.1"));
    if (replacement === "hold-disposition")
      dispositions.push({
        marketSlug: "held",
        side: "YES",
        outcome: "HOLD_UNCHANGED",
        reasonCode: "RISK_OR_CORRELATION_LIMIT",
        rationale: "Synthetic attempted policy repair.",
        evidence: [],
      });
    const result = await cycle(
      ["held", "other"],
      [decision([target("held", "0.05")]), decision(targets, dispositions)],
    );
    assert.equal(result.reviews.length, 2);
    assert.equal(result.reviews[0].repair, true);
    assert.equal(result.reviews[1].repair, false);
    const policyRejection = result.reviews[0].feedback.rejectedProposals.find(
      (item) => item.code === "POSITION_REDUCTION_DISABLED",
    );
    assert.equal(policyRejection.repairable, false);
    assertBlockedReport(result.report, "0.05");
  }
  // An independently invalid final plan still fails the existing guard. Its
  // originally rejected reduction must survive all bounded review rounds in
  // durable, distinct journal artifacts, even without a normal cycle report.
  const directory = await mkdtemp(
    join(tmpdir(), "marketcaster-reduction-cycle-"),
  );
  try {
    const journal = await createRunJournal({
      rootDirectory: directory,
      runId: "synthetic",
      cycleId: "synthetic",
      mode: "observe",
      exchangeId: "polymarket-us",
      accountScope: "synthetic-reduction-test",
      now: () => now,
    });
    const reviews = [];
    await assert.rejects(
      cycle(
        ["held", "other"],
        [decision([target("held", "0.05")]), decision([target("held", "0.1")])],
        {
          reviews,
          journal,
          config: { ...config, reporting: { ...config.reporting, directory } },
        },
      ),
      /Terminal decision failed deterministic guards.*MISSING_HELD_POSITION_DECISION/u,
    );
    assert.equal(reviews.length, MAXIMUM_TERMINAL_DECISION_REPAIR_ATTEMPTS + 1);
    assert.ok(reviews.every((review) => review.repair));
    assert.equal(journal.currentManifest.stage, "FAILED");
    const artifacts = Object.entries(journal.currentManifest.artifacts).filter(
      ([kind]) => kind.startsWith("position-reduction-policy-"),
    );
    assert.equal(artifacts.length, reviews.length);
    for (const [, path] of artifacts) {
      const { data } = JSON.parse(
        await readFile(join(journal.runDirectory, path), "utf8"),
      );
      assert.equal(
        data.decision.portfolioTargets.find(
          (item) => item.marketSlug === "held",
        ).targetCostBasisFraction,
        "0.05",
      );
      assert.equal(data.rejectedProposals[0].proposal.action, "SELL");
      assert.equal(
        data.rejectedProposals[0].code,
        "POSITION_REDUCTION_DISABLED",
      );
    }
    assert.equal(
      journal.currentManifest.artifacts["execution-report"],
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  stdout.write(
    "Position reduction cycle checks passed (6 synthetic observe cycles)\n",
  );
} finally {
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(previousDispatcher);
  await network.close();
}
