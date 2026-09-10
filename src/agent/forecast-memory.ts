import { Decimal } from "decimal.js";
import type { AgentBelief } from "./agent-state.js";

/** A captured submission, not an assertion that its forecast is calibrated. */
export interface SubmittedMemoryForecast {
  readonly submittedAt: string;
  readonly marketSlug: string;
  readonly side: "YES" | "NO";
  readonly estimatedProbability: Decimal.Value;
}

export interface ForecastMemoryIssue {
  readonly beliefId: string;
  readonly beliefUpdatedAt: string;
  readonly marketSlugs: readonly string[];
  readonly originalYesProbability: number;
  readonly code: "FORECAST_PROBABILITY_CONFLICT" | "AMBIGUOUS_FORECAST_MARKET";
  readonly targetYesProbability?: number;
  readonly targetSubmittedAt?: string;
  readonly message: string;
}

export interface ForecastMemoryReview {
  readonly issues: readonly ForecastMemoryIssue[];
  readonly checkedBeliefIds: readonly string[];
  readonly unverifiedBeliefs: readonly {
    readonly beliefId: string;
    readonly reason: "NO_MATCHING_SUBMISSION" | "BELIEF_AFTER_SUBMISSION";
  }[];
}

/**
 * Review advisory scalars only. This never authorizes, rejects, or modifies a
 * target. Earlier beliefs are historical estimates, not a constraint on a new
 * forecast. No meaning or conviction is inferred from the belief's prose.
 */
export function reviewForecastMemory(input: {
  readonly beliefs: readonly AgentBelief[];
  readonly cycleStartedAt: string;
  readonly submittedForecasts: readonly SubmittedMemoryForecast[];
}): ForecastMemoryReview {
  const issues: ForecastMemoryIssue[] = [];
  const checkedBeliefIds: string[] = [];
  const unverifiedBeliefs: ForecastMemoryReview["unverifiedBeliefs"][number][] =
    [];
  const latestByMarket = new Map<string, SubmittedMemoryForecast>();
  for (const forecast of input.submittedForecasts) {
    const previous = latestByMarket.get(forecast.marketSlug);
    if (
      previous === undefined ||
      Date.parse(forecast.submittedAt) >= Date.parse(previous.submittedAt)
    ) {
      latestByMarket.set(forecast.marketSlug, forecast);
    }
  }
  for (const belief of input.beliefs) {
    if (
      belief.forecastYesProbability == null ||
      Date.parse(belief.updatedAt) < Date.parse(input.cycleStartedAt) ||
      (belief.status !== undefined && belief.status !== "ACTIVE")
    ) {
      continue;
    }
    const marketSlugs = [...new Set(belief.marketSlugs)];
    const base = {
      beliefId: belief.id,
      beliefUpdatedAt: belief.updatedAt,
      marketSlugs,
      originalYesProbability: belief.forecastYesProbability,
    };
    const marketSlug = marketSlugs[0];
    if (marketSlugs.length !== 1 || marketSlug === undefined) {
      issues.push({
        ...base,
        code: "AMBIGUOUS_FORECAST_MARKET",
        message:
          "A single YES probability cannot be attributed to multiple or unspecified contracts. The scalar is advisory and needs a single-market revision; the belief text remains available.",
      });
      continue;
    }
    const latest = latestByMarket.get(marketSlug);
    if (latest === undefined) {
      unverifiedBeliefs.push({
        beliefId: belief.id,
        reason: "NO_MATCHING_SUBMISSION",
      });
      continue;
    }
    if (Date.parse(latest.submittedAt) < Date.parse(belief.updatedAt)) {
      unverifiedBeliefs.push({
        beliefId: belief.id,
        reason: "BELIEF_AFTER_SUBMISSION",
      });
      continue;
    }
    checkedBeliefIds.push(belief.id);
    const selectedProbability = new Decimal(latest.estimatedProbability);
    const yesProbability =
      latest.side === "YES"
        ? selectedProbability
        : new Decimal(1).minus(selectedProbability);
    // The memory schema stores a JSON number, so compare at its representable
    // precision; extra decimal digits in a target are not a forecast reversal.
    if (yesProbability.toNumber() === belief.forecastYesProbability) continue;
    issues.push({
      ...base,
      code: "FORECAST_PROBABILITY_CONFLICT",
      targetYesProbability: yesProbability.toNumber(),
      targetSubmittedAt: latest.submittedAt,
      message:
        "This advisory scalar differs from the latest subsequent target for the same contract after conversion to P(YES). Preserve both observations for review; the target remains independently eligible.",
    });
  }
  return { issues, checkedBeliefIds, unverifiedBeliefs };
}
