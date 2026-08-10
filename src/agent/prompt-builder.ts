import type { AgentContext } from "./context-builder.js";
import {
  CYCLE_CONTEXT_PLACEHOLDER,
  type DecisionPromptTemplates,
} from "../config/prompts.js";
import { redactPotentialSecrets } from "../utilities/redaction.js";

export { redactPotentialSecrets } from "../utilities/redaction.js";

export interface DecisionPrompt {
  readonly system: string;
  readonly user: string;
}

export function serializeAgentContext(context: AgentContext): string {
  return redactPotentialSecrets(JSON.stringify(context, null, 2));
}

export function buildDecisionPrompt(
  context: AgentContext,
  templates: DecisionPromptTemplates,
): DecisionPrompt {
  const serializedContext = serializeAgentContext(context);
  return {
    system: templates.system,
    user: templates.user.replace(CYCLE_CONTEXT_PLACEHOLDER, serializedContext),
  };
}
