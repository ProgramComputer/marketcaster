import { Decimal } from "decimal.js";
import type { DetailedMarketContext } from "../agent/context-builder.js";
import type { PortfolioTarget } from "../agent/decision-schema.js";
import type { PredictionExchange } from "../exchanges/exchange.js";
import type { FreshForecastProbabilities } from "../llm/research-tools.js";

/** A probability estimate, including exactly zero or one, is never settlement evidence. */
export interface AuthoritativeResolution {
  readonly kind: "AUTHORITATIVE_RESOLUTION";
  readonly marketSlug: string;
  readonly marketId: string;
  readonly source: {
    readonly exchange: PredictionExchange["id"];
    readonly operation: "getSettlement";
  };
  readonly observedAt: string;
  readonly settledAt?: string;
  readonly yesPayout: Decimal;
}

export interface ResolutionReviewPolicy {
  selectMarketSlugs(input: {
    readonly targets: readonly PortfolioTarget[];
    readonly forecasts: FreshForecastProbabilities;
    readonly details: ReadonlyMap<string, DetailedMarketContext>;
  }): readonly string[];
  reviewTarget(input: {
    readonly target: PortfolioTarget;
    readonly resolution: AuthoritativeResolution;
  }): string | undefined;
}

/** Only exchange settlement records can reach the deployment's resolution policy. */
export async function reviewResolvedTargets(input: {
  readonly policy?: ResolutionReviewPolicy | undefined;
  readonly targets: readonly PortfolioTarget[];
  readonly forecasts: FreshForecastProbabilities;
  readonly details: ReadonlyMap<string, DetailedMarketContext>;
  readonly exchange: Pick<PredictionExchange, "id" | "getSettlement">;
  readonly now: () => Date;
  readonly signal: AbortSignal;
}) {
  const observations: {
    marketSlug: string;
    kind: "AUTHORITATIVE_RESOLUTION" | "UNCONFIRMED";
    resolution?: AuthoritativeResolution;
    reason?: string;
  }[] = [];
  const issues: { marketSlug: string; message: string }[] = [];
  if (input.policy === undefined) return { observations, issues };
  const requested = new Set(input.targets.map((target) => target.marketSlug));
  const slugs = [...new Set(input.policy.selectMarketSlugs(input))];
  if (slugs.some((slug) => !requested.has(slug)))
    throw new TypeError("Resolution policy selected an untargeted market");
  // Sequential reads keep the additional request fanout bounded and preserve abort checks.
  for (const marketSlug of slugs) {
    input.signal.throwIfAborted();
    const details = input.details.get(marketSlug);
    if (details?.slug !== marketSlug) {
      observations.push({
        marketSlug,
        kind: "UNCONFIRMED",
        reason: "Missing exact inspected contract",
      });
      continue;
    }
    let resolution: AuthoritativeResolution;
    try {
      const status = await input.exchange.getSettlement({
        exchange: input.exchange.id,
        value: details.id,
      });
      input.signal.throwIfAborted();
      const observedAt = input.now();
      const binary =
        status.state === "SETTLED_YES" || status.state === "SETTLED_NO";
      const expected = new Decimal(status.state === "SETTLED_YES" ? 1 : 0);
      if (
        !binary ||
        status.marketId.exchange !== input.exchange.id ||
        status.marketId.value !== details.id ||
        !Decimal.isDecimal(status.settlementPrice) ||
        !status.settlementPrice.eq(expected) ||
        !Number.isFinite(observedAt.getTime()) ||
        (status.settledAt !== undefined &&
          (!Number.isFinite(status.settledAt.getTime()) ||
            status.settledAt > observedAt))
      ) {
        observations.push({
          marketSlug,
          kind: "UNCONFIRMED",
          reason:
            "No consistent final binary settlement for the exact contract",
        });
        continue;
      }
      resolution = {
        kind: "AUTHORITATIVE_RESOLUTION",
        marketSlug,
        marketId: details.id,
        source: { exchange: input.exchange.id, operation: "getSettlement" },
        observedAt: observedAt.toISOString(),
        ...(status.settledAt === undefined
          ? {}
          : { settledAt: status.settledAt.toISOString() }),
        yesPayout: expected,
      };
    } catch (error) {
      if (input.signal.aborted) throw error;
      observations.push({
        marketSlug,
        kind: "UNCONFIRMED",
        reason: "Exchange settlement unavailable",
      });
      continue;
    }
    observations.push({
      marketSlug,
      kind: "AUTHORITATIVE_RESOLUTION",
      resolution,
    });
    for (const target of input.targets.filter(
      (item) => item.marketSlug === marketSlug,
    )) {
      const message = input.policy.reviewTarget({ target, resolution });
      if (message !== undefined) {
        if (
          typeof message !== "string" ||
          message.trim().length === 0 ||
          message.length > 4000
        )
          throw new TypeError(
            "Resolution review must return a bounded nonempty message",
          );
        issues.push({ marketSlug, message });
      }
    }
  }
  return { observations, issues };
}
