import assert from "node:assert/strict";
import { log } from "node:console";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Decimal } from "decimal.js";
import pino from "pino";
import { runCycle } from "../src/agent/cycle.ts";
import { loadRuntimeConfiguration } from "../src/config/runtime-overrides.ts";

// Invented, offline fixtures. No exchange adapter or provider client is created.
const directory = await mkdtemp(join(tmpdir(), "marketcaster-reassessment-"));
const previousSummary = process.env.GITHUB_STEP_SUMMARY;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network is forbidden in the synthetic cycle regression");
};
const D = (value = 0) => new Decimal(value);
const observedAt = new Date("2026-01-02T12:00:00.000Z");
const now = () => observedAt;
const affectedSlug = "synthetic-changing-depth";
const safeSlug = "synthetic-independent-entry";
const exitSlug = "synthetic-covered-exit";
const source = {
  title: "Synthetic publication",
  url: "https://example.com/synthetic-publication",
  evidenceClass: "CURRENT_REPORT",
  claimExcerpt: "Synthetic recorded observations support the fixture.",
  claimEventYear: 2026,
  publishedAt: observedAt.toISOString(),
  relevance: "Synthetic recorded observations support the fixture.",
};

try {
  process.env.GITHUB_STEP_SUMMARY = join(directory, "summary.md");
  const runtime = await loadRuntimeConfiguration({});

  async function run(name, options = {}) {
    const root = join(directory, name);
    const prompts = [];
    const placements = [];
    const orderRecords = new Map();
    const reviews = [];
    const terminalReviews = [];
    let phase = "research";
    let executionStarted = false;
    let initialDecision;
    let researchTools;
    const counts = { books: 0, previews: 0 };
    const markets = [affectedSlug, safeSlug, exitSlug].map((slug) => ({
      id: { exchange: "polymarket-us", value: slug },
      slug,
      title: `Synthetic contract ${slug}`,
      description: "Synthetic independent contract for an offline regression",
      settlementRules: "Settles from the synthetic event's recorded outcome",
      active: true,
      closed: false,
      archived: false,
      minimumTradeQuantity: D("0.01"),
      priceTick: D("0.01"),
      closesAt: new Date("2026-01-03T12:00:00.000Z"),
      liquidity: D(10000),
      volume24h: D(2000),
    }));
    const marketBySlug = new Map(
      markets.map((market) => [market.slug, market]),
    );
    let account = {
      observedAt,
      currentBalance: D(100),
      buyingPower: D(100),
      assetNotional: D(0),
      assetAvailable: D(0),
      openOrderValue: D(0),
      unsettledFunds: D(0),
      marginRequirement: D(0),
      positions: [
        {
          marketId: marketBySlug.get(exitSlug).id,
          marketSlug: exitSlug,
          side: "YES",
          quantity: D(7),
          availableQuantity: D(7),
          costBasis: D("2.1"),
          realizedPnl: D(0),
          expired: false,
        },
        ...(options.originalHeld
          ? [
              {
                marketId: marketBySlug.get(affectedSlug).id,
                marketSlug: affectedSlug,
                side: "YES",
                quantity: D(2),
                availableQuantity: D(2),
                costBasis: D("0.62"),
                realizedPnl: D(0),
                expired: false,
              },
            ]
          : []),
      ],
      openOrders: [],
      recentActivities: [],
    };
    const book = (marketId) => {
      const changed = marketId.value === affectedSlug;
      const collapsed = changed && phase !== "research" && !options.noCollapse;
      let quantity = collapsed ? D(5) : D(80);
      if (changed && options.originallySmall) quantity = D("0.7");
      if (changed && phase === "reviewed" && options.repeatedCollapse)
        quantity = D("0.2");
      if (changed && executionStarted && options.executorMovement)
        quantity = D("0.03");
      return {
        marketId,
        yesBids: [{ price: D("0.30"), quantity: D(80) }],
        yesAsks:
          changed && phase === "reviewed" && options.review === "reprice"
            ? [{ price: D("0.65"), quantity: D(80) }]
            : [
                { price: D("0.31"), quantity },
                { price: D("0.65"), quantity: D(80) },
              ],
        observedAt,
      };
    };
    const forbidden = () => {
      throw new Error("Unexpected synthetic exchange mutation or order lookup");
    };
    const exchange = {
      id: "polymarket-us",
      memoryScope: "synthetic-reassessment-account",
      listMarkets: async (query) => ({
        items: (query.offset ?? 0) === 0 ? markets : [],
        eof: true,
      }),
      getMarket: async (id) => marketBySlug.get(id.value),
      getMarketBySlug: async (slug) => marketBySlug.get(slug),
      getBbo: async (marketId) => {
        const repriced =
          marketId.value === affectedSlug &&
          phase === "reviewed" &&
          options.review === "reprice";
        return {
          marketId,
          yes: {
            bid: D(repriced ? "0.64" : "0.30"),
            ask: D(repriced ? "0.65" : "0.31"),
            spread: D("0.01"),
          },
          no: {
            bid: D(repriced ? "0.35" : "0.69"),
            ask: D(repriced ? "0.36" : "0.70"),
            spread: D("0.01"),
          },
          observedAt,
        };
      },
      getOrderBook: async (marketId) => {
        counts.books++;
        return book(marketId);
      },
      getSettlement: async (marketId) => ({ marketId, state: "OPEN" }),
      getAccountSnapshot: async () => account,
      getPositions: async () => account.positions,
      getOpenOrders: async () => [],
      getActivities: async (query) => {
        if (query?.marketSlug !== undefined) executionStarted = true;
        return { items: [], eof: true };
      },
      previewImmediateOrder: async () => {
        counts.previews++;
        return {
          accepted: true,
          estimatedFees: D(0),
          warnings: [],
          rejectionReasons: [],
          observedAt,
        };
      },
      createImmediateOrderFeeReserveEstimator: async () => () => D(0),
      placeImmediateOrder: async (order) => {
        assert.equal(options.mode ?? "live", "live");
        placements.push(order);
        const price =
          order.action === "SELL"
            ? D("0.30")
            : order.marketSlug === affectedSlug && options.review === "reprice"
              ? D("0.65")
              : D("0.31");
        const principal = order.quantity.mul(price);
        const prior = account.positions.find(
          (position) => position.marketSlug === order.marketSlug,
        );
        const positions = account.positions.filter(
          (position) => position.marketSlug !== order.marketSlug,
        );
        if (order.action === "BUY")
          positions.push({
            marketId: order.marketId,
            marketSlug: order.marketSlug,
            side: order.side,
            quantity: (prior?.quantity ?? D(0)).plus(order.quantity),
            availableQuantity: (prior?.availableQuantity ?? D(0)).plus(
              order.quantity,
            ),
            costBasis: (prior?.costBasis ?? D(0)).plus(principal),
            realizedPnl: D(0),
            expired: false,
          });
        const change = order.action === "BUY" ? principal.negated() : principal;
        account = {
          ...account,
          positions,
          currentBalance: account.currentBalance.plus(change),
          buyingPower: account.buyingPower.plus(change),
        };
        const orderId = `synthetic-order-${placements.length}`;
        orderRecords.set(orderId, {
          ...order,
          id: orderId,
          canonicalPrice: order.canonicalLimitPrice,
          state: "FILLED",
          filledQuantity: order.quantity,
          remainingQuantity: D(0),
          averageFillPrice: price,
          fees: D(0),
          executionPolicy: "IOC",
          createdAt: observedAt,
          updatedAt: observedAt,
        });
        return {
          orderId,
          status: "FILLED",
          finalState: "FILLED",
          filledQuantity: order.quantity,
          averageFillPrice: price,
          fees: D(0),
        };
      },
      getOrder: async (id) => {
        assert(orderRecords.has(id));
        return orderRecords.get(id);
      },
      cancelOrder: forbidden,
    };
    const target = (marketSlug, overrides = {}) => ({
      marketSlug,
      side: "LONG",
      targetCostBasisFraction: "0.08",
      estimatedProbability: "0.78",
      probabilityLowerBound: "0.70",
      probabilityUpperBound: "0.86",
      maximumEntryPrice: "0.31",
      confidence: "MEDIUM",
      thesis: "Synthetic inference from recorded observations",
      settlementVerification: "Synthetic event recorded outcome",
      invalidationConditions: "Synthetic observation is corrected",
      evidence: [source],
      evidenceBundleIds: [],
      ...overrides,
    });
    const config = {
      ...runtime.config,
      risk: {
        ...runtime.config.risk,
        maximumPositionCostBasisFraction: D("0.6"),
        maximumCycleSpendFraction: D("0.6"),
        kellyFraction: D("0.25"),
        uncertaintyBoundWeight: D("0.5"),
      },
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
        history: { ...runtime.config.agent.history, enabled: false },
        maximumRounds: options.noReviewBudget ? 1 : 8,
        timeoutSeconds: options.review === "timeout" ? 0.2 : 30,
        passResearch: Object.fromEntries(
          Object.keys(runtime.config.agent.passResearch).map((key) => [key, 0]),
        ),
      },
    };
    const strategy = {
      ...runtime.strategy,
      ...(options.policy === false
        ? {}
        : {
            executionReassessment: {
              maximumRetainedLiquidityFraction: D("0.4"),
            },
          }),
      allocation: ({ cycleBudget, candidates }) => {
        let remaining = cycleBudget;
        return candidates.flatMap((candidate) => {
          const spend = Decimal.min(remaining, candidate.maximumSpend);
          if (spend.lt(candidate.minimumSpend)) return [];
          remaining = remaining.minus(spend);
          return [{ id: candidate.id, spend }];
        });
      },
    };
    const report = await runCycle({
      ...runtime,
      strategy,
      config,
      exchange,
      mode: options.mode ?? "live",
      logger: pino({ level: "silent" }),
      runId: "synthetic-run",
      cycleId: "synthetic-cycle",
      now,
      reviewDiagnostics: options.diagnostics ?? false,
      provenanceIdentity: {
        engineSha: null,
        productionSha: null,
        secretValues: [],
      },
      decisionProvider: {
        providerId: "synthetic",
        modelId: "synthetic",
        decide: async (input) => {
          prompts.push({
            mode: input.mode ?? "RESEARCH",
            prompt: input.prompt,
          });
          if (input.mode === "EXECUTION_REASSESSMENT") {
            reviews.push(input);
            assert.equal(input.researchTools, researchTools);
            assert.equal(input.limits.maximumRounds, 1);
            assert(input.limits.timeoutMilliseconds > 0);
            if (options.review === "timeout") {
              await delay(input.limits.timeoutMilliseconds);
              throw new Error("Synthetic bounded provider review deadline");
            }
            if (options.review === "malformed") return {};
            if (options.review === "missing") return undefined;
            if (options.review === "failure")
              throw new Error("Synthetic review transport failed");
            if (options.review === "hold") {
              phase = "reviewed";
              return {
                ...initialDecision,
                portfolioTargets: initialDecision.portfolioTargets.filter(
                  (item) => item.marketSlug !== affectedSlug,
                ),
                candidateDispositions: [
                  {
                    marketSlug: affectedSlug,
                    side: "YES",
                    outcome: "HOLD_UNCHANGED",
                    reasonCode: "MARKET_STRUCTURE",
                    rationale: "Synthetic review retains the existing holding",
                    evidence: [source],
                    evidenceBundleIds: [],
                  },
                ],
              };
            }
            const reviewed = {
              ...initialDecision,
              portfolioTargets: initialDecision.portfolioTargets.map((item) =>
                item.marketSlug !== affectedSlug
                  ? item
                  : {
                      ...item,
                      ...(options.review === "reprice"
                        ? { maximumEntryPrice: D("0.65") }
                        : {}),
                      ...(options.review === "inflate"
                        ? { estimatedProbability: D("0.99") }
                        : {}),
                    },
              ),
            };
            phase = "reviewed";
            return reviewed;
          }
          researchTools = input.researchTools;
          const session = researchTools.createSession(input.limits);
          researchTools.recordProviderEvidenceSources([
            {
              ...source,
              excerpt: source.claimExcerpt,
              observedAt: observedAt.toISOString(),
              provider: "CLIENT_WEB_SEARCH",
            },
          ]);
          for (const market of markets) {
            const details = await session.execute(
              "get_market_details",
              { marketSlug: market.slug },
              input.signal,
            );
            assert.equal(JSON.parse(details.content).market.slug, market.slug);
          }
          const preview = await session.execute(
            "preview_trade",
            {
              marketSlug: affectedSlug,
              side: "LONG",
              action: "BUY",
              quantity: options.originallySmall ? "0.7" : "30",
              limitPrice: "0.31",
            },
            input.signal,
          );
          assert.equal(JSON.parse(preview.content).ok, true);
          const plan = {
            cycleSummary: "Synthetic independent entry and covered exit",
            evidenceBundles: [],
            portfolioTargets: [
              target(affectedSlug, {
                targetCostBasisFraction: options.originallySmall
                  ? "0.002"
                  : options.review === "reprice"
                    ? "0.4"
                    : "0.08",
              }),
              target(safeSlug),
              target(exitSlug, {
                targetCostBasisFraction: "0",
                estimatedProbability: "0.10",
                probabilityLowerBound: "0.05",
                probabilityUpperBound: "0.15",
                maximumEntryPrice: null,
                minimumExitPrice: "0.29",
              }),
            ],
            candidateDispositions: [],
          };
          let submission = await session.execute(
            "submit_trade_plan",
            options.normalRepair
              ? {
                  ...plan,
                  portfolioTargets: plan.portfolioTargets.filter(
                    (item) => item.marketSlug !== exitSlug,
                  ),
                }
              : plan,
            input.signal,
          );
          assert.equal(submission.kind, "DECISION");
          initialDecision = submission.decision;
          await input.recordTranscriptRound?.({
            round: 1,
            response: {},
            providerWebSearchCount: 0,
            toolCalls: [],
            toolResults: [],
          });
          if (!options.finalCollapse) phase = "terminal";
          let terminal = await input.reviewTerminalDecision(
            initialDecision,
            input.signal,
          );
          terminalReviews.push(terminal);
          if (options.normalRepair) {
            assert.equal(terminal.repair, true);
            session.reopenForTerminalDecisionRepair();
            phase = "terminal";
            const thinPreview = await session.execute(
              "preview_trade",
              {
                marketSlug: affectedSlug,
                side: "LONG",
                action: "BUY",
                quantity: "5",
                limitPrice: "0.31",
              },
              input.signal,
            );
            assert.equal(JSON.parse(thinPreview.content).ok, true);
            submission = await session.execute(
              "submit_trade_plan",
              {
                ...plan,
                portfolioTargets: plan.portfolioTargets.map((item) =>
                  item.marketSlug === affectedSlug
                    ? { ...item, targetCostBasisFraction: "0.016" }
                    : item,
                ),
              },
              input.signal,
            );
            assert.equal(submission.kind, "DECISION");
            initialDecision = submission.decision;
            terminal = await input.reviewTerminalDecision(
              initialDecision,
              input.signal,
            );
            terminalReviews.push(terminal);
          }
          assert.equal(terminal.repair, false, JSON.stringify(terminal));
          phase = "final";
          return initialDecision;
        },
      },
    });
    return {
      report,
      prompts,
      placements,
      reviews,
      terminalReviews,
      counts,
      initialDecision,
      artifact: async (kind) =>
        JSON.parse(
          await readFile(
            join(
              root,
              "runs",
              "synthetic-run",
              "synthetic-cycle",
              `${kind}.json`,
            ),
            "utf8",
          ),
        ).data,
    };
  }

  const accepted = (result, slug = affectedSlug) =>
    result.report.risk.accepted.find((item) => item.marketSlug === slug);
  const placed = (result, slug = affectedSlug) =>
    result.placements.find((item) => item.marketSlug === slug);
  const assertIndependentOrders = (result) => {
    assert(placed(result, safeSlug), JSON.stringify(result.report));
    assert(placed(result, exitSlug), JSON.stringify(result.report));
    assert.equal(placed(result, exitSlug).action, "SELL");
  };

  for (const finalCollapse of [false, true]) {
    const smaller = await run(`smaller-${finalCollapse}`, { finalCollapse });
    assert.equal(smaller.reviews.length, 1);
    assert.equal(placed(smaller).quantity.toFixed(), "5");
    assertIndependentOrders(smaller);
    assert.equal(
      smaller.report.currentCycleExecutions.find(
        (item) => item.marketSlug === affectedSlug,
      ).status,
      "FILLED",
    );
    assert.equal(accepted(smaller).estimatedProbability, "0.78");
  }

  const repriced = await run("reprice", { review: "reprice" });
  assert.equal(repriced.reviews.length, 1);
  assert.equal(placed(repriced).canonicalLimitPrice.toFixed(), "0.65");
  assert.equal(accepted(repriced).estimatedProbability, "0.78");
  assert.equal(accepted(repriced).riskAdjustedProbability, "0.74");
  assert(D(accepted(repriced).netEdge).gt(0));
  const repricedOrder = accepted(repriced);
  const repricedEffectivePrice = D("0.65").plus(
    D(repricedOrder.estimatedFees).div(repricedOrder.quantity),
  );
  // Independently check the binary-contract Kelly bound at the new price.
  const freshKellyBudget = D("0.74")
    .minus(repricedEffectivePrice)
    .div(D(1).minus(repricedEffectivePrice))
    .mul(repriced.report.accountBefore.riskEquity)
    .mul("0.25");
  assert(D(repricedOrder.maximumExecutionSpend).lte(freshKellyBudget));
  assert(
    freshKellyBudget.lt(D(repricedOrder.maximumRiskUsd)),
    "The synthetic reprice must actually make Kelly bind below the model budget",
  );
  assertIndependentOrders(repriced);

  for (const review of [
    "timeout",
    "malformed",
    "missing",
    "inflate",
    "failure",
  ]) {
    const skipped = await run(`invalid-${review}`, { review });
    assert.equal(skipped.reviews.length, 1);
    assert.equal(placed(skipped), undefined);
    assert.equal(accepted(skipped), undefined);
    assertIndependentOrders(skipped);
  }

  for (const [name, options] of [
    ["held-timeout", { originalHeld: true, review: "timeout" }],
    ["held-failure", { originalHeld: true, review: "failure" }],
    ["held-exhausted", { originalHeld: true, noReviewBudget: true }],
    ["held-choice", { originalHeld: true, review: "hold" }],
  ]) {
    const held = await run(name, options);
    assert.equal(held.reviews.length, options.noReviewBudget ? 0 : 1);
    assert.equal(placed(held), undefined);
    assert.equal(accepted(held), undefined);
    assertIndependentOrders(held);
    assert.equal(
      held.report.agent.portfolioTargets.some(
        (item) => item.marketSlug === affectedSlug,
      ),
      false,
    );
    assert.equal(
      held.report.agent.candidateDispositions.find(
        (item) => item.marketSlug === affectedSlug,
      ).outcome,
      "HOLD_UNCHANGED",
    );
    assert.equal(held.report.agent.decisionAudit.coverage.valid, true);
    assert.equal(
      held.report.accountAfter.positions.find(
        (item) => item.marketSlug === affectedSlug,
      ).quantity,
      "2",
    );
  }

  const repaired = await run("ordinary-repair-known-thin", {
    normalRepair: true,
  });
  assert.equal(repaired.terminalReviews.length, 2);
  assert.equal(repaired.reviews.length, 0);
  assert(placed(repaired).quantity.gt(0));
  assert(placed(repaired).quantity.lt(5));
  assertIndependentOrders(repaired);

  const repeated = await run("repeated", { repeatedCollapse: true });
  assert.equal(repeated.reviews.length, 1);
  assert.equal(placed(repeated), undefined);
  assertIndependentOrders(repeated);

  for (const [name, options] of [
    ["absent-policy", { policy: false }],
    ["unchanged-depth", { noCollapse: true }],
    ["originally-small", { originallySmall: true }],
  ]) {
    const unchanged = await run(name, options);
    assert.equal(unchanged.reviews.length, 0);
    assert(placed(unchanged));
    assertIndependentOrders(unchanged);
  }

  const exhausted = await run("exhausted-budget", { noReviewBudget: true });
  assert.equal(exhausted.reviews.length, 0);
  assert.equal(placed(exhausted), undefined);
  assertIndependentOrders(exhausted);

  const off = await run("diagnostics-off");
  const on = await run("diagnostics-on", { diagnostics: true });
  assert.deepEqual(on.prompts, off.prompts);
  assert.deepEqual(on.report, off.report);
  assert.deepEqual(on.counts, off.counts);
  assert.doesNotMatch(
    JSON.stringify(on.prompts),
    /execution-diagnostics|history-attribution|evidence-receipts/u,
  );

  const moved = await run("executor-movement", { executorMovement: true });
  assert.equal(moved.reviews.length, 1);
  assert.equal(placed(moved), undefined);
  assertIndependentOrders(moved);
  assert.match(
    moved.report.currentCycleExecutions.find(
      (item) => item.marketSlug === affectedSlug,
    ).skippedReason,
    /depth|fillable|executable/iu,
  );

  log(
    JSON.stringify({
      status: "PASS",
      checks:
        "bounded execution reassessment cycles, independent orders, frozen forecasts, deadlines, diagnostics isolation and final depth guard",
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  await rm(directory, { recursive: true, force: true });
}
