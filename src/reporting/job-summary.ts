import { appendFile } from "node:fs/promises";
import type { CycleReport } from "./types.js";

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderJobSummary(report: CycleReport): string {
  const currentCycleExecutions = report.currentCycleExecutions;
  const filled = currentCycleExecutions.filter(
    (execution) =>
      execution.status === "FILLED" ||
      execution.status === "PARTIAL" ||
      Number(execution.filledQuantity) > 0,
  );
  const working = currentCycleExecutions.filter(
    (execution) => execution.status === "WORKING",
  );
  const fees = filled.reduce(
    (total, execution) => total + Number(execution.fees),
    0,
  );
  const lines = [
    "# Prediction cycle",
    "",
    `**Status:** ${report.status}`,
    `**Outcome:** ${report.outcome}`,
    `**Completion:** ${report.completionReason}`,
    `**Runtime mode:** ${report.mode}`,
    `**Exchange:** ${report.exchangeId}`,
    "",
    "| Metric | Before | After |",
    "| --- | ---: | ---: |",
    `| Conservative account value | $${report.accountBefore.arenaAccountValue} | $${report.accountAfter.arenaAccountValue} |`,
    `| Buying power | $${report.accountBefore.buyingPower} | $${report.accountAfter.buyingPower} |`,
    `| Reserved in open orders | $${report.accountBefore.openOrderValue} | $${report.accountAfter.openOrderValue} |`,
    `| Positions | ${report.accountBefore.positionCount} | ${report.accountAfter.positionCount} |`,
    `| Position liquidation value | $${report.accountBefore.allocation.positionLiquidationValue} | $${report.accountAfter.allocation.positionLiquidationValue} |`,
    `| Position unrealized PnL | $${report.accountBefore.performance.positionUnrealizedPnl} | $${report.accountAfter.performance.positionUnrealizedPnl} |`,
    "",
    `Recent trading PnL: **$${report.accountAfter.activityBreakdown.tradingPnl}**; deposits: **$${report.accountAfter.activityBreakdown.deposits}**; withdrawals: **$${report.accountAfter.activityBreakdown.withdrawals}**.`,
    `Cycle snapshot changes: account value **$${report.performance.arenaAccountValueChange}**; buying power **$${report.performance.buyingPowerChange}**; recent realized PnL **$${report.performance.recentRealizedPnlChange}**; position unrealized PnL **$${report.performance.positionUnrealizedPnlChange}**.`,
    "",
    `Markets catalogued: **${report.marketDiscovery.catalogued}**; surfaced to the agent: **${report.marketDiscovery.surfaced}**; inspected on demand: **${report.marketDiscovery.inspected}**; held markets preloaded: **${report.marketDiscovery.preloadedHeld}**; exchange-ranked board: **${report.marketDiscovery.exchangeRankedOpportunities ?? report.marketDiscovery.preloadedOpportunities}**; family-scout board: **${report.marketDiscovery.familyScoutedOpportunities ?? 0}**; discovery calls: **${report.agent.marketDiscoveryCount}**.`,
    "",
    `Research calls: market details **${report.agent.marketDetailCount}**; market analysis **${report.agent.marketAnalysisCount}**; trade previews **${report.agent.tradePreviewCount}**; web searches **${report.agent.webSearchCount}**; note operations **${report.agent.noteOperationCount}**; structured-state operations **${report.agent.stateOperationCount}**.`,
    "",
    `Candidate activity: board **${report.candidateFunnel.counts.initialBoard}**; surfaced **${report.candidateFunnel.counts.surfacedUnique}**; exact details available **${report.candidateFunnel.counts.inspected}**; mechanically qualified **${report.candidateFunnel.counts.mechanicallyQualified}**; market analyzed **${report.candidateFunnel.counts.researched}**; previewed **${report.candidateFunnel.counts.previewed}**; targeted **${report.candidateFunnel.counts.proposed}**; explicitly dispositioned **${report.candidateFunnel.counts.explicitlyDispositioned ?? 0}**. Pass-research gate: **${report.candidateFunnel.passResearchGate.status}**.`,
    "",
    `Agent proposals: **${report.agent.proposals.length}**; risk accepted: **${report.risk.accepted.length}**; risk rejected: **${report.risk.rejected.length}**.`,
    ...(report.agent.portfolioTargets === undefined
      ? []
      : [
          `Portfolio targets: **${report.agent.portfolioTargets.length}**; derived orders: **${report.agent.proposals.length}**; target holds: **${report.agent.targetReconciliations?.filter((item) => item.kind === "HOLD").length ?? 0}**; blocked targets: **${report.agent.targetReconciliations?.filter((item) => item.kind === "BLOCKED").length ?? 0}**.`,
        ]),
    "",
    "## Current-cycle execution",
    "",
    `Execution attempts: **${currentCycleExecutions.length}**; fills: **${filled.length}**; working: **${working.length}**; fees: **$${fees.toFixed(4)}**; ambiguous: **${currentCycleExecutions.some((item) => item.status === "AMBIGUOUS") ? "yes" : "no"}**. These records contain only orders handled by this cycle.`,
    "",
    "## Exchange-observed account activity",
    "",
    "These records come from account snapshots. They establish that activity occurred, but are not attributed to this cycle or to a manual/external actor.",
    "",
    `Snapshot activity before/after: trades **${report.exchangeObservedActivity.before.tradeCount}/${report.exchangeObservedActivity.after.tradeCount}**; closed trades **${report.exchangeObservedActivity.before.closedTradeCount}/${report.exchangeObservedActivity.after.closedTradeCount}**; settlements **${report.exchangeObservedActivity.before.settlementCount}/${report.exchangeObservedActivity.after.settlementCount}**. Newly observed during reconciliation: trades **${report.exchangeObservedActivity.newlyObserved.tradeCount}**; closed trades **${report.exchangeObservedActivity.newlyObserved.closedTradeCount}**; settlements **${report.exchangeObservedActivity.newlyObserved.settlementCount}**.`,
  ];

  if (currentCycleExecutions.length > 0) {
    lines.push(
      "",
      "| Market | Side | Action | Policy | Status | Filled | Remaining | Price | Expires | Fees |",
      "| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: |",
      ...currentCycleExecutions.map(
        (execution) =>
          `| ${escapeCell(execution.marketSlug)} | ${execution.side} | ${execution.action} | ${execution.executionPolicy} | ${execution.status} | ${execution.filledQuantity} | ${execution.remainingQuantity ?? "—"} | ${execution.averageFillPrice ?? "—"} | ${execution.restUntil ?? "—"} | $${execution.fees} |`,
      ),
    );
  }

  const recentClosedTrades =
    report.exchangeObservedActivity.after.closedTrades.slice(0, 10);
  if (recentClosedTrades.length > 0) {
    lines.push(
      "",
      "### Recent exchange-observed closed trades",
      "",
      "| Market | Side | Action | Quantity | Price | Realized PnL | Updated |",
      "| --- | --- | --- | ---: | ---: | ---: | --- |",
      ...recentClosedTrades.map(
        (trade) =>
          `| ${escapeCell(trade.marketSlug)} | ${trade.side ?? "—"} | ${trade.action ?? "—"} | ${trade.quantity} | ${trade.price} | $${trade.realizedPnl ?? "—"} | ${trade.updatedAt} |`,
      ),
    );
  }

  const recentSettlements =
    report.exchangeObservedActivity.after.settlements.slice(0, 10);
  if (recentSettlements.length > 0) {
    lines.push(
      "",
      "### Recent exchange-observed settlements",
      "",
      "| Market | Realized PnL | Resolved |",
      "| --- | ---: | --- |",
      ...recentSettlements.map(
        (settlement) =>
          `| ${escapeCell(settlement.marketSlug)} | $${settlement.realizedPnl} | ${settlement.resolvedAt} |`,
      ),
    );
  }

  lines.push(
    "",
    `Structured agent beliefs: **${report.agentState.after.reportedBeliefCount}** reported of **${report.agentState.after.totalBeliefCount}** total; added/updated/removed among reported beliefs this cycle: **${report.agentState.changes.reportedAddedBeliefIds.length}/${report.agentState.changes.reportedUpdatedBeliefIds.length}/${report.agentState.changes.reportedRemovedBeliefIds.length}**; complete comparison: **${report.agentState.changes.comparisonComplete ? "yes" : "no"}**.`,
  );

  if (report.agent.tokenUsage !== undefined) {
    const tokenUsage = report.agent.tokenUsage;
    const tokenSegments = [
      `input **${tokenUsage.inputTokens}**`,
      `output **${tokenUsage.outputTokens}**`,
      ...(tokenUsage.totalTokens === undefined
        ? []
        : [`total **${tokenUsage.totalTokens}**`]),
      ...(tokenUsage.cachedInputTokens === undefined
        ? []
        : [`cache reads **${tokenUsage.cachedInputTokens}**`]),
      ...(tokenUsage.cacheCreationInputTokens === undefined
        ? []
        : [`cache writes **${tokenUsage.cacheCreationInputTokens}**`]),
      ...(tokenUsage.cacheCreation5mInputTokens === undefined
        ? []
        : [`5m cache writes **${tokenUsage.cacheCreation5mInputTokens}**`]),
      ...(tokenUsage.cacheCreation1hInputTokens === undefined
        ? []
        : [`1h cache writes **${tokenUsage.cacheCreation1hInputTokens}**`]),
      ...(tokenUsage.reasoningOutputTokens === undefined
        ? []
        : [`reasoning output **${tokenUsage.reasoningOutputTokens}**`]),
    ];
    lines.push("", `Provider tokens: ${tokenSegments.join("; ")}.`);
  }

  if (report.agent.cacheDiagnostics !== undefined) {
    const diagnostics = report.agent.cacheDiagnostics;
    const missReasons = Object.entries(diagnostics.missReasonCounts)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    lines.push(
      "",
      `Prompt cache diagnostics: compared **${diagnostics.comparisonRequests}** of **${diagnostics.rounds}** rounds; cache reads on **${diagnostics.roundsWithCacheReads}** rounds; cache-read fraction of prompt input **${diagnostics.cacheReadFraction}**; miss reasons **${missReasons.length === 0 ? "none reported" : missReasons}**; diagnosed missed input tokens **${diagnostics.missedInputTokens}**.`,
    );
  }

  if (report.agent.decisionAudit !== undefined) {
    const audit = report.agent.decisionAudit;
    lines.push(
      "",
      `Decision audit: evidence valid **${audit.evidence.valid ? "yes" : "no"}** (${audit.evidence.verifiedSourceCount} verified sources, ${audit.evidence.blockingIssueCount} blocking and ${audit.evidence.advisoryIssueCount} advisory issues); coverage valid **${audit.coverage.valid ? "yes" : "no"}** (${audit.coverage.requiredMarketCount} required markets, ${audit.coverage.issueCount} issues); persistence provenance valid **${audit.persistence.valid ? "yes" : "no"}** (${audit.persistence.issueCount} issues).`,
    );
  }

  if (report.risk.rejected.length > 0) {
    lines.push(
      "",
      "## Risk rejections",
      "",
      "| Market | Code | Reason |",
      "| --- | --- | --- |",
      ...report.risk.rejected.map(
        (item) =>
          `| ${escapeCell(item.marketSlug)} | ${item.code} | ${escapeCell(item.reason)} |`,
      ),
    );
  }
  if (report.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...report.warnings.map((warning) => `- ${warning}`),
    );
  }
  if (report.errors.length > 0) {
    lines.push(
      "",
      "## Errors",
      "",
      ...report.errors.map((error) => `- ${error.stage}: ${error.message}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function appendJobSummary(
  report: CycleReport,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
): Promise<void> {
  if (summaryPath === undefined || summaryPath.length === 0) return;
  await appendFile(summaryPath, renderJobSummary(report), "utf8");
}
