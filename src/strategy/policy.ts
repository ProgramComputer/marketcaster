import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import {
  referenceSelectionPolicy,
  selectionPolicyApi,
  type SelectionPolicy,
} from "../agent/opportunity-board.js";
import {
  forecastPolicyApi,
  type ForecastPolicy,
  type ForecastProbabilityRequest,
  type FreshForecastProbabilities,
} from "../llm/research-tools.js";
import type { DetailedMarketContext } from "../agent/context-builder.js";
import {
  EXECUTION_FAILURE_CODES,
  type ExecutionFailureCode,
} from "../execution/execution-health.js";
import type { BatchAllocationPolicy } from "../risk/batch-allocation.js";

/** Trusted deployment code supplies policy; the engine retains risk enforcement. */
export interface StrategyPolicy {
  readonly apiVersion: 1;
  readonly selection: SelectionPolicy;
  readonly forecast?: ForecastPolicy;
  readonly allocation: BatchAllocationPolicy;
  readonly passAuditMinimumEdge: Decimal;
  readonly reconciliationTolerance?: (riskEquity: Decimal) => Decimal;
  readonly executionCooldownMilliseconds?: Readonly<
    Partial<Record<ExecutionFailureCode, number>>
  >;
}

export const strategyApi = Object.freeze({
  apiVersion: 1 as const,
  Decimal,
  selection: selectionPolicyApi,
  forecast: forecastPolicyApi,
});

/** A catalog-only reference has no implicit capital allocation or forecast. */
export const referenceStrategy: StrategyPolicy = Object.freeze({
  apiVersion: 1,
  selection: referenceSelectionPolicy,
  allocation: () => [],
  passAuditMinimumEdge: new Decimal(0),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertStrategyPolicy(
  value: unknown,
): asserts value is StrategyPolicy {
  const policy = value as Partial<StrategyPolicy> | null;
  if (
    policy === null ||
    typeof policy !== "object" ||
    policy.apiVersion !== 1 ||
    typeof policy.allocation !== "function" ||
    typeof policy.selection?.buildOpportunityBoard !== "function" ||
    typeof policy.selection.buildEnrichedOpportunityBoard !== "function" ||
    typeof policy.selection.selectRequiredMarketSlugs !== "function" ||
    !Decimal.isDecimal(policy.passAuditMinimumEdge) ||
    !policy.passAuditMinimumEdge.isFinite() ||
    policy.passAuditMinimumEdge.lt(0)
  )
    throw new TypeError(
      "Strategy must implement the version 1 policy contract",
    );
  if (
    policy.forecast !== undefined &&
    (typeof policy.forecast.systemLiveEvidenceSources !== "function" ||
      typeof policy.forecast.liveEvidenceLinePreview !== "function" ||
      typeof policy.forecast.refreshForecasts !== "function" ||
      !Decimal.isDecimal(policy.forecast.forecastTolerance) ||
      !policy.forecast.forecastTolerance.isFinite() ||
      policy.forecast.forecastTolerance.lt(0) ||
      policy.forecast.forecastTolerance.gt(1))
  )
    throw new TypeError("Strategy forecast contract is invalid");
  for (const name of [
    "buildFamilyScout",
    "shouldFetchFamilyBook",
    "allowWebSearch",
    "shouldEnforceRequiredResearch",
    "buildCriticalLearning",
  ] as const) {
    if (
      policy.selection[name] !== undefined &&
      typeof policy.selection[name] !== "function"
    )
      throw new TypeError(`Strategy selection.${name} must be a function`);
  }
  const band = policy.selection.depthPriceBand;
  if (
    band !== undefined &&
    (!Decimal.isDecimal(band) || !band.isFinite() || band.lt(0) || band.gt(1))
  )
    throw new RangeError(
      "Strategy depth price band must be between zero and one",
    );
  const experiment: unknown = policy.selection.experimentDefinition;
  if (
    experiment !== undefined &&
    (!isRecord(experiment) ||
      [
        experiment.experimentId,
        experiment.hypothesis,
        experiment.controlVariant,
        experiment.treatmentVariant,
      ].some(
        (value) => typeof value !== "string" || value.trim().length === 0,
      ) ||
      !Array.isArray(experiment.limitations) ||
      experiment.limitations.some((value) => typeof value !== "string"))
  )
    throw new TypeError("Strategy experiment definition is invalid");
  if (
    policy.reconciliationTolerance !== undefined &&
    typeof policy.reconciliationTolerance !== "function"
  )
    throw new TypeError("Strategy reconciliation tolerance must be a function");
  if (policy.executionCooldownMilliseconds !== undefined) {
    const durations: unknown = policy.executionCooldownMilliseconds;
    if (
      !isRecord(durations) ||
      Object.entries(durations).some(
        ([code, duration]) =>
          !EXECUTION_FAILURE_CODES.includes(code as ExecutionFailureCode) ||
          typeof duration !== "number" ||
          !Number.isSafeInteger(duration) ||
          duration < 0,
      )
    )
      throw new RangeError("Strategy execution cooldown durations are invalid");
  }
}

export async function loadStrategyPolicy(
  path?: string,
): Promise<StrategyPolicy> {
  if (path === undefined) return referenceStrategy;
  const module = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: unknown;
  };
  if (typeof module.default !== "function")
    throw new TypeError("Strategy module must export a default factory");
  const factory = module.default as (api: typeof strategyApi) => unknown;
  const policy: unknown = await factory(strategyApi);
  assertStrategyPolicy(policy);
  return policy;
}

/** Invalid forecasts stop the cycle; unavailable required forecasts remain unavailable. */
export async function refreshPolicyForecasts(
  policy: ForecastPolicy | undefined,
  requests: readonly ForecastProbabilityRequest[],
  details: ReadonlyMap<string, DetailedMarketContext>,
  at: Date,
  signal: AbortSignal,
): Promise<FreshForecastProbabilities> {
  if (policy === undefined)
    return {
      requiredMarketSlugs: new Set(),
      selectedSideProbabilityByMarketSlug: new Map(),
    };
  const result = await policy.refreshForecasts(requests, details, at, signal);
  signal.throwIfAborted();
  const requested = new Set(requests.map((request) => request.marketSlug));
  for (const slug of result.requiredMarketSlugs) {
    if (!requested.has(slug))
      throw new TypeError("Forecast policy returned an unrequested market");
  }
  for (const [
    slug,
    probability,
  ] of result.selectedSideProbabilityByMarketSlug) {
    if (
      !requested.has(slug) ||
      !Decimal.isDecimal(probability) ||
      !probability.isFinite() ||
      probability.lt(0) ||
      probability.gt(1)
    ) {
      throw new RangeError(
        "Forecast policy must return finite probabilities between zero and one for requested markets",
      );
    }
  }
  return result;
}
