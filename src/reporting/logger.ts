import pino, { type Logger } from "pino";
import type { ExchangeId, RuntimeMode } from "../domain/primitives.js";

export interface LoggerContext {
  readonly runId: string;
  readonly cycleId: string;
  readonly exchangeId: ExchangeId;
  readonly runtimeMode: RuntimeMode;
  readonly stage?: string;
}

const REDACT_PATHS = [
  "POLYMARKET_SECRET_KEY",
  "POLYMARKET_KEY_ID",
  "KALSHI_PRIVATE_KEY",
  "KALSHI_API_KEY_ID",
  "AGENT_MEMORY_SCOPE",
  "LLM_API_KEY",
  "secretKey",
  "privateKey",
  "apiKey",
  "apiKeyId",
  "authorization",
  "headers.authorization",
  "headers.X-PM-Signature",
  "headers.KALSHI-ACCESS-KEY",
  "headers.KALSHI-ACCESS-SIGNATURE",
];

export function createLogger(context: LoggerContext): Logger {
  return pino({
    base: context,
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}

export function stageLogger(logger: Logger, stage: string): Logger {
  return logger.child({ stage });
}
