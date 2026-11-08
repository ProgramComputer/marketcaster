// check-strategy-policy.mjs
await (async () => {
  const { log } = await import("node:console");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Decimal } = await import("decimal.js");
  const { nearTouchBuyNotional } =
    await import("../dist/src/execution/depth.js");
  const { allocateBatchBudget } =
    await import("../dist/src/risk/batch-allocation.js");
  const { isRepairableRiskRejection } =
    await import("../dist/src/agent/decision-repair.js");
  const { loadStrategyPolicy, assertStrategyPolicy, refreshPolicyForecasts } =
    await import("../dist/src/strategy/policy.js");
  const { AbortController } = globalThis;

  const book = {
    yesAsks: [
      { price: new Decimal("0.4"), quantity: new Decimal(3) },
      { price: new Decimal("0.7"), quantity: new Decimal(9) },
    ],
    yesBids: [{ price: new Decimal("0.6"), quantity: new Decimal(4) }],
  };
  assert.equal(
    nearTouchBuyNotional(book, "YES", new Decimal(0)).toString(),
    "1.2",
  );
  assert.equal(
    nearTouchBuyNotional(book, "NO", new Decimal(0)).toString(),
    "1.6",
  );
  assert.equal(
    nearTouchBuyNotional(
      book,
      "YES",
      new Decimal("0.4"),
      new Decimal("0.5"),
    ).toString(),
    "1.2",
  );
  assert.throws(() => nearTouchBuyNotional(book, "YES", new Decimal(-1)));
  const candidate = {
    id: "synthetic",
    conservativeNetEdge: new Decimal("0.02"),
    minimumSpend: new Decimal(1),
    maximumSpend: new Decimal(3),
  };
  const input = { cycleBudget: new Decimal(2), candidates: [candidate] };
  assert.equal(allocateBatchBudget(input).committedSpend.toString(), "0");
  const result = allocateBatchBudget({
    ...input,
    allocationPolicy: () => [{ id: candidate.id, spend: new Decimal("1.5") }],
  });
  assert.equal(result.committedSpend.toString(), "1.5");
  assert.equal(result.unallocatedSpend.toString(), "0.5");
  assert.equal(result.allocations[0].candidate, candidate);
  const contextualCandidate = {
    ...candidate,
    context: {
      marketSlug: "synthetic",
      side: "YES",
      quoteObservedAt: "2026-01-01T00:00:00Z",
      authorizationProbability: new Decimal("0.6"),
      limitPrice: new Decimal("0.4"),
    },
  };
  allocateBatchBudget({
    ...input,
    candidates: [contextualCandidate],
    allocationPolicy: ({ candidates }) => {
      assert.equal(candidates[0].context.marketSlug, "synthetic");
      assert(Object.isFrozen(candidates[0].context));
      assert.notEqual(
        candidates[0].context.authorizationProbability,
        contextualCandidate.context.authorizationProbability,
      );
      assert.throws(() => {
        candidates[0].context.side = "NO";
      });
      return [{ id: candidate.id, spend: new Decimal(1) }];
    },
  });
  assert.equal(contextualCandidate.context.side, "YES");
  assert.throws(() =>
    allocateBatchBudget({
      ...input,
      candidates: [
        {
          ...contextualCandidate,
          context: {
            ...contextualCandidate.context,
            limitPrice: new Decimal(2),
          },
        },
      ],
    }),
  );
  for (const instructions of [
    [{ id: "unknown", spend: new Decimal(1) }],
    [{ id: candidate.id, spend: new Decimal("0.5") }],
    [{ id: candidate.id, spend: new Decimal(3) }],
    [{ id: candidate.id, spend: new Decimal("NaN") }],
    [
      { id: candidate.id, spend: new Decimal(1) },
      { id: candidate.id, spend: new Decimal(1) },
    ],
  ])
    assert.throws(() =>
      allocateBatchBudget({ ...input, allocationPolicy: () => instructions }),
    );
  assert.throws(() =>
    allocateBatchBudget({ ...input, candidates: [candidate, candidate] }),
  );
  // A policy may explain an intentional omission; the explanation is final.
  const second = { ...candidate, id: "synthetic-second" };
  const explainedIds = [];
  const explained = allocateBatchBudget({
    cycleBudget: new Decimal(5),
    candidates: [candidate, second],
    allocationPolicy: Object.assign(
      () => [{ id: candidate.id, spend: new Decimal(1) }],
      {
        omissionReason: (item) => {
          explainedIds.push(item.id);
          assert(Object.isFrozen(item));
          assert.notEqual(item, second);
          return " synthetic exclusion ";
        },
      },
    ),
  });
  assert.deepEqual(explainedIds, ["synthetic-second"]);
  assert.deepEqual(
    explained.unfunded.map((item) => [
      item.candidate.id,
      item.reason,
      item.policyExplanation,
      item.rank,
    ]),
    [["synthetic-second", "POLICY_UNFUNDED", "synthetic exclusion", 1]],
  );
  const silent = allocateBatchBudget({
    ...input,
    allocationPolicy: Object.assign(() => [], {
      omissionReason: () => undefined,
    }),
  });
  assert.equal("policyExplanation" in silent.unfunded[0], false);
  for (const bad of ["", " ", "x".repeat(241), "line\nbreak", 7])
    assert.throws(
      () =>
        allocateBatchBudget({
          ...input,
          allocationPolicy: Object.assign(() => [], {
            omissionReason: () => bad,
          }),
        }),
      /omission reason/,
    );
  assert.equal(isRepairableRiskRejection("POLICY_UNFUNDED"), false);
  assert.equal(isRepairableRiskRejection("CYCLE_SPEND"), true);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "marketcaster-policy-"),
  );
  try {
    await assert.rejects(
      loadStrategyPolicy(join(temporaryDirectory, "missing.mjs")),
    );
    const invalid = join(temporaryDirectory, "invalid.mjs");
    await writeFile(invalid, "export default () => ({apiVersion: 999});\n");
    await assert.rejects(loadStrategyPolicy(invalid), /version 1/);
    const valid = join(temporaryDirectory, "valid.mjs");
    await writeFile(
      valid,
      "export default api => ({apiVersion:1, selection:{buildOpportunityBoard:()=>[], buildEnrichedOpportunityBoard:async()=>[], selectRequiredMarketSlugs:()=>[]}, allocation:()=>[], passAuditMinimumEdge:new api.Decimal(0)});\n",
    );
    const strategy = await loadStrategyPolicy(valid);
    assert.equal(strategy.apiVersion, 1);
    assert.equal(strategy.allocation(input).length, 0);
    for (const invalid of [
      { ...strategy, selection: { ...strategy.selection, allowWebSearch: 7 } },
      {
        ...strategy,
        selection: { ...strategy.selection, depthPriceBand: new Decimal(-1) },
      },
      {
        ...strategy,
        selection: { ...strategy.selection, experimentDefinition: {} },
      },
      { ...strategy, executionCooldownMilliseconds: { NO_FILL: -1 } },
      { ...strategy, reconciliationTolerance: 7 },
      { ...strategy, selectMemoryContext: 7 },
      { ...strategy, resolutionReview: {} },
      {
        ...strategy,
        allocation: Object.assign(() => [], { omissionReason: "synthetic" }),
      },
    ])
      assert.throws(() => assertStrategyPolicy(invalid));
    assertStrategyPolicy({
      ...strategy,
      allocation: Object.assign(() => [], { omissionReason: () => undefined }),
    });
    const requests = [{ marketSlug: "synthetic", side: "YES" }];
    for (const point of [
      new Decimal("NaN"),
      new Decimal("Infinity"),
      new Decimal(-1),
      new Decimal(2),
    ]) {
      await assert.rejects(
        refreshPolicyForecasts(
          {
            refreshForecasts: async () => ({
              requiredMarketSlugs: new Set(["synthetic"]),
              selectedSideProbabilityByMarketSlug: new Map([
                ["synthetic", point],
              ]),
            }),
          },
          requests,
          new Map(),
          new Date(),
          new AbortController().signal,
        ),
        /finite probabilities/,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  log("Strategy loader and allocation boundary checks passed");
})();

// check-selection-policy.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { default: process } = await import("node:process");
  const { Decimal } = await import("decimal.js");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DEFAULT_DECISION_LIMITS } =
    await import("../dist/src/llm/decision-provider.js");
  const { DecisionResearchTools } =
    await import("../dist/src/llm/research-tools.js");
  const {
    buildOpportunityBoard,
    buildEnrichedOpportunityBoard,
    referenceSelectionPolicy,
    isTradeableEnrichment,
  } = await import("../dist/src/agent/opportunity-board.js");
  const { buildFamilyScout } =
    await import("../dist/src/agent/family-scout.js");
  const { freezeMarketSelectionSnapshot, replayMarketSelectionExperiment } =
    await import("../dist/src/experiments/market-selection.js");
  const now = new Date("2030-01-01T00:00:00Z");
  const markets = Array.from({ length: 6 }, (_, index) => ({
    id: { exchange: "kalshi", value: `synthetic-${index}` },
    slug: `synthetic-${index}`,
    eventId: "synthetic-event",
    title: `Synthetic outcome ${index}`,
    description: "Synthetic fixture",
    settlementRules: "Use the synthetic result.",
    active: true,
    closed: false,
    archived: false,
    closesAt: new Date("2030-01-02T00:00:00Z"),
    lastPrice: new Decimal("0.5"),
    minimumTradeQuantity: new Decimal(1),
    priceTick: new Decimal("0.01"),
  }));
  const catalog = {
    markets: [...markets, markets[0]],
    bySlug: new Map(markets.map((market) => [market.slug, market])),
    exchangeRanks: new Map(
      markets.map((market, index) => [market.slug, 6 - index]),
    ),
    heldSlugs: new Set([markets[5].slug]),
    categoryCounts: {},
    exchangeRankingBasis: "EXCHANGE_DEFAULT",
    warnings: [],
  };
  const config = {
    opportunityBoardVariant: "SYNTHETIC",
    maximumPromptMarkets: 3,
    minimumMinutesToClose: 0,
    maximumDaysToClose: 2,
    maximumSpread: new Decimal("0.05"),
    minimumLiquidityUsd: new Decimal(0),
    minimumVolume24hUsd: new Decimal(0),
    allowIfLiquidityOrVolumePasses: true,
  };
  const board = buildOpportunityBoard(catalog, config, now);
  assert.deepEqual(
    board.map((row) => row.slug),
    ["synthetic-4", "synthetic-3", "synthetic-2"],
  );
  assert(
    board.every(
      (row) =>
        row.prioritySignal === undefined && row.familyScout === undefined,
    ),
  );
  assert.deepEqual(
    referenceSelectionPolicy.selectRequiredMarketSlugs(board),
    [],
  );
  assert.throws(
    () => buildOpportunityBoard(catalog, config, new Date(Number.NaN)),
    TypeError,
  );

  const enrichedConfig = {
    ...config,
    familyScouts: {
      enabled: true,
      reservedPromptMarkets: 0,
      maximumFamilies: 1,
      maximumMembersPerFamily: 2,
      minimumFamilyMembers: 2,
      enrichmentRequestBudget: 2,
      scoringWeights: Object.fromEntries(
        [
          "liquidityOrDepth",
          "volume24h",
          "uncertainty",
          "exchangeRankQuality",
          "cappedRecurrence",
        ].map((key) => [key, new Decimal(0)]),
      ),
    },
  };
  let requests = 0;
  const enriched = await buildEnrichedOpportunityBoard(
    catalog,
    enrichedConfig,
    async (slug) => {
      requests += 1;
      return {
        market: catalog.bySlug.get(slug),
        bbo: {
          yes: { bid: new Decimal("0.4"), ask: new Decimal("0.6") },
          no: {},
        },
      };
    },
    now,
  );
  assert.equal(requests, 2);
  assert.deepEqual(
    enriched.map((row) => row.slug),
    ["synthetic-2", "synthetic-1", "synthetic-0"],
  );
  const mismatch = await buildEnrichedOpportunityBoard(
    catalog,
    enrichedConfig,
    async () => ({ market: markets[0] }),
    now,
  );
  assert.deepEqual(
    mismatch.map((row) => row.slug),
    ["synthetic-2", "synthetic-1", "synthetic-0"],
  );
  const executable = {
    market: markets[0],
    quoteStatus: "AVAILABLE",
    bookStatus: "AVAILABLE",
    bbo: { yes: { bid: new Decimal("0.4"), ask: new Decimal("0.41") }, no: {} },
    yesNearTouchBuyNotionalUsd: 2,
  };
  assert.equal(isTradeableEnrichment(executable, 2), true);
  assert.equal(isTradeableEnrichment(executable, 2.01), false);
  assert.equal(isTradeableEnrichment(executable, 2, 0.01), true);
  assert.equal(isTradeableEnrichment(executable, 2, 0.009), false);
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => isTradeableEnrichment(executable, 2, invalid),
      RangeError,
    );
  const narrowQuote = { bid: new Decimal("0.4"), ask: new Decimal("0.41") };
  const wideQuote = { bid: new Decimal("0.4"), ask: new Decimal("0.6") };
  for (const [snapshot, expected] of [
    [
      {
        bbo: { yes: {}, no: wideQuote },
        yesNearTouchBuyNotionalUsd: 0,
        noNearTouchBuyNotionalUsd: 2,
      },
      false,
    ],
    [
      {
        bbo: { yes: wideQuote, no: narrowQuote },
        yesNearTouchBuyNotionalUsd: 2,
        noNearTouchBuyNotionalUsd: 0,
      },
      false,
    ],
    [
      {
        bbo: { yes: narrowQuote, no: wideQuote },
        yesNearTouchBuyNotionalUsd: 0,
        noNearTouchBuyNotionalUsd: 2,
      },
      false,
    ],
    [
      {
        bbo: { yes: {}, no: narrowQuote },
        yesNearTouchBuyNotionalUsd: 0,
        noNearTouchBuyNotionalUsd: 2,
      },
      true,
    ],
    [
      {
        bbo: { yes: wideQuote, no: narrowQuote },
        yesNearTouchBuyNotionalUsd: 2,
        noNearTouchBuyNotionalUsd: 2,
      },
      true,
    ],
  ]) {
    const snapshotResult = { ...executable, ...snapshot };
    assert.equal(isTradeableEnrichment(snapshotResult, 2, 0.05), expected);
    const snapshotBoard = await buildEnrichedOpportunityBoard(
      catalog,
      { ...enrichedConfig, minimumNearTouchBuyNotionalUsd: new Decimal(2) },
      async (slug) => ({ ...snapshotResult, market: catalog.bySlug.get(slug) }),
      now,
    );
    assert.equal(snapshotBoard.length, expected ? 2 : 0);
  }
  for (const patch of [
    { quoteStatus: "EMPTY" },
    { quoteStatus: "UNAVAILABLE" },
    { bookStatus: "UNAVAILABLE" },
    { bookStatus: "NOT_REQUESTED" },
    { yesNearTouchBuyNotionalUsd: 0 },
    { yesNearTouchBuyNotionalUsd: Number.NaN },
    { yesNearTouchBuyNotionalUsd: Number.POSITIVE_INFINITY },
    {
      bbo: {
        yes: { bid: new Decimal("0.5"), ask: new Decimal("0.4") },
        no: {},
      },
    },
  ])
    assert.equal(isTradeableEnrichment({ ...executable, ...patch }), false);
  assert.throws(() => isTradeableEnrichment(executable, -1), RangeError);
  assert.equal(
    isTradeableEnrichment({
      ...executable,
      yesNearTouchBuyNotionalUsd: 100,
      noNearTouchBuyNotionalUsd: 0,
      bbo: {
        yes: {},
        no: { bid: new Decimal("0.4"), ask: new Decimal("0.41") },
      },
    }),
    false,
    "The executable quote and depth must belong to the same side",
  );
  const strict = await buildEnrichedOpportunityBoard(
    catalog,
    { ...enrichedConfig, minimumNearTouchBuyNotionalUsd: new Decimal(1) },
    async (slug) => ({ ...executable, market: catalog.bySlug.get(slug) }),
    now,
  );
  assert.deepEqual(
    strict.map((row) => row.slug),
    ["synthetic-4", "synthetic-3"],
    "A configured threshold never backfills uninspected rows",
  );
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    buildEnrichedOpportunityBoard(
      catalog,
      enrichedConfig,
      async () => {
        throw new Error("must not be called");
      },
      now,
      controller.signal,
    ),
  );

  const rows = markets.map((market, index) => ({
    market,
    exchangeRank: index + 1,
  }));
  const options = {
    maximumFamilies: 1,
    maximumMembersPerFamily: 2,
    minimumFamilyMembers: 2,
  };
  assert.deepEqual(
    buildFamilyScout(rows, options)[0].sampledMembers.map(
      (row) => row.market.slug,
    ),
    ["synthetic-0", "synthetic-1"],
  );
  assert.deepEqual(
    buildFamilyScout(rows, {
      ...options,
      selectMembers: (members) => members.slice(-2),
    })[0].sampledMembers.map((row) => row.market.slug),
    ["synthetic-4", "synthetic-5"],
  );
  assert.throws(
    () =>
      buildFamilyScout(rows, {
        ...options,
        selectMembers: (members) => [members[0], members[0]],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      buildFamilyScout(rows, {
        ...options,
        selectMembers: (members) => members,
      }),
    TypeError,
  );

  const snapshot = freezeMarketSelectionSnapshot(
    { ...catalog, markets },
    config,
    now,
  );
  const definition = {
    experimentId: "synthetic-comparison",
    hypothesis: "Compare two supplied orderings.",
    controlVariant: "FIRST",
    treatmentVariant: "LAST",
    limitations: ["Synthetic fixtures only."],
  };
  const report = replayMarketSelectionExperiment(
    snapshot,
    definition,
    (input, policy, at, variant) => {
      const selected = buildOpportunityBoard(input, policy, at);
      return variant === "LAST" ? selected.slice(-1) : selected.slice(0, 1);
    },
  );
  assert.equal(report.experimentId, definition.experimentId);
  assert.equal(report.comparison.overlapCount, 0);
  assert.equal(report.control.selections.length, 1);
  assert.equal(report.treatment.selections.length, 1);
  const prompts = await loadPromptBundle();
  const terminalPlan = {
    cycleSummary: "Synthetic plan",
    evidenceBundles: [],
    portfolioTargets: [],
    candidateDispositions: [],
  };
  const gateOptions = {
    prompts: prompts.research,
    requiredPriorityEvidenceMarketSlugs: ["synthetic-uninspected"],
  };
  const gateSignal = new globalThis.AbortController().signal;
  const uniform = await new DecisionResearchTools(gateOptions)
    .createSession(DEFAULT_DECISION_LIMITS)
    .execute("submit_trade_plan", terminalPlan, gateSignal);
  assert.equal(uniform.isError, true);
  assert.match(uniform.content, /PRIORITY_RESEARCH_REQUIRED/u);
  let gateCalls = 0;
  const supplied = await new DecisionResearchTools({
    ...gateOptions,
    requiredResearchGate: (decision, details) => {
      gateCalls += 1;
      assert.equal(decision.cycleSummary, terminalPlan.cycleSummary);
      assert.equal(details.size, 0);
      return false;
    },
  })
    .createSession(DEFAULT_DECISION_LIMITS)
    .execute("submit_trade_plan", terminalPlan, gateSignal);
  assert.equal(supplied.kind, "DECISION");
  assert.equal(gateCalls, 1);
  process.stdout.write(
    "Synthetic selection contract, budget, cancellation, grouping, and replay checks passed.\n",
  );
})();

