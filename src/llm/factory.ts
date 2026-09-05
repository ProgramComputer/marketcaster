import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { RuntimeEnvironment } from "../config/env.js";
import { AnthropicDecisionProvider } from "./anthropic-provider.js";
import type { DecisionProvider } from "./decision-provider.js";
import { OpenAIDecisionProvider } from "./openai-provider.js";

const CurrentRunPointerSchema = z
  .object({
    accountScope: z.string().optional(),
    runDirectory: z.string().min(1),
    completedAt: z.iso.datetime({ offset: true }),
  })
  .loose();

const ANTHROPIC_DIAGNOSTIC_COMPARISON_MAXIMUM_AGE_MILLISECONDS = 60 * 60 * 1000;

const AnthropicTranscriptSchema = z
  .object({
    accountScope: z.string().optional(),
    data: z
      .object({
        provider: z.literal("anthropic"),
        model: z.string().min(1),
        rounds: z.array(
          z
            .object({
              modelId: z.string().min(1).optional(),
              response: z.object({ id: z.string().min(1) }).loose(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();

export interface DecisionProviderFactoryOptions {
  readonly reportingDirectory: string;
  readonly accountScope: string;
}

async function previousAnthropicMessageId(
  options: DecisionProviderFactoryOptions,
  modelId: string,
): Promise<string | undefined> {
  try {
    const reportingRoot = resolve(process.cwd(), options.reportingDirectory);
    const pointer = CurrentRunPointerSchema.parse(
      JSON.parse(
        await readFile(resolve(reportingRoot, "current", "index.json"), "utf8"),
      ) as unknown,
    );
    if (pointer.accountScope !== options.accountScope) return undefined;
    const comparisonAge = Date.now() - new Date(pointer.completedAt).getTime();
    if (
      comparisonAge < 0 ||
      comparisonAge > ANTHROPIC_DIAGNOSTIC_COMPARISON_MAXIMUM_AGE_MILLISECONDS
    ) {
      return undefined;
    }
    const transcriptPath = resolve(
      reportingRoot,
      pointer.runDirectory,
      "decision-transcript.json",
    );
    const relativeTranscriptPath = relative(reportingRoot, transcriptPath);
    if (
      relativeTranscriptPath.startsWith("..") ||
      isAbsolute(relativeTranscriptPath)
    ) {
      return undefined;
    }
    const transcript = AnthropicTranscriptSchema.parse(
      JSON.parse(await readFile(transcriptPath, "utf8")) as unknown,
    );
    if (transcript.accountScope !== options.accountScope) {
      return undefined;
    }
    return transcript.data.rounds.findLast(
      (round) => (round.modelId ?? transcript.data.model) === modelId,
    )?.response.id;
  } catch {
    return undefined;
  }
}

export async function createDecisionProvider(
  environment: RuntimeEnvironment,
  options: DecisionProviderFactoryOptions,
): Promise<DecisionProvider> {
  if (environment.LLM_API_KEY === undefined) {
    throw new Error("LLM_API_KEY is required for the decision provider");
  }
  if (environment.LLM_PROVIDER === "openai") {
    return new OpenAIDecisionProvider({
      apiKey: environment.LLM_API_KEY,
      modelId: environment.LLM_MODEL,
      ...(environment.LLM_CATALOG_MODEL === undefined
        ? {}
        : { catalogModelId: environment.LLM_CATALOG_MODEL }),
      ...(environment.LLM_BASE_URL === undefined
        ? {}
        : { baseURL: environment.LLM_BASE_URL }),
    });
  }
  const previousMessageId = await previousAnthropicMessageId(
    options,
    environment.LLM_CATALOG_MODEL ?? environment.LLM_MODEL,
  );
  return new AnthropicDecisionProvider({
    apiKey: environment.LLM_API_KEY,
    modelId: environment.LLM_MODEL,
    ...(environment.LLM_CATALOG_MODEL === undefined
      ? {}
      : { catalogModelId: environment.LLM_CATALOG_MODEL }),
    ...(previousMessageId === undefined ? {} : { previousMessageId }),
  });
}
