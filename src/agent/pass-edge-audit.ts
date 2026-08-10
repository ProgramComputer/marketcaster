import { Decimal } from "decimal.js";
import type { Market, MarketBbo, SideBbo } from "../domain/market.js";
import type { OutcomeSide } from "../domain/primitives.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import { estimateExchangeTakerFeePerContract } from "../risk/edge.js";
import type { AgentDecision, CandidateDisposition } from "./decision-schema.js";
import type { DecisionCoverageIssue } from "./decision-coverage.js";

export interface PassEdgeAuditCheck {
  readonly marketSlug: string;
  readonly dispositionSide: OutcomeSide;
  readonly evaluatedSide: OutcomeSide;
  readonly status:
    | "QUOTE_ERROR"
    | "NO_EXECUTABLE_ASK"
    | "SPREAD_UNAVAILABLE"
    | "SPREAD_TOO_WIDE"
    | "NON_POSITIVE"
    | "MATERIAL_POSITIVE";
  readonly authorizationProbability?: string;
  readonly ask?: string;
  readonly spread?: string;
  readonly estimatedFeePerContract?: string;
  readonly netEdgePerContract?: string;
}

export interface PassEdgeAuditReport {
  readonly schemaVersion: 1;
  readonly auditPolicy: "BOTH_SIDES_AT_FROZEN_FRESH_BBO";
  readonly checkedDispositionCount: number;
  readonly checks: readonly PassEdgeAuditCheck[];
  readonly issues: readonly DecisionCoverageIssue[];
}

function probabilityForSide(
  disposition: CandidateDisposition,
  side: OutcomeSide,
):
  | {
      readonly point: Decimal;
      readonly lower: Decimal;
      readonly upper: Decimal;
    }
  | undefined {
  const point = disposition.estimatedProbability;
  const lower = disposition.probabilityLowerBound;
  const upper = disposition.probabilityUpperBound;
  if (
    disposition.side === undefined ||
    disposition.side === null ||
    point === undefined ||
    point === null ||
    lower === undefined ||
    lower === null ||
    upper === undefined ||
    upper === null
  ) {
    return undefined;
  }
  if (side === disposition.side) return { point, lower, upper };
  return {
    point: new Decimal(1).minus(point),
    lower: new Decimal(1).minus(upper),
    upper: new Decimal(1).minus(lower),
  };
}

function bboForSide(bbo: MarketBbo, side: OutcomeSide): SideBbo {
  return side === "YES" ? bbo.yes : bbo.no;
}

function authorizationProbability(
  probability: { readonly point: Decimal; readonly lower: Decimal },
  uncertaintyBoundWeight: Decimal,
): Decimal {
  return probability.point.plus(
    probability.lower.minus(probability.point).mul(uncertaintyBoundWeight),
  );
}

async function frozenBbo(
  market: Market,
  exchange: PredictionExchange,
  quoteCache: Map<string, Promise<MarketBbo>>,
  signal: AbortSignal,
): Promise<MarketBbo> {
  let pending = quoteCache.get(market.slug);
  if (pending === undefined) {
    signal.throwIfAborted();
    pending = exchange.getBbo(market.id);
    quoteCache.set(market.slug, pending);
  }
  const bbo = await pending;
  signal.throwIfAborted();
  return bbo;
}

/**
 * Rejects a NO_POSITIVE_EDGE pass when the model's own interval implies a
 * material conservative edge on either side at a frozen fresh quote. This is
 * a repair signal, not trade authorization: the model must still preview the
 * indicated side and submit a fully evidenced target, after which normal
 * depth, fee, settlement, risk, and execution validation applies.
 */