// check-forecast-policy.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { log } = await import("node:console");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DEFAULT_DECISION_LIMITS } =
    await import("../dist/src/llm/decision-provider.js");
  const { DecisionResearchTools, forecastPolicyApi } =
    await import("../dist/src/llm/research-tools.js");
  const prompts = await loadPromptBundle();
  const { AbortController } = globalThis;
  const signal = new AbortController().signal;
  const details = {
    id: "synthetic-id",
    slug: "synthetic-market",
    title: "Synthetic event",
    description: "Synthetic engine-contract fixture",
    settlementRules: "YES if the synthetic event occurs; otherwise NO.",
    category: "Synthetic",
    active: true,
    closed: false,
    archived: false,
    minimumTradeQuantity: "1",
    priceTick: "0.01",
    quoteAvailable: false,
    warnings: [],
    held: false,
  };

  let sourceReads = 0;
  const reader = async () => {
    sourceReads += 1;
    return { text: "Observed synthetic value: 7" };
  };
  const baseline = new DecisionResearchTools({
    prompts: prompts.research,
    marketDetails: [details],
    evidencePageReader: reader,
  });
  const baselineResult = await baseline
    .createSession(DEFAULT_DECISION_LIMITS)
    .execute("get_market_details", { marketSlug: details.slug }, signal);
  assert.equal(baselineResult.isError, false);
  assert.equal(sourceReads, 0);
  assert.equal(baseline.observedEvidenceSources.length, 0);
  assert.equal(
    JSON.parse(baselineResult.content).liveEvidenceSources,
    undefined,
  );

  const operations = [];
  const policy = {
    forecastTolerance: new forecastPolicyApi.Decimal("0.01"),
    systemLiveEvidenceSources: () => [
      {
        title: "Synthetic source",
        url: "https://example.com/synthetic-evidence",
        findHint: "synthetic",
      },
    ],
    liveEvidenceLinePreview: (text) => ({
      evidenceExcerpt: text,
      preview: `${text}\nDerived synthetic estimate: 0.4`,
    }),
    refreshForecasts: async () => ({
      requiredMarketSlugs: new Set(),
      selectedSideProbabilityByMarketSlug: new Map(),
    }),
  };
  const tools = new DecisionResearchTools({
    prompts: prompts.research,
    marketDetails: [details],
    evidencePageReader: reader,
    forecastPolicy: policy,
    agentStateHandler: async (operation) => {
      operations.push(operation);
      return { action: operation.action };
    },
  });
  const session = tools.createSession(DEFAULT_DECISION_LIMITS);
  const result = await session.execute(
    "get_market_details",
    { marketSlug: details.slug },
    signal,
  );
  assert.equal(result.isError, false);
  assert.equal(sourceReads, 1);
  assert.match(
    JSON.parse(result.content).liveEvidenceSources[0].preview,
    /Derived synthetic estimate/u,
  );
  assert.equal(tools.observedEvidenceSources.length, 1);
  assert.equal(
    tools.observedEvidenceSources[0].excerpt,
    "Observed synthetic value: 7",
  );
  assert.doesNotMatch(
    JSON.stringify(tools.observedEvidenceSources),
    /Derived synthetic estimate/u,
  );

  const update = {
    action: "UPDATE_BELIEF",
    beliefId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "SUPERSEDED",
    supersedesBeliefId: null,
    expiresAt: null,
    reviewAt: "2026-01-02T00:00:00Z",
  };
  const updateResult = await session.execute("manage_state", update, signal);
  assert.equal(updateResult.isError, false);
  assert.deepEqual(operations[0], update);
  assert.equal("evidenceUrls" in operations[0], false);
  assert.equal("basisMarketSlugs" in operations[0], false);

  log(
    "Forecast policy injection, evidence separation, and state metadata checks passed.",
  );
})();

