import type { PassResearchReadiness } from "../llm/research-tools.js";

export type CandidateFunnelStage =
  "SURFACED" | "INSPECTED" | "RESEARCHED" | "PREVIEWED" | "PROPOSED";

export type CandidateFunnelDropCode =
  | "SURFACED_NOT_INSPECTED"
  | "MECHANICALLY_UNQUALIFIED"
  | "INSPECTED_NOT_RESEARCHED"
  | "RESEARCHED_NOT_PREVIEWED"
  | "PREVIEWED_NOT_PROPOSED"
  | "PROPOSED";

export interface CandidateFunnelEntry {
  readonly marketSlug: string;
  readonly stages: {
    readonly board: boolean;
    readonly preloaded: boolean;
    readonly surfaced: boolean;
    readonly inspected: boolean;
    readonly mechanicallyEvaluated: boolean;
    readonly mechanicallyQualified: boolean;
    readonly researched: boolean;
    readonly previewed: boolean;
    readonly proposed: boolean;
  };
  readonly furthestStage: CandidateFunnelStage;
  readonly dropCode: CandidateFunnelDropCode;
  readonly dropReason: string;
}

export interface CandidateFunnel {
  readonly counts: {
    readonly catalogued: number;
    readonly initialBoard: number;
    readonly surfacedUnique: number;
    readonly inspected: number;
    readonly mechanicallyEvaluated: number;
    readonly mechanicallyQualified: number;
    readonly researched: number;
    readonly previewed: number;
    readonly proposed: number;
    readonly explicitlyDispositioned?: number;
  };
  readonly passResearchGate: PassResearchReadiness;
  readonly candidates: readonly CandidateFunnelEntry[];
}

export interface BuildCandidateFunnelInput {
  readonly catalogued: number;
  readonly boardSlugs: readonly string[];
  readonly preloadedSlugs: readonly string[];
  readonly surfacedSlugs: ReadonlySet<string>;
  readonly inspectedSlugs: ReadonlySet<string>;
  readonly mechanicallyEvaluatedSlugs: ReadonlySet<string>;
  readonly mechanicallyQualifiedSlugs: ReadonlySet<string>;
  readonly researchedSlugs: ReadonlySet<string>;
  readonly previewedSlugs: ReadonlySet<string>;
  readonly proposedSlugs: readonly string[];
  readonly dispositionedSlugs?: readonly string[];
  readonly passResearchGate: PassResearchReadiness;
}

function stageAndDropCode(stages: CandidateFunnelEntry["stages"]): {
  readonly stage: CandidateFunnelStage;
  readonly code: CandidateFunnelDropCode;
  readonly reason: string;
} {
  if (stages.proposed) {
    return {
      stage: "PROPOSED",
      code: "PROPOSED",
      reason: "The candidate was submitted for deterministic validation.",
    };
  }
  if (
    stages.inspected &&
    stages.mechanicallyEvaluated &&
    !stages.mechanicallyQualified
  ) {
    return {
      stage: stages.previewed
        ? "PREVIEWED"
        : stages.researched
          ? "RESEARCHED"
          : "INSPECTED",
      code: "MECHANICALLY_UNQUALIFIED",
      reason:
        "The inspected market failed at least one activity, settlement-rule, quote, or spread qualification check.",
    };
  }
  if (stages.previewed) {
    return {
      stage: "PREVIEWED",
      code: "PREVIEWED_NOT_PROPOSED",
      reason: "A trade was previewed, but no proposal was submitted.",
    };
  }
  if (stages.researched) {
    return {
      stage: "RESEARCHED",
      code: "RESEARCHED_NOT_PREVIEWED",
      reason:
        "The candidate was researched, but no trade preview was requested.",
    };
  }
  if (stages.inspected) {
    return {
      stage: "INSPECTED",
      code: "INSPECTED_NOT_RESEARCHED",
      reason:
        "Market details were inspected, but no focused search or market analysis was attributed.",
    };
  }
  if (stages.surfaced) {
    return {
      stage: "SURFACED",
      code: "SURFACED_NOT_INSPECTED",
      reason:
        "The candidate was shown on the initial board or returned by discovery, but its details were not inspected.",
    };
  }
  return {
    stage: "SURFACED",
    code: "SURFACED_NOT_INSPECTED",
    reason:
      "The candidate was shown on the initial board or returned by discovery, but its details were not inspected.",
  };
}

export function buildCandidateFunnel(
  input: BuildCandidateFunnelInput,
): CandidateFunnel {
  if (!Number.isSafeInteger(input.catalogued) || input.catalogued < 0) {
    throw new RangeError("catalogued must be a non-negative safe integer");
  }
  const board = new Set(input.boardSlugs);
  const preloaded = new Set(input.preloadedSlugs);
  const surfaced = new Set([...board, ...preloaded, ...input.surfacedSlugs]);
  const inspected = new Set([...preloaded, ...input.inspectedSlugs]);
  const proposed = new Set(input.proposedSlugs);
  const orderedSlugs: string[] = [];
  const seen = new Set<string>();
  for (const slugs of [
    input.boardSlugs,
    input.preloadedSlugs,
    [...input.surfacedSlugs],
    [...input.inspectedSlugs],
    [...input.researchedSlugs],
    [...input.previewedSlugs],
    input.proposedSlugs,
  ]) {
    for (const slug of slugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      orderedSlugs.push(slug);
    }
  }

  const candidates = orderedSlugs.map((marketSlug): CandidateFunnelEntry => {
    const stages: CandidateFunnelEntry["stages"] = {
      board: board.has(marketSlug),
      preloaded: preloaded.has(marketSlug),
      surfaced: surfaced.has(marketSlug),
      inspected: inspected.has(marketSlug),
      mechanicallyEvaluated: input.mechanicallyEvaluatedSlugs.has(marketSlug),
      mechanicallyQualified: input.mechanicallyQualifiedSlugs.has(marketSlug),
      researched: input.researchedSlugs.has(marketSlug),
      previewed: input.previewedSlugs.has(marketSlug),
      proposed: proposed.has(marketSlug),
    };
    const disposition = stageAndDropCode(stages);
    return {
      marketSlug,
      stages,
      furthestStage: disposition.stage,
      dropCode: disposition.code,
      dropReason: disposition.reason,
    };
  });

  return {
    counts: {
      catalogued: input.catalogued,
      initialBoard: board.size,
      surfacedUnique: surfaced.size,
      inspected: inspected.size,
      mechanicallyEvaluated: input.mechanicallyEvaluatedSlugs.size,
      mechanicallyQualified: input.mechanicallyQualifiedSlugs.size,
      researched: input.researchedSlugs.size,
      previewed: input.previewedSlugs.size,
      proposed: proposed.size,
      explicitlyDispositioned: new Set(input.dispositionedSlugs ?? []).size,
    },
    passResearchGate: input.passResearchGate,
    candidates,
  };
}
