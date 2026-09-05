import type { AgentConfig } from "../config/schema.js";
import type { RuntimeEnvironment } from "../config/env.js";
import type { PredictionExchange } from "./exchange.js";
import { createKalshiExchange } from "./kalshi/adapter.js";
import { deriveExchangeMemoryScope } from "./memory-scope.js";
import { createPolymarketUsExchange } from "./polymarket-us/adapter.js";

const KALSHI_DEMO_HOSTS = new Set([
  "external-api.demo.kalshi.co",
  "demo-api.kalshi.co",
]);

function kalshiMemoryScopeNamespace(
  baseUrl: string | undefined,
): string | undefined {
  return baseUrl !== undefined &&
    KALSHI_DEMO_HOSTS.has(new URL(baseUrl).hostname)
    ? "demo"
    : undefined;
}

export function createExchange(
  environment: RuntimeEnvironment,
  config: AgentConfig,
): PredictionExchange {
  switch (environment.EXCHANGE_ID) {
    case "polymarket-us": {
      if (
        environment.POLYMARKET_KEY_ID === undefined ||
        environment.POLYMARKET_SECRET_KEY === undefined
      ) {
        throw new Error("Polymarket credentials are required");
      }
      return createPolymarketUsExchange({
        memoryScope: deriveExchangeMemoryScope(
          "polymarket-us",
          environment.POLYMARKET_KEY_ID,
          environment.AGENT_MEMORY_SCOPE,
        ),
        clientOptions: {
          keyId: environment.POLYMARKET_KEY_ID,
          secretKey: environment.POLYMARKET_SECRET_KEY,
        },
        readRetry: {
          maximumRetries: config.exchange.maximumGetRetries,
          baseDelayMilliseconds: config.exchange.baseRetryDelayMilliseconds,
          maximumDelayMilliseconds:
            config.exchange.maximumRetryDelayMilliseconds,
        },
        maximumConcurrentRequests: config.exchange.maximumConcurrentRequests,
        targetRequestsPerSecond: config.exchange.targetRequestsPerSecond,
        activityLookbackDays: config.exchange.activityLookbackDays,
      });
    }
    case "kalshi": {
      if (
        environment.KALSHI_API_KEY_ID === undefined ||
        environment.KALSHI_PRIVATE_KEY === undefined
      ) {
        throw new Error("Kalshi credentials are required");
      }
      return createKalshiExchange({
        memoryScope: deriveExchangeMemoryScope(
          "kalshi",
          environment.KALSHI_API_KEY_ID,
          environment.AGENT_MEMORY_SCOPE,
          kalshiMemoryScopeNamespace(environment.KALSHI_API_BASE_URL),
        ),
        clientOptions: {
          apiKeyId: environment.KALSHI_API_KEY_ID,
          privateKey: environment.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n"),
          ...(environment.KALSHI_API_BASE_URL === undefined
            ? {}
            : { baseUrl: environment.KALSHI_API_BASE_URL }),
        },
        readRetry: {
          maximumRetries: config.exchange.maximumGetRetries,
          baseDelayMilliseconds: config.exchange.baseRetryDelayMilliseconds,
          maximumDelayMilliseconds:
            config.exchange.maximumRetryDelayMilliseconds,
        },
        maximumConcurrentRequests: config.exchange.maximumConcurrentRequests,
        targetRequestsPerSecond: config.exchange.targetRequestsPerSecond,
        activityLookbackDays: config.exchange.activityLookbackDays,
      });
    }
  }
}
