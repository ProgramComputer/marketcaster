import { loadStrategyPolicy, type StrategyPolicy } from "../strategy/policy.js";
import { DEFAULT_OPPORTUNITY_BOARD_VARIANT } from "../agent/opportunity-board.js";
import type { RuntimeEnvironment } from "./env.js";
import { loadPromptBundle, type PromptBundle } from "./prompts.js";
import { loadRepositoryConfig, type AgentConfig } from "./schema.js";

export const DEFAULT_REPORT_DIRECTORY = "reports";

type RuntimeFileOverrides = Pick<
  RuntimeEnvironment,
  | "MARKETCASTER_CONFIG_PATH"
  | "MARKETCASTER_STRATEGY_PATH"
  | "MARKETCASTER_DECISION_PROMPT_PATH"
  | "MARKETCASTER_REPORT_DIR"
>;

export interface RuntimeConfiguration {
  readonly config: AgentConfig;
  readonly prompts: PromptBundle;
  readonly strategy: StrategyPolicy;
}

export function requestedReportDirectory(env: NodeJS.ProcessEnv): string {
  const requested = env.MARKETCASTER_REPORT_DIR?.trim();
  return requested === undefined || requested.length === 0
    ? DEFAULT_REPORT_DIRECTORY
    : requested;
}

export async function loadRuntimeConfiguration(
  overrides: RuntimeFileOverrides,
): Promise<RuntimeConfiguration> {
  const promptPromise =
    overrides.MARKETCASTER_DECISION_PROMPT_PATH === undefined
      ? loadPromptBundle()
      : loadPromptBundle({
          decisionSystemPath: overrides.MARKETCASTER_DECISION_PROMPT_PATH,
        });
  const [repositoryConfig, prompts, strategy] = await Promise.all([
    loadRepositoryConfig(overrides.MARKETCASTER_CONFIG_PATH),
    promptPromise,
    loadStrategyPolicy(overrides.MARKETCASTER_STRATEGY_PATH),
  ]);
  const config =
    overrides.MARKETCASTER_REPORT_DIR === undefined
      ? repositoryConfig
      : {
          ...repositoryConfig,
          reporting: {
            ...repositoryConfig.reporting,
            directory: overrides.MARKETCASTER_REPORT_DIR,
          },
        };
  if (
    overrides.MARKETCASTER_STRATEGY_PATH === undefined &&
    config.marketSelection.opportunityBoardVariant !==
      DEFAULT_OPPORTUNITY_BOARD_VARIANT
  ) {
    throw new Error(
      "A non-reference selection variant requires MARKETCASTER_STRATEGY_PATH",
    );
  }
  return { config, prompts, strategy };
}