// check-resolution-review.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { log } = await import("node:console");
  const { Decimal } = await import("decimal.js");
  const { reviewResolvedTargets } =
    await import("../dist/src/strategy/resolution-review.js");
  const { applyFreshForecastProbability } =
    await import("../dist/src/risk/validate.js");
  const { AbortController } = globalThis;

  const now = () => new Date("2026-01-02T12:00:00Z");
  const target = {
    marketSlug: "synthetic-market",
    side: "YES",
    targetCostBasisFraction: new Decimal("0.1"),
  };
  const details = new Map([
    [target.marketSlug, { id: "synthetic-id", slug: target.marketSlug }],
  ]);
  let reviews = 0;
  const policy = {
    selectMarketSlugs: () => [target.marketSlug],
    reviewTarget: ({ resolution }) => {
      reviews++;
      assert.equal(resolution.kind, "AUTHORITATIVE_RESOLUTION");
      return "Synthetic deployment requests review";
    },
  };
  const base = {
    policy,
    targets: [target],
    details,
    now,
    signal: new AbortController().signal,
    forecasts: {
      requiredMarketSlugs: new Set([target.marketSlug]),
      selectedSideProbabilityByMarketSlug: new Map([
        [target.marketSlug, new Decimal(0)],
      ]),
    },
  };
  const final = {
    marketId: { exchange: "polymarket-us", value: "synthetic-id" },
    state: "SETTLED_NO",
    settlementPrice: new Decimal(0),
    settledAt: new Date("2026-01-02T11:00:00Z"),
  };
  for (const status of [
    { ...final, state: "OPEN" },
    { ...final, state: "VOID", settlementPrice: new Decimal("0.5") },
    { ...final, settlementPrice: new Decimal(1) },
    { ...final, marketId: { ...final.marketId, value: "other-id" } },
    { ...final, marketId: { ...final.marketId, exchange: "kalshi" } },
    { ...final, settledAt: new Date("2026-01-03T00:00:00Z") },
  ]) {
    const result = await reviewResolvedTargets({
      ...base,
      exchange: { id: "polymarket-us", getSettlement: async () => status },
    });
    assert.equal(result.issues.length, 0);
    assert.equal(result.observations[0].kind, "UNCONFIRMED");
  }
  assert.equal(
    reviews,
    0,
    "A forecast of zero or inconsistent settlement must never invoke resolution policy",
  );
  const result = await reviewResolvedTargets({
    ...base,
    exchange: { id: "polymarket-us", getSettlement: async () => final },
  });
  assert.equal(reviews, 1);
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.observations[0].resolution.source, {
    exchange: "polymarket-us",
    operation: "getSettlement",
  });
  assert.equal(result.observations[0].resolution.marketId, "synthetic-id");
  assert.equal(
    result.observations[0].resolution.observedAt,
    now().toISOString(),
  );
  const unavailable = await reviewResolvedTargets({
    ...base,
    exchange: {
      id: "polymarket-us",
      getSettlement: async () => {
        throw new Error("Synthetic unavailable");
      },
    },
  });
  assert.equal(unavailable.observations[0].kind, "UNCONFIRMED");
  assert.equal(reviews, 1);
  await assert.rejects(
    reviewResolvedTargets({
      ...base,
      policy: { ...policy, selectMarketSlugs: () => ["other"] },
      exchange: { id: "polymarket-us" },
    }),
    /untargeted/u,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reviewResolvedTargets({
      ...base,
      signal: controller.signal,
      exchange: { id: "polymarket-us" },
    }),
  );
  const fresh = applyFreshForecastProbability(
    {
      estimatedProbability: new Decimal("0.4"),
      probabilityLowerBound: new Decimal("0.2"),
      probabilityUpperBound: new Decimal("0.8"),
    },
    new Decimal(0),
  );
  assert(
    fresh.probabilityUpperBound.eq("0.8"),
    "A fresh zero estimate must not collapse uncertainty to settlement certainty",
  );
  log(
    "Resolution identity, timestamp, source, forecast separation and unavailable-state checks passed.",
  );
})();

