import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runCycle } from "./agent/cycle.js";
import { parseRuntimeEnvironment, resolveRuntimeMode } from "./config/env.js";
import { loadPromptBundle } from "./config/prompts.js";
import { loadRepositoryConfig } from "./config/schema.js";
import type { ExchangeId } from "./domain/primitives.js";
import { createExchange } from "./exchanges/factory.js";
import {
  ExecutionJournalError,
  SafetyGuardError,
} from "./execution/executor.js";
import { DecisionProviderError } from "./llm/decision-provider.js";
import { createDecisionProvider } from "./llm/factory.js";
import { IncompleteExchangeStateError } from "./portfolio/reconstruct.js";
import { UnresolvedLiveJournalError } from "./reporting/journal-recovery.js";
import { LiveCycleLockError } from "./reporting/live-cycle-lock.js";
import { createLogger } from "./reporting/logger.js";
import { createRunJournal, type RunJournal } from "./reporting/run-journal.js";
import { safeErrorCauses, safeErrorMessage } from "./utilities/redaction.js";

export const EXIT_CODE = {
  SUCCESS: 0,
  TECHNICAL_FAILURE: 1,
  INCOMPLETE_EXCHANGE_STATE: 2,
  INVALID_AGENT_DECISION: 3,
  AMBIGUOUS_ORDER: 4,
  SAFETY_GUARD: 5,
} as const;

function safeExchangeId(value: string | undefined): ExchangeId {
  return value === "kalshi" ||
    value === "polymarket-international" ||
    value === "polymarket-us"
    ? value
    : "polymarket-us";
}

export function classifyErrorExitCode(error: unknown): number {
  if (error instanceof IncompleteExchangeStateError) {
    return EXIT_CODE.INCOMPLETE_EXCHANGE_STATE;
  }
  if (
    error instanceof DecisionProviderError &&
    ["INVALID_RESPONSE", "INVALID_DECISION", "ROUND_LIMIT"].includes(error.code)
  ) {
    return EXIT_CODE.INVALID_AGENT_DECISION;
  }
  if (error instanceof SafetyGuardError) return EXIT_CODE.SAFETY_GUARD;
  if (error instanceof ExecutionJournalError && error.mutationMayHaveOccurred) {
    return EXIT_CODE.AMBIGUOUS_ORDER;
  }
  if (error instanceof UnresolvedLiveJournalError) {
    return EXIT_CODE.AMBIGUOUS_ORDER;
  }
  if (error instanceof LiveCycleLockError) return EXIT_CODE.SAFETY_GUARD;
  return EXIT_CODE.TECHNICAL_FAILURE;
}

export async function main(env = process.env): Promise<number> {
  const runId = env.GITHUB_RUN_ID ?? randomUUID();
  const cycleId = randomUUID();
  const mode = resolveRuntimeMode(env);
  const logger = createLogger({
    runId,
    cycleId,
    exchangeId: safeExchangeId(env.EXCHANGE_ID),
    runtimeMode: mode,
    stage: "initialization",
  });
  let journal: RunJournal | undefined;
  let reportingDirectory = "reports";
  let accountScope: string | undefined;

  try {
    const environment = parseRuntimeEnvironment(env);
    const [config, prompts] = await Promise.all([
      loadRepositoryConfig(),
      loadPromptBundle(),
    ]);
    reportingDirectory = config.reporting.directory;
    const exchange = createExchange(environment, config);
    accountScope = exchange.memoryScope;
    journal = await createRunJournal({
      rootDirectory: reportingDirectory,
      runId,
      cycleId,
      mode,
      exchangeId: exchange.id,
      accountScope,
    });
    const decisionProvider = await createDecisionProvider(environment, {
      reportingDirectory: config.reporting.directory,
      accountScope: exchange.memoryScope,
    });
    const report = await runCycle({
      config,
      prompts,
      exchange,
      decisionProvider,
      mode,
      logger,
      runId,
      cycleId,
      journal,
    });
    if (report.status === "AMBIGUOUS") return EXIT_CODE.AMBIGUOUS_ORDER;
    if (report.status === "SAFETY_STOP") return EXIT_CODE.SAFETY_GUARD;
    return EXIT_CODE.SUCCESS;
  } catch (error) {
    const exitCode = classifyErrorExitCode(error);
    const causes = safeErrorCauses(error);
    const errorReport = {
      runId,
      cycleId,
      mode,
      exchangeId: safeExchangeId(env.EXCHANGE_ID),
      failedAt: new Date().toISOString(),
      exitCode,
      error: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: safeErrorMessage(error),
        ...(causes.length === 0 ? {} : { causes }),
        ...(error instanceof z.ZodError
          ? {
              issues: error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            }
          : {}),
        ...(error instanceof UnresolvedLiveJournalError
          ? {
              journalIssues: error.issues.map((issue) => ({
                reason: issue.reason,
                runId: issue.runId,
                cycleId: issue.cycleId,
                ...(issue.attemptId === undefined
                  ? {}
                  : { attemptId: issue.attemptId }),
                message: issue.message,
              })),
            }
          : {}),
      },
    };
    logger.error(errorReport, "Prediction cycle failed");
    try {
      journal ??= await createRunJournal({
        rootDirectory: reportingDirectory,
        runId,
        cycleId,
        mode,
        exchangeId: safeExchangeId(env.EXCHANGE_ID),
        ...(accountScope === undefined ? {} : { accountScope }),
      });
      await journal.fail(errorReport, { exitCode });
    } catch (artifactError) {
      logger.error(
        {
          error:
            artifactError instanceof Error
              ? artifactError.message
              : "Unknown artifact failure",
        },
        "Could not write failure artifact",
      );
    }
    return exitCode;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await main();
}
