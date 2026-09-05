import type {
  DecisionToolDefinition,
  DecisionToolName,
} from "./research-tools.js";

export const PRIMARY_MODEL_HANDOFF_TOOL_NAME =
  "continue_with_primary_model" as const;

const CATALOG_TOOL_NAMES = new Set<DecisionToolName>([
  "list_market_facets",
  "discover_markets",
  "get_market_details",
  "get_market_family_details",
]);

export interface RoutedDecisionToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly terminal: boolean;
}

const PrimaryModelHandoffToolDefinition: RoutedDecisionToolDefinition =
  Object.freeze({
    name: PRIMARY_MODEL_HANDOFF_TOOL_NAME,
    description:
      "Hand the current catalog findings to the primary model. Call this as soon as candidate narrowing is complete, or whenever web research, evidence reading, market analysis, trade preview, notes/state changes, or the final trade plan is needed.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
    terminal: false,
  });

export const PRIMARY_MODEL_HANDOFF_RESULT = JSON.stringify({
  ok: true,
  primaryModelActivated: true,
  message:
    "Catalog narrowing is complete. Continue with the primary model for research, analysis, preview, persistence, and the final trade plan.",
});

export function isCatalogToolName(name: string): boolean {
  return CATALOG_TOOL_NAMES.has(name as DecisionToolName);
}

export function isPrimaryModelHandoffToolName(name: string): boolean {
  return name === PRIMARY_MODEL_HANDOFF_TOOL_NAME;
}

export function definitionsForCatalogModel(
  definitions: readonly DecisionToolDefinition[],
): readonly RoutedDecisionToolDefinition[] {
  return Object.freeze([
    ...definitions.filter((definition) => isCatalogToolName(definition.name)),
    PrimaryModelHandoffToolDefinition,
  ]);
}