// check-runtime-overrides.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { DEFAULT_REPORT_DIRECTORY, loadRuntimeConfiguration } =
    await import("../dist/src/config/runtime-overrides.js");
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "marketcaster-overrides-"),
  );

  try {
    const defaults = await loadRuntimeConfiguration({});
    assert.equal(defaults.config.reporting.directory, DEFAULT_REPORT_DIRECTORY);
    assert.equal(
      defaults.config.marketSelection.opportunityBoardVariant,
      "EXCHANGE_RANK",
    );
    assert.deepEqual(defaults.config.exchange.managedRestingBuyOrders, {
      enabled: false,
      maximumLifetimeMinutes: 15,
    });

    const alternatePromptPath = join(temporaryDirectory, "decision-system.md");
    const alternatePrompt = "Reference override smoke-test system prompt.";
    await writeFile(alternatePromptPath, alternatePrompt, "utf8");

    const alternateConfigPath = join(temporaryDirectory, "alternate.json");
    const defaultConfig = await readFile(
      resolve("config", "default.json"),
      "utf8",
    );
    const alternateValue = JSON.parse(defaultConfig);
    alternateValue.marketSelection.maximumPromptMarkets = 23;
    alternateValue.exchange.managedRestingBuyOrders = {
      enabled: true,
      maximumLifetimeMinutes: 10,
    };
    alternateValue.reporting.directory = "from-explicit-config";
    const alternateConfig = JSON.stringify(alternateValue);
    assert.notEqual(alternateConfig, defaultConfig);
    await writeFile(alternateConfigPath, alternateConfig, "utf8");

    const overridden = await loadRuntimeConfiguration({
      MARKETCASTER_CONFIG_PATH: alternateConfigPath,
      MARKETCASTER_DECISION_PROMPT_PATH: alternatePromptPath,
      MARKETCASTER_REPORT_DIR: "from-report-override",
    });
    assert.equal(overridden.config.marketSelection.maximumPromptMarkets, 23);
    assert.deepEqual(overridden.config.exchange.managedRestingBuyOrders, {
      enabled: true,
      maximumLifetimeMinutes: 10,
    });
    assert.equal(overridden.config.reporting.directory, "from-report-override");
    assert.equal(overridden.prompts.decision.system, alternatePrompt);
    assert.equal(
      overridden.prompts.decision.user,
      defaults.prompts.decision.user,
    );

    const restored = await loadRuntimeConfiguration({});
    assert.equal(
      restored.config.marketSelection.maximumPromptMarkets,
      defaults.config.marketSelection.maximumPromptMarkets,
    );
    assert.equal(
      restored.prompts.decision.system,
      defaults.prompts.decision.system,
    );

    await assert.rejects(
      loadRuntimeConfiguration({
        MARKETCASTER_CONFIG_PATH: join(temporaryDirectory, "missing.json"),
      }),
    );
    await assert.rejects(
      loadRuntimeConfiguration({
        MARKETCASTER_DECISION_PROMPT_PATH: join(
          temporaryDirectory,
          "missing-system.md",
        ),
      }),
    );

    const malformedConfigPath = join(temporaryDirectory, "malformed.json");
    await writeFile(malformedConfigPath, "{", "utf8");
    await assert.rejects(
      loadRuntimeConfiguration({
        MARKETCASTER_CONFIG_PATH: malformedConfigPath,
      }),
      /Invalid JSON in configuration file/u,
    );

    const customVariantPath = join(temporaryDirectory, "custom-variant.json");
    await writeFile(
      customVariantPath,
      defaultConfig.replace('"EXCHANGE_RANK"', '"SYNTHETIC_CUSTOM"'),
    );
    await assert.rejects(
      loadRuntimeConfiguration({ MARKETCASTER_CONFIG_PATH: customVariantPath }),
      /requires MARKETCASTER_STRATEGY_PATH/,
    );
    await assert.rejects(
      loadRuntimeConfiguration({
        MARKETCASTER_STRATEGY_PATH: join(temporaryDirectory, "missing.mjs"),
      }),
    );
    const invalidConfigPath = join(temporaryDirectory, "invalid.json");
    await writeFile(invalidConfigPath, "{}\n", "utf8");
    await assert.rejects(
      loadRuntimeConfiguration({
        MARKETCASTER_CONFIG_PATH: invalidConfigPath,
      }),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
})();
