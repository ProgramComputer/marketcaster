// check-source-and-reconciliation.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { Decimal } = await import("decimal.js");
  const { fetchEvidencePage } =
    await import("../src/agent/evidence-provenance.ts");
  const { reconcilePortfolioTargets } =
    await import("../src/portfolio/target-reconciliation.ts");
  // Offline responses only. An explicit source hostname must not trigger a
  // second, unrequested fetch or combine another response with this URL's text.
  const requestedUrl = "https://source.example.test/fixture-page";
  const requests = [];
  const page = await fetchEvidencePage(requestedUrl, {
    lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImplementation: async (url) => {
      requests.push(String(url));
      return new globalThis.Response(
        "<html><body>Synthetic original page claim.</body></html>",
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  assert.deepEqual(requests, [requestedUrl]);
  assert.equal(page.finalUrl, requestedUrl);
  assert.equal(page.text, "Synthetic original page claim.");

  const explicitUrl = "https://example.test/fixture-feed";
  const explicitRequests = [];
  const direct = await fetchEvidencePage(explicitUrl, {
    lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImplementation: async (url) => {
      explicitRequests.push(String(url));
      return new globalThis.Response(
        '{"observation":"Synthetic explicit response"}',
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  assert.deepEqual(explicitRequests, [explicitUrl]);
  assert.equal(direct.finalUrl, explicitUrl);
  assert.equal(direct.text, '{"observation":"Synthetic explicit response"}');

  const decimal = (value = 0) => new Decimal(value);
  const target = {
    marketSlug: "fixture-market",
    side: "YES",
    targetCostBasisFraction: decimal("0.1001"),
    estimatedProbability: decimal("0.5"),
    probabilityLowerBound: decimal("0.4"),
    probabilityUpperBound: decimal("0.6"),
    confidence: "LOW",
    thesis: "Synthetic target",
    settlementVerification: "Synthetic rules",
    invalidationConditions: "Synthetic condition",
    evidence: [],
  };
  const position = {
    marketId: { exchange: "kalshi", value: "fixture-market" },
    marketSlug: "fixture-market",
    side: "YES",
    quantity: decimal(20),
    availableQuantity: decimal(20),
    costBasis: decimal(10),
    realizedPnl: decimal(0),
    expired: false,
  };
  const input = {
    targets: [target],
    riskEquity: decimal(100),
    snapshot: { positions: [position] },
  };
  assert.equal(
    reconcilePortfolioTargets(input).dispositions[0].reason,
    "INCREASE_TO_TARGET",
    "No policy tolerance is assumed",
  );
  assert.equal(
    reconcilePortfolioTargets({
      ...input,
      targetRoundingToleranceUsd: decimal("0.01"),
    }).dispositions[0].reason,
    "TARGET_REACHED",
    "A supplied tolerance applies at exact equality",
  );
  assert.equal(
    reconcilePortfolioTargets({
      ...input,
      targetRoundingToleranceUsd: decimal("0.009"),
    }).dispositions[0].reason,
    "INCREASE_TO_TARGET",
  );
  assert.equal(
    reconcilePortfolioTargets({
      ...input,
      targets: [{ ...target, targetCostBasisFraction: decimal(0) }],
      targetRoundingToleranceUsd: decimal(100),
    }).dispositions[0].reason,
    "EXIT_TO_ZERO",
    "Tolerance never suppresses an explicit zero-target exit",
  );
  assert.throws(
    () =>
      reconcilePortfolioTargets({
        ...input,
        targetRoundingToleranceUsd: decimal(-1),
      }),
    /targetRoundingToleranceUsd/u,
  );
  assert.throws(
    () =>
      reconcilePortfolioTargets({
        ...input,
        targetRoundingToleranceUsd: decimal(Infinity),
      }),
    /targetRoundingToleranceUsd/u,
  );
})();

// check-state-lifecycle.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Decimal } = await import("decimal.js");
  const { FileAgentState } = await import("../src/agent/agent-state.ts");
  const { mapFill, mapResolution } =
    await import("../src/exchanges/kalshi/mappers.ts");
  const { KalshiFillSchema, KalshiSettlementSchema } =
    await import("../src/exchanges/kalshi/schemas.ts");
  const { buildCycleReport } = await import("../src/reporting/build-report.ts");
  const { persistCrossCycleHistory } =
    await import("../src/reporting/cross-cycle-history.ts");
  // Synthetic, offline fixtures only. Run with node --import tsx.
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "marketcaster-state-lifecycle-"),
  );
  const timestamp = "2026-01-02T00:00:00.000Z";
  const now = () => new Date(timestamp);
  const decimal = (value = 0) => new Decimal(value);

  try {
    const path = join(temporaryDirectory, "state.json");
    const legacyBelief = {
      id: "00000000-0000-4000-8000-000000000001",
      type: "EVENT_ANALYSIS",
      confidence: 50,
      content: "Synthetic initial observation.",
      marketSlugs: ["fixture-market"],
      evidenceUpdatedAt: timestamp,
      invalidationConditions: ["Synthetic source corrected."],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const legacyPlan = {
      content: "Review synthetic observation.",
      marketSlugs: ["fixture-market"],
      updatedAt: timestamp,
    };
    const legacy = {
      version: 2,
      beliefs: [legacyBelief],
      nextCyclePlan: legacyPlan,
      longTermPlan: null,
    };
    const legacySource = JSON.stringify(legacy);
    await writeFile(path, legacySource);
    const state = new FileAgentState({ filePath: path, now });
    const loaded = await state.load();
    assert.deepEqual(loaded.beliefs, [legacyBelief]);
    assert.deepEqual(loaded.nextCyclePlan, legacyPlan);
    assert.equal(
      await readFile(path, "utf8"),
      legacySource,
      "Old v2 state should not be rewritten merely to add defaults",
    );

    const references = {
      evidenceUrls: ["https://example.test/evidence"],
      basisMarketSlugs: ["fixture-market"],
    };
    await state.manage({
      action: "UPDATE_BELIEF",
      beliefId: legacyBelief.id,
      ...references,
      reviewAt: "2026-01-01T12:00:00-06:00",
    });
    await state.manage({
      action: "UPDATE_BELIEF",
      beliefId: legacyBelief.id,
      confidence: 51,
    });
    const reloaded = new FileAgentState({ filePath: path, now });
    const persisted = (await reloaded.load()).beliefs[0];
    assert.deepEqual(persisted.evidenceUrls, references.evidenceUrls);
    assert.deepEqual(persisted.basisMarketSlugs, references.basisMarketSlugs);
    assert.equal(
      persisted.reviewAt,
      "2026-01-01T18:00:00.000Z",
      "Overdue review alone does not remove a belief",
    );
    await state.manage({
      action: "SET_NEXT_CYCLE_PLAN",
      content: legacyPlan.content,
      marketSlugs: legacyPlan.marketSlugs,
      ...references,
      reviewAt: timestamp,
    });
    assert.deepEqual(
      (await reloaded.load()).nextCyclePlan.evidenceUrls,
      references.evidenceUrls,
    );
    assert.equal((await reloaded.load()).nextCyclePlan.reviewAt, timestamp);

    const correction = await state.manage({
      action: "ADD_BELIEF",
      type: "EVENT_ANALYSIS",
      confidence: 50,
      content: "Synthetic corrected observation.",
      marketSlugs: ["fixture-market"],
      evidenceUpdatedAt: timestamp,
      invalidationConditions: [],
      ...references,
      supersedesBeliefId: legacyBelief.id,
      expiresAt: "2026-01-03T00:00:00Z",
    });
    assert.deepEqual(
      (await reloaded.load()).beliefs.map((belief) => belief.id),
      [correction.mutatedBeliefId],
    );
    assert.equal(
      (await state.manage({ action: "LIST" })).beliefs.length,
      2,
      "LIST retains superseded audit history",
    );
    const beforeInvalid = await readFile(path, "utf8");
    await assert.rejects(
      state.manage({
        action: "UPDATE_BELIEF",
        beliefId: legacyBelief.id,
        supersedesBeliefId: correction.mutatedBeliefId,
      }),
      /cycle/u,
    );
    assert.equal(
      await readFile(path, "utf8"),
      beforeInvalid,
      "Cyclic supersession must fail atomically",
    );
    await state.manage({
      action: "UPDATE_BELIEF",
      beliefId: correction.mutatedBeliefId,
      expiresAt: timestamp,
    });
    assert.equal(
      (await reloaded.load()).beliefs.length,
      0,
      "Expiry applies at its exact boundary",
    );
    assert.equal((await reloaded.load()).inactiveBeliefCount, 2);
    await state.manage({
      action: "UPDATE_BELIEF",
      beliefId: correction.mutatedBeliefId,
      expiresAt: null,
    });
    assert.equal(
      (await reloaded.load()).beliefs.length,
      1,
      "Explicit null clears expiry",
    );
    await state.manage({
      action: "UPDATE_BELIEF",
      beliefId: correction.mutatedBeliefId,
      status: "INVALIDATED",
    });
    assert.equal((await reloaded.load()).beliefs.length, 0);
    await state.manage({
      action: "DELETE_BELIEF",
      beliefId: correction.mutatedBeliefId,
    });
    assert.equal(
      (await reloaded.load()).beliefs.length,
      0,
      "Deleting a correction does not reactivate its predecessor",
    );

    const fill = mapFill(
      KalshiFillSchema.parse({
        fill_id: "fixture-fill",
        order_id: "fixture-order",
        ticker: "fixture-market",
        outcome_side: "yes",
        book_side: "bid",
        side: "yes",
        action: "buy",
        count_fp: "2",
        yes_price_dollars: "0.4",
        no_price_dollars: "0.6",
        is_taker: true,
        fee_cost: "0.01",
        created_time: timestamp,
      }),
    );
    assert.equal(fill.orderId, "fixture-order");
    assert.equal(fill.fillId, "fixture-fill");
    assert.equal(
      fill.realizedPnl,
      undefined,
      "A fill without exchange-reported realized PnL is not a known zero outcome",
    );
    const settlement = mapResolution(
      KalshiSettlementSchema.parse({
        ticker: "fixture-resolved-market",
        yes_count_fp: "2",
        no_count_fp: "0",
        yes_total_cost_dollars: "0.8",
        no_total_cost_dollars: "0",
        revenue: 200,
        fee_cost: "0.01",
        settled_time: timestamp,
      }),
    );
    assert.equal(settlement.payoutAmount.toFixed(), "2");
    assert.equal(
      settlement.payoutState,
      "UNKNOWN",
      "Resolution revenue alone does not prove paid cash",
    );
    const knownFlat = {
      ...fill,
      tradeId: "fixture-flat",
      fillId: "fixture-flat",
      orderId: null,
      realizedPnl: decimal(0),
    };
    const unmatched = {
      ...fill,
      tradeId: "fixture-unmatched",
      fillId: null,
      orderId: null,
    };
    const position = {
      marketId: { exchange: "kalshi", value: "fixture-market" },
      marketSlug: "fixture-market",
      side: "YES",
      quantity: decimal(2),
      availableQuantity: decimal(2),
      costBasis: decimal("0.8"),
      realizedPnl: decimal(0),
      expired: true,
    };
    const account = {
      observedAt: now(),
      currentBalance: decimal(10),
      buyingPower: decimal(10),
      assetNotional: decimal(0),
      assetAvailable: decimal(0),
      openOrderValue: decimal(0),
      unsettledFunds: decimal(0),
      marginRequirement: decimal(0),
      positions: [position],
      openOrders: [],
      recentActivities: [fill, knownFlat, unmatched, settlement],
    };
    const valuation = {
      exchangeReportedValue: decimal(10),
      arenaAccountValue: decimal(10),
      riskEquity: decimal(10),
      spendableCapital: decimal(10),
      positions: [],
      warnings: [],
    };
    const attempt = {
      intentId: "fixture-cycle:1",
      validated: {
        order: {
          marketSlug: "fixture-market",
          side: "YES",
          action: "BUY",
          quantity: decimal(2),
          canonicalLimitPrice: decimal("0.4"),
          executionPolicy: "IOC",
        },
      },
      result: {
        status: "FILLED",
        orderId: "fixture-order",
        filledQuantity: decimal(2),
        fees: decimal("0.01"),
        finalState: "FILLED",
      },
    };
    const input = {
      runId: "fixture-run",
      cycleId: "fixture-cycle",
      mode: "observe",
      exchangeId: "kalshi",
      startedAt: now(),
      completedAt: now(),
      accountBefore: { ...account, recentActivities: [] },
      accountAfter: account,
      valuationBefore: valuation,
      valuationAfter: valuation,
      agentStateAfter: await state.load(),
      marketDiscovery: {
        catalogued: 0,
        surfaced: 0,
        inspected: 0,
        preloadedHeld: 0,
        preloadedOpportunities: 0,
        categories: {},
      },
      provider: "synthetic",
      model: "synthetic",
      marketDiscoveryCount: 0,
      webSearchCount: 0,
      evidenceSourceReadCount: 0,
      successfulEvidenceSourceReadCount: 0,
      marketDetailCount: 0,
      marketAnalysisCount: 0,
      tradePreviewCount: 0,
      noteOperationCount: 0,
      stateOperationCount: 0,
      candidateFunnel: { counts: {}, passResearchGate: {}, candidates: [] },
      decision: {
        cycleSummary: "Synthetic offline accounting check.",
        proposals: [],
      },
      validation: {
        accepted: [],
        rejected: [],
        committedCycleSpend: decimal(0),
      },
      execution: { attempts: [attempt], stoppedForAmbiguity: false },
    };
    const report = buildCycleReport(input);
    assert.equal(
      report.exchangeObservedActivity.after.realizedPnlTradeCount,
      1,
    );
    assert.equal(
      report.exchangeObservedActivity.after.closedTradeCount,
      1,
      "Only authoritative known PnL participates in the legacy closed-trade alias",
    );
    assert.equal(report.accountAfter.performance.flatOutcomeCount, 1);
    assert.equal(
      report.exchangeObservedActivity.after.settlements[0].payoutState,
      "UNKNOWN",
    );
    assert.equal(report.accountAfter.positions[0].lifecycleState, "EXPIRED");
    assert.equal(report.accountAfter.positions[0].payoutState, "UNKNOWN");
    assert.deepEqual(report.exchangeObservedActivity.exactOrderMatches, [
      {
        intentId: "fixture-cycle:1",
        orderId: "fixture-order",
        tradeIds: ["fixture-fill"],
        fillIds: ["fixture-fill"],
      },
    ]);
    const ambiguous = buildCycleReport({
      ...input,
      execution: {
        attempts: [attempt, { ...attempt, intentId: "fixture-cycle:2" }],
        stoppedForAmbiguity: false,
      },
    });
    assert.deepEqual(
      ambiguous.exchangeObservedActivity.exactOrderMatches,
      [],
      "Ambiguous intent ownership cannot be joined",
    );
    const history = await persistCrossCycleHistory({
      rootDirectory: temporaryDirectory,
      accountScope: "fixture-account",
      report,
    });
    assert.equal(history.persisted, true);
    const index = JSON.parse(
      await readFile(
        join(
          temporaryDirectory,
          "history",
          "kalshi",
          "fixture-account",
          "index.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      index.entries[0].exchangeObservedActivity.exactOrderMatches,
      report.exchangeObservedActivity.exactOrderMatches,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
})();

// check-execution-health.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Decimal } = await import("decimal.js");
  const { FileExecutionHealth, executionFailureCode } =
    await import("../src/execution/execution-health.ts");
  const { ExchangeError } = await import("../src/exchanges/exchange.ts");
  const { executeValidatedOrders, ExecutionJournalError } =
    await import("../src/execution/executor.ts");
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
  const healthKey = {
    marketSlug: "fixture-market",
    side: "YES",
    action: "BUY",
  };
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
        error instanceof ExecutionJournalError &&
        !error.mutationMayHaveOccurred,
    );
    assert.equal(
      calls.place,
      3,
      "Invalid persisted health must prevent submission",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
})();

// check-managed-buy-continuation.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { Decimal } = await import("decimal.js");
  const { executeValidatedOrders } =
    await import("../src/execution/executor.ts");
  const { buildCycleReport } = await import("../src/reporting/build-report.ts");
  // Synthetic fixtures only. No real adapter, credentials, files, or network.
  globalThis.fetch = () => {
    throw new Error("Network is forbidden in this test");
  };
  const D = (value = 0) => new Decimal(value);
  const now = new Date("2030-01-01T12:00:00Z");
  const expires = new Date("2030-01-01T12:05:00Z");
  const active = (order) => ["OPEN", "PARTIALLY_FILLED"].includes(order.state);

  function candidate(slug, side = "YES", target = true) {
    const market = {
      id: { exchange: "polymarket-us", value: slug },
      slug,
      active: true,
      closed: false,
      archived: false,
      priceTick: D("0.01"),
      minimumTradeQuantity: D(1),
    };
    const price = D(side === "YES" ? "0.4" : "0.6");
    const order = {
      marketId: market.id,
      marketSlug: slug,
      action: "BUY",
      side,
      quantity: D(10),
      canonicalLimitPrice: price,
      executionPolicy: "GTD",
      restUntil: expires,
    };
    const proposal = {
      marketSlug: slug,
      action: "BUY",
      side,
      estimatedProbability: D("0.95"),
      probabilityLowerBound: D("0.95"),
      probabilityUpperBound: D("0.98"),
      maximumEntryPrice: price,
      maximumRiskUsd: D(10),
      confidence: "HIGH",
      thesis: "Synthetic",
      settlementVerification: "Synthetic",
      invalidationConditions: "Synthetic",
      evidence: [],
      ...(target
        ? {
            portfolioTargetPlan: {
              targetCostBasisUsd: D(10),
              baselineCostBasisUsd: D(0),
              baselineQuantity: D(0),
              baselineAvailableQuantity: D(0),
              baselineOppositeCostBasisUsd: D(0),
              baselineOppositeQuantity: D(0),
            },
          }
        : {}),
    };
    return {
      market,
      order,
      proposal,
      authorizationProbability: D("0.95"),
      conservativeFeeReserve: D("0.2"),
      maximumExecutionSpend: price.mul(10).plus("0.2"),
      minimumExecutionSpend: price.plus("0.02"),
      estimatedFees: D("0.2"),
      expectedSpend: price.mul(10),
      riskBudget: D(10),
    };
  }

  async function scenario(options = {}) {
    const candidates = options.candidates ?? [
      candidate("synthetic-a"),
      candidate("synthetic-b", "NO"),
      candidate("synthetic-c"),
    ];
    const sent = [];
    const orders = new Map();
    const reads = new Map();
    const start = D(options.start ?? 100);
    let raced = false;
    let canceled = 0;
    function changeB(quantity, state = "PARTIALLY_FILLED") {
      const b = orders.get("order-2");
      orders.set(b.id, {
        ...b,
        filledQuantity: D(quantity),
        remainingQuantity: active({ state })
          ? b.quantity.minus(quantity)
          : D(0),
        fees: D(quantity).mul("0.01"),
        state,
      });
    }
    function account() {
      let currentBalance = start;
      let buyingPower = start;
      let marginRequirement = D(0);
      let locked = D(0);
      const positions = [];
      for (const order of orders.values()) {
        const principal = order.filledQuantity.mul(
          order.id === "order-2" && options.roundedAverage
            ? (options.actualPrice ?? "0.574")
            : order.averageFillPrice,
        );
        const cost = principal.plus(order.fees);
        buyingPower = buyingPower.minus(cost);
        currentBalance = currentBalance
          .minus(cost)
          .plus(order.side === "NO" ? order.filledQuantity : 0);
        if (order.side === "NO")
          marginRequirement = marginRequirement.plus(order.filledQuantity);
        if (order.filledQuantity.gt(0))
          positions.push({
            marketId: order.marketId,
            marketSlug: order.marketSlug,
            side: order.side,
            quantity: order.filledQuantity,
            availableQuantity: order.filledQuantity,
            costBasis: principal,
            realizedPnl: D(0),
            expired: false,
          });
        if (options.exchangeLocks && active(order))
          locked = locked
            .plus(order.remainingQuantity.mul(order.canonicalPrice))
            .plus("0.1");
      }
      const openOrders = [...orders.values()].filter(active);
      if (sent.length >= 2 && options.unknownOrder)
        openOrders.push({ ...orders.get("order-2"), id: "external-order" });
      if (sent.length >= 2 && options.externalCash)
        currentBalance = currentBalance.minus(1);
      if (sent.length >= 2 && options.externalPosition)
        positions.push({ ...positions[0], marketSlug: "external-market" });
      return {
        observedAt: now,
        currentBalance,
        buyingPower:
          sent.length >= 2 && options.noBuyingPower
            ? D("0.1")
            : buyingPower.minus(locked),
        assetNotional: D(0),
        assetAvailable: D(0),
        openOrderValue: locked,
        unsettledFunds: D(0),
        marginRequirement,
        positions,
        openOrders,
        recentActivities: [],
      };
    }
    const snapshot = account();
    const exchange = {
      id: "polymarket-us",
      memoryScope: "synthetic",
      async getOpenOrders() {
        return account().openOrders;
      },
      async getPositions() {
        return account().positions;
      },
      async getActivities() {
        return { items: [], eof: true };
      },
      async getAccountSnapshot() {
        return account();
      },
      async getMarketBySlug(slug) {
        return candidates.find((entry) => entry.market.slug === slug).market;
      },
      async getBbo() {
        return {
          yes: { bid: D("0.39"), ask: D("0.4") },
          no: { bid: D("0.59"), ask: D("0.6") },
        };
      },
      async getOrderBook() {
        return {
          yesBids: [{ price: D("0.4"), quantity: D(100) }],
          yesAsks: [{ price: D("0.4"), quantity: D(100) }],
        };
      },
      async previewImmediateOrder(order) {
        if (options.race === "after-check" && sent.length === 2 && !raced) {
          raced = true;
          changeB(10, "FILLED");
        }
        return {
          accepted: true,
          estimatedFees: D("0.2"),
          estimatedPrincipal: order.quantity.mul(order.canonicalLimitPrice),
          warnings: [],
          rejectionReasons: [],
        };
      },
      async placeImmediateOrder(order) {
        sent.push(order.marketSlug);
        const working =
          (sent.length === 1 && options.firstWorking) ||
          (sent.length === 2 &&
            options.bStatus !== "FILLED" &&
            options.bStatus !== "PARTIAL") ||
          (sent.length === 3 && options.cWorking);
        const filled = working
          ? D(options.bFilled ?? 5)
          : options.bStatus === "PARTIAL" && sent.length === 2
            ? D(5)
            : order.quantity;
        const state = working
          ? "PARTIALLY_FILLED"
          : filled.eq(order.quantity)
            ? "FILLED"
            : "CANCELED";
        const stored = {
          id: `order-${sent.length}`,
          ...order,
          canonicalPrice: order.canonicalLimitPrice,
          state,
          filledQuantity: filled,
          remainingQuantity: working ? order.quantity.minus(filled) : D(0),
          averageFillPrice:
            sent.length === 2 && options.roundedAverage
              ? D("0.57")
              : order.canonicalLimitPrice,
          fees: filled.mul("0.01"),
        };
        orders.set(stored.id, stored);
        return {
          orderId: stored.id,
          status:
            options.ambiguous && sent.length === 2
              ? "AMBIGUOUS"
              : working
                ? "WORKING"
                : filled.eq(order.quantity)
                  ? "FILLED"
                  : "PARTIAL",
          filledQuantity: filled,
          remainingQuantity: stored.remainingQuantity,
          averageFillPrice: stored.averageFillPrice,
          fees: stored.fees,
          finalState: state,
        };
      },
      async getOrder(id) {
        const count = (reads.get(id) ?? 0) + 1;
        reads.set(id, count);
        if (id === "order-2" && count >= 2 && options.continuousRace)
          changeB(orders.get(id).filledQuantity.plus("0.1"));
        if (options.ambiguous && id === "order-2")
          return { ...orders.get(id), marketSlug: "mismatched" };
        if (id === "order-2" && count >= 2 && options.mismatch)
          return { ...orders.get(id), quantity: D(99) };
        if (id === "order-2" && count >= 2 && options.regress)
          return {
            ...orders.get(id),
            filledQuantity: D(1),
            remainingQuantity: D(9),
            fees: D("0.01"),
          };
        if (id === "order-2" && count >= 2 && options.missingFees)
          return { ...orders.get(id), fees: undefined };
        if (
          id === "order-2" &&
          count >= 2 &&
          !raced &&
          options.race &&
          options.race !== "after-check"
        ) {
          raced = true;
          const old = orders.get(id);
          changeB(
            options.race === "terminal" ? 10 : 7,
            options.race === "terminal" ? "FILLED" : "PARTIALLY_FILLED",
          );
          return options.race === "during-read" ? old : orders.get(id);
        }
        return orders.get(id);
      },
      async cancelOrder() {
        canceled += 1;
        assert.fail("Continuation must not cancel managed orders");
      },
    };
    const execution = await executeValidatedOrders({
      exchange,
      mode: options.mode ?? "live",
      snapshot,
      riskEquity: D(100),
      validated: candidates,
      now: () => now,
      managedRestingBuyOrders: { enabled: true, maximumLifetimeMinutes: 5 },
      policy: {
        allowPositionReductions: false,
        maximumCycleSpendFraction: D(options.cycleFraction ?? "0.5"),
        duplicateWindowMinutes: 1,
        maximumExecutionSpread: D("0.1"),
        emergencyExitEnabled: false,
      },
    });
    return {
      execution,
      sent,
      orders,
      reads,
      canceled,
      candidates,
      snapshot,
      after: account(),
    };
  }

  const complete = await scenario();
  assert.deepEqual(complete.sent, [
    "synthetic-a",
    "synthetic-b",
    "synthetic-c",
  ]);
  assert.deepEqual(
    complete.execution.attempts.map((attempt) => attempt.result.status),
    ["FILLED", "WORKING", "FILLED"],
  );
  assert.equal(complete.execution.completion.processedAll, true);
  assert.equal(complete.execution.stoppedForAmbiguity, false);
  assert.equal(complete.orders.get("order-2").remainingQuantity.toFixed(), "5");
  assert.equal(complete.canceled, 0);
  assert.equal(
    (await scenario({ roundedAverage: true })).sent.length,
    3,
    "Rounded order averages must not replace actual position cost",
  );
  assert.equal(
    (await scenario({ roundedAverage: true, actualPrice: "0.55" })).sent.length,
    2,
    "Cost inconsistent with reported price precision stops continuation",
  );
  assert.equal(
    (await scenario({ firstWorking: true })).sent.length,
    3,
    "Continuation also works when A remains working",
  );
  assert.equal(
    (await scenario({ bFilled: 0 })).sent.length,
    3,
    "A verified zero-fill working order retains its full reservation",
  );

  for (const race of [
    "before-read",
    "during-read",
    "terminal",
    "after-check",
  ]) {
    const run = await scenario({ race });
    assert.equal(
      run.sent.length,
      3,
      `${race}: a verified fill must not starve C`,
    );
    assert.equal(run.execution.stoppedForAmbiguity, false);
    assert.equal(run.orders.get("order-3").quantity.toFixed(), "10");
    if (race === "terminal")
      assert.equal(run.execution.attempts[1].result.status, "FILLED");
    if (race === "during-read")
      assert.ok(run.reads.get("order-2") >= 5, "Racing reads are retried");
  }

  const multi = await scenario({
    cWorking: true,
    candidates: [
      candidate("synthetic-a"),
      candidate("synthetic-b", "NO"),
      candidate("synthetic-c"),
      candidate("synthetic-d", "NO"),
    ],
  });
  assert.equal(multi.sent.length, 4, "Multiple known working BUYs may coexist");
  assert.equal(multi.execution.managedOrderChecks.length, 2);

  for (const bStatus of ["FILLED", "PARTIAL"])
    assert.equal((await scenario({ bStatus })).sent.length, 3);
  assert.equal((await scenario({ mode: "observe" })).sent.length, 0);

  const reserved = await scenario({ start: 13, bFilled: 1 });
  assert.equal(
    reserved.sent.length,
    2,
    "Pending NO quantity must remain reserved even if the venue omits the lock",
  );
  assert.match(reserved.execution.attempts[2].skippedReason, /buying power/u);
  assert.equal(
    (await scenario({ start: 20, exchangeLocks: true })).sent.length,
    3,
    "Do not subtract an exchange reservation twice",
  );
  assert.equal((await scenario({ noBuyingPower: true })).sent.length, 2);
  const capped = await scenario({ cycleFraction: "0.12" });
  assert.equal(capped.sent.length, 2);
  assert.match(capped.execution.attempts[2].skippedReason, /cycle spend/u);

  for (const option of [
    "unknownOrder",
    "externalCash",
    "externalPosition",
    "mismatch",
    "missingFees",
    "ambiguous",
    "regress",
    "continuousRace",
  ]) {
    const run = await scenario({
      [option]: true,
      candidates: [
        candidate("synthetic-a"),
        candidate("synthetic-b", "NO"),
        candidate("synthetic-c"),
        candidate("synthetic-d"),
      ],
    });
    assert.equal(run.sent.length, 2, `${option}: must stop before C`);
    assert.equal(run.execution.stoppedForAmbiguity, true, option);
    assert.equal(run.execution.completion.processedAll, false);
    assert.ok(
      run.execution.completion.unattempted.some(
        (entry) => entry.marketSlug === "synthetic-d",
      ),
    );
  }

  const conflict = await scenario({
    candidates: [
      candidate("synthetic-a"),
      candidate("synthetic-b", "NO"),
      candidate("synthetic-b", "NO"),
      candidate("synthetic-d"),
    ],
  });
  assert.deepEqual(conflict.sent, [
    "synthetic-a",
    "synthetic-b",
    "synthetic-d",
  ]);
  assert.match(
    conflict.execution.attempts[2].skippedReason,
    /independent market/u,
  );
  const legacy = await scenario({
    candidates: [
      candidate("synthetic-a", "YES", false),
      candidate("synthetic-b", "NO", false),
      candidate("synthetic-c", "YES", false),
    ],
  });
  assert.equal(
    legacy.sent.length,
    3,
    "Legacy proposals also refresh buying power",
  );

  function report(run) {
    const valuation = {
      exchangeReportedValue: D(100),
      arenaAccountValue: D(100),
      riskEquity: D(100),
      spendableCapital: D(100),
      positions: [],
      warnings: [],
    };
    return buildCycleReport({
      runId: "synthetic",
      cycleId: "synthetic",
      mode: "live",
      exchangeId: "polymarket-us",
      startedAt: now,
      completedAt: now,
      accountBefore: run.snapshot,
      accountAfter: run.after,
      valuationBefore: valuation,
      valuationAfter: valuation,
      marketDiscovery: {
        catalogued: 3,
        surfaced: 3,
        inspected: 3,
        preloadedHeld: 0,
        preloadedOpportunities: 3,
        categories: {},
      },
      provider: "synthetic",
      model: "synthetic",
      marketDiscoveryCount: 0,
      webSearchCount: 0,
      evidenceSourceReadCount: 0,
      successfulEvidenceSourceReadCount: 0,
      marketDetailCount: 0,
      marketAnalysisCount: 0,
      tradePreviewCount: 0,
      noteOperationCount: 0,
      stateOperationCount: 0,
      candidateFunnel: { counts: {}, passResearchGate: {}, candidates: [] },
      decision: {
        cycleSummary: "Synthetic",
        proposals: run.candidates.map((entry) => entry.proposal),
      },
      validation: {
        accepted: run.candidates,
        rejected: [],
        committedCycleSpend: D(0),
      },
      execution: run.execution,
    });
  }
  const successReport = report(complete);
  assert.equal(successReport.outcome, "ORDER_WORKING");
  assert.match(
    successReport.completionReason,
    /All accepted proposals were processed/u,
  );
  assert.equal(successReport.currentCycleExecutions.length, 3);
  const stopped = await scenario({ unknownOrder: true });
  const stoppedReport = report(stopped);
  assert.equal(stoppedReport.outcome, "AMBIGUOUS");
  assert.match(stoppedReport.completionReason, /Execution stopped/u);
  assert.equal(stoppedReport.executionCompletion.processedAll, false);
})();
