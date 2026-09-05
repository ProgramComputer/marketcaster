import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const CYCLE_CONTEXT_PLACEHOLDER = "{{CYCLE_CONTEXT}}";

const PromptTextSchema = z.string().trim().min(1);

const ResearchToolPromptsSchema = z
  .object({
    web_search: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            query: PromptTextSchema,
            marketSlug: PromptTextSchema,
            marketSlugs: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    read_evidence_source: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            url: PromptTextSchema,
            find: PromptTextSchema,
            marketSlug: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    discover_markets: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            mode: PromptTextSchema,
            query: PromptTextSchema,
            category: PromptTextSchema,
            tag: PromptTextSchema,
            event: PromptTextSchema,
            series: PromptTextSchema,
            cursor: PromptTextSchema,
            limit: PromptTextSchema,
            closesAfter: PromptTextSchema,
            closesBefore: PromptTextSchema,
            minimumLiquidityUsd: PromptTextSchema,
            minimumVolumeUsd: PromptTextSchema,
            minimumPriceMovement: PromptTextSchema,
            maximumSpread: PromptTextSchema,
            minimumBookDepth: PromptTextSchema,
            bookDepthWithinPricePoints: PromptTextSchema,
            minimumOpenInterest: PromptTextSchema,
            minimumYesPrice: PromptTextSchema,
            maximumYesPrice: PromptTextSchema,
            yesPriceBasis: PromptTextSchema,
            maximumDataAgeSeconds: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    list_market_facets: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            kind: PromptTextSchema,
            query: PromptTextSchema,
            cursor: PromptTextSchema,
            limit: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    get_market_details: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            marketSlug: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    get_market_family_details: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            marketSlug: PromptTextSchema,
            limit: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    get_market_analysis: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            marketSlug: PromptTextSchema,
            window: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    preview_trade: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            marketSlug: PromptTextSchema,
            side: PromptTextSchema,
            action: PromptTextSchema,
            quantity: PromptTextSchema,
            limitPrice: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    manage_notes: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            action: PromptTextSchema,
            noteId: PromptTextSchema,
            content: PromptTextSchema,
            cursor: PromptTextSchema,
            evidenceUrls: PromptTextSchema,
            basisMarketSlugs: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    manage_state: z
      .object({
        description: PromptTextSchema,
        arguments: z
          .object({
            action: PromptTextSchema,
            beliefId: PromptTextSchema,
            type: PromptTextSchema,
            confidence: PromptTextSchema,
            content: PromptTextSchema,
            marketSlugs: PromptTextSchema,
            evidenceUpdatedAt: PromptTextSchema,
            status: PromptTextSchema.optional(),
            supersedesBeliefId: PromptTextSchema.optional(),
            expiresAt: PromptTextSchema.optional(),
            reviewAt: PromptTextSchema.optional(),
            invalidationConditions: PromptTextSchema,
            cursor: PromptTextSchema,
            evidenceUrls: PromptTextSchema,
            basisMarketSlugs: PromptTextSchema,
          })
          .strict(),
      })
      .strict(),
    submit_trade_plan: z
      .object({
        description: PromptTextSchema,
        arguments: z.object({}).strict(),
      })
      .strict(),
  })
  .strict();