export async function auditNoPositiveEdgePasses(input: {
  readonly decision: AgentDecision;
  readonly marketsBySlug: ReadonlyMap<string, Market>;
  readonly previewedMarketSlugs: ReadonlySet<string>;
  readonly exchange: PredictionExchange;
  readonly maximumExecutionSpread: Decimal;
  readonly uncertaintyBoundWeight: Decimal;
  readonly quoteCache: Map<string, Promise<MarketBbo>>;
  readonly signal: AbortSignal;
}): Promise<PassEdgeAuditReport> {
  const dispositions = input.decision.candidateDispositions.filter(
    (disposition) =>
      disposition.outcome === "PASS" &&
      disposition.reasonCode === "NO_POSITIVE_EDGE" &&
      disposition.side !== undefined &&
      disposition.side !== null &&
      input.previewedMarketSlugs.has(disposition.marketSlug),
  );
  const checks: PassEdgeAuditCheck[] = [];
  const issues: DecisionCoverageIssue[] = [];

  for (const disposition of dispositions.slice(0, 12)) {
    const market = input.marketsBySlug.get(disposition.marketSlug);
    if (market === undefined || disposition.side == null) continue;
    let bbo: MarketBbo;
    try {
      bbo = await frozenBbo(
        market,
        input.exchange,
        input.quoteCache,
        input.signal,
      );
    } catch {
      checks.push({
        marketSlug: disposition.marketSlug,
        dispositionSide: disposition.side,
        evaluatedSide: disposition.side,
        status: "QUOTE_ERROR",
      });
      continue;
    }

    const candidates: {
      readonly side: OutcomeSide;
      readonly authorization: Decimal;
      readonly ask: Decimal;
      readonly spread: Decimal;
      readonly fee: Decimal;
      readonly edge: Decimal;
    }[] = [];
    for (const side of ["YES", "NO"] as const) {
      const probability = probabilityForSide(disposition, side);
      if (probability === undefined) continue;
      const sideBbo = bboForSide(bbo, side);
      const ask = sideBbo.ask;
      if (ask === undefined) {
        checks.push({
          marketSlug: disposition.marketSlug,
          dispositionSide: disposition.side,
          evaluatedSide: side,
          status: "NO_EXECUTABLE_ASK",
        });
        continue;
      }
      const spread = sideBbo.spread;
      if (spread === undefined) {
        checks.push({
          marketSlug: disposition.marketSlug,
          dispositionSide: disposition.side,
          evaluatedSide: side,
          status: "SPREAD_UNAVAILABLE",
          ask: ask.toFixed(),
        });
        continue;
      }
      if (spread.gt(input.maximumExecutionSpread)) {
        checks.push({
          marketSlug: disposition.marketSlug,
          dispositionSide: disposition.side,
          evaluatedSide: side,
          status: "SPREAD_TOO_WIDE",
          ask: ask.toFixed(),
          spread: spread.toFixed(),
        });
        continue;
      }
      const authorization = authorizationProbability(
        probability,
        input.uncertaintyBoundWeight,
      );
      const fee = estimateExchangeTakerFeePerContract(input.exchange.id, ask);
      const edge = authorization.minus(ask).minus(fee);
      const material = edge.gt(Decimal.max(market.priceTick, "0.005"));
      checks.push({
        marketSlug: disposition.marketSlug,
        dispositionSide: disposition.side,
        evaluatedSide: side,
        status: material ? "MATERIAL_POSITIVE" : "NON_POSITIVE",
        authorizationProbability: authorization.toFixed(),
        ask: ask.toFixed(),
        spread: spread.toFixed(),
        estimatedFeePerContract: fee.toFixed(),
        netEdgePerContract: edge.toFixed(),
      });
      if (material) {
        candidates.push({ side, authorization, ask, spread, fee, edge });
      }
    }

    const strongest = candidates.toSorted((left, right) =>
      right.edge.comparedTo(left.edge),
    )[0];
    if (strongest === undefined) continue;
    issues.push({
      code: "CONTRADICTORY_NO_POSITIVE_EDGE",
      marketSlug: disposition.marketSlug,
      message: `${disposition.marketSlug} is passed as NO_POSITIVE_EDGE, but its supplied interval implies a policy-adjusted P(${strongest.side})=${strongest.authorization.toFixed()} against frozen fresh ask ${strongest.ask.toFixed()}, estimated fee ${strongest.fee.toFixed()}, and net edge ${strongest.edge.toFixed()} per contract. Preview and evaluate ${strongest.side}; target it if evidence and settlement remain valid, or use a specific settlement, evidence, spread, depth, or risk blocker. Do not apply another confidence haircut outside the probability interval.`,
    });
  }

  return {
    schemaVersion: 1,
    auditPolicy: "BOTH_SIDES_AT_FROZEN_FRESH_BBO",
    checkedDispositionCount: dispositions.length,
    checks,
    issues,
  };
}