const ResearchToolMessagesSchema = z
  .object({
    unknownTool: PromptTextSchema,
    invalidWebSearchInput: PromptTextSchema,
    searchUnavailable: PromptTextSchema,
    searchFailed: PromptTextSchema,
    searchResultsSecurityNotice: PromptTextSchema,
    invalidEvidenceSourceReadInput: PromptTextSchema,
    evidenceSourceNotObserved: PromptTextSchema,
    evidenceSourceReadFailed: PromptTextSchema,
    evidenceSourceReadLimitReached: PromptTextSchema,
    evidenceSourceSecurityNotice: PromptTextSchema,
    invalidMarketDiscoveryInput: PromptTextSchema,
    invalidMarketFacetInput: PromptTextSchema,
    marketDiscoveryUnavailable: PromptTextSchema,
    marketFacetsUnavailable: PromptTextSchema,
    marketDiscoveryFailed: PromptTextSchema,
    marketFacetsFailed: PromptTextSchema,
    marketDiscoveryLimitReached: PromptTextSchema,
    duplicateMarketDiscoveryRequest: PromptTextSchema,
    invalidMarketDiscoveryCursor: PromptTextSchema,
    marketDiscoveryCursorLoop: PromptTextSchema,
    marketDiscoveryNarrowingRequired: PromptTextSchema,
    marketDiscoverySecurityNotice: PromptTextSchema,
    marketFacetsSecurityNotice: PromptTextSchema,
    invalidMarketDetailsInput: PromptTextSchema,
    marketNotInContext: PromptTextSchema,
    marketDetailsRequired: PromptTextSchema,
    marketDetailsFailed: PromptTextSchema,
    marketDetailsSecurityNotice: PromptTextSchema,
    invalidMarketFamilyDetailsInput: PromptTextSchema,
    marketFamilyDetailsUnavailable: PromptTextSchema,
    marketFamilyDetailsFailed: PromptTextSchema,
    marketFamilyDetailsSecurityNotice: PromptTextSchema,
    invalidMarketAnalysisInput: PromptTextSchema,
    marketAnalysisUnavailable: PromptTextSchema,
    marketAnalysisFailed: PromptTextSchema,
    marketAnalysisSecurityNotice: PromptTextSchema,
    invalidTradePreviewInput: PromptTextSchema,
    tradePreviewUnavailable: PromptTextSchema,
    tradePreviewFailed: PromptTextSchema,
    tradePreviewSecurityNotice: PromptTextSchema,
    invalidAgentNoteInput: PromptTextSchema,
    agentNotesUnavailable: PromptTextSchema,
    agentNotesFailed: PromptTextSchema,
    agentNotesSecurityNotice: PromptTextSchema,
    invalidAgentStateInput: PromptTextSchema,
    agentStateUnavailable: PromptTextSchema,
    agentStateFailed: PromptTextSchema,
    agentStateSecurityNotice: PromptTextSchema,
    invalidTradePlanInput: PromptTextSchema,
    nextCyclePlanRequired: PromptTextSchema,
    passResearchRequired: PromptTextSchema,
  })
  .strict();

export interface DecisionPromptTemplates {
  readonly system: string;
  readonly user: string;
}

export type ResearchToolPrompts = z.infer<typeof ResearchToolPromptsSchema>;
export type ResearchToolMessages = z.infer<typeof ResearchToolMessagesSchema>;

export interface PromptBundle {
  readonly decision: DecisionPromptTemplates;
  readonly research: {
    readonly tools: ResearchToolPrompts;
    readonly messages: ResearchToolMessages;
  };
}

export interface PromptBundlePaths {
  readonly directory?: string;
  readonly decisionSystemPath?: string;
}

function parseJson(contents: string, fileName: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in prompt file ${fileName}`, {
      cause: error,
    });
  }
}

function validateUserTemplate(template: string): void {
  const contextPlaceholderCount =
    template.split(CYCLE_CONTEXT_PLACEHOLDER).length - 1;
  if (contextPlaceholderCount !== 1) {
    throw new Error(
      `Prompt file user.md must contain exactly one ${CYCLE_CONTEXT_PLACEHOLDER} placeholder`,
    );
  }

  const unresolvedPlaceholders =
    template
      .match(/\{\{[^{}]+\}\}/gu)
      ?.filter((value) => value !== CYCLE_CONTEXT_PLACEHOLDER) ?? [];
  if (unresolvedPlaceholders.length > 0) {
    throw new Error(
      `Prompt file user.md contains unsupported placeholders: ${unresolvedPlaceholders.join(", ")}`,
    );
  }
}

export async function loadPromptBundle(
  paths: PromptBundlePaths = {},
): Promise<PromptBundle> {
  const directory =
    paths.directory ??
    resolve(process.cwd(), "config", "prompt", "decision", "reference");
  const decisionSystemPath =
    paths.decisionSystemPath ?? resolve(directory, "system.md");
  const [systemSource, userSource, toolsSource, messagesSource] =
    await Promise.all([
      readFile(decisionSystemPath, "utf8"),
      readFile(resolve(directory, "user.md"), "utf8"),
      readFile(resolve(directory, "tools.json"), "utf8"),
      readFile(resolve(directory, "messages.json"), "utf8"),
    ]);

  const system = PromptTextSchema.parse(systemSource);
  const user = PromptTextSchema.parse(userSource);
  validateUserTemplate(user);

  return Object.freeze({
    decision: Object.freeze({ system, user }),
    research: Object.freeze({
      tools: Object.freeze(
        ResearchToolPromptsSchema.parse(parseJson(toolsSource, "tools.json")),
      ),
      messages: Object.freeze(
        ResearchToolMessagesSchema.parse(
          parseJson(messagesSource, "messages.json"),
        ),
      ),
    }),
  });
}
