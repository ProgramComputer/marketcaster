import { z } from "zod";
import type { RuntimeMode } from "../domain/primitives.js";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalModelId = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}, z.string().min(1).optional());

const optionalFileSystemPath = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}, z.string().min(1).optional());

const optionalAgentMemoryScope = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized;
  },
  z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
    .optional(),
);

const optionalHttpUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "Expected an HTTP or HTTPS URL",
    })
    .optional(),
);

const KALSHI_API_HOSTS = new Set([
  "external-api.kalshi.com",
  "api.elections.kalshi.com",
  "external-api.demo.kalshi.co",
  "demo-api.kalshi.co",
]);

const optionalKalshiApiBaseUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .url()
    .refine(
      (value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username.length === 0 &&
          url.password.length === 0 &&
          url.port.length === 0 &&
          KALSHI_API_HOSTS.has(url.hostname) &&
          url.pathname === "/trade-api/v2" &&
          url.search.length === 0 &&
          url.hash.length === 0 &&
          !value.includes("?") &&
          !value.includes("#")
        );
      },
      {
        message:
          "Expected an official Kalshi HTTPS Trade API v2 base URL without authentication, query, fragment, or non-default port",
      },
    )
    .optional(),
);

export const RuntimeEnvironmentSchema = z
  .object({
    EXCHANGE_ID: z.enum(["polymarket-us", "kalshi"]).default("polymarket-us"),
    TRADING_MODE: z.enum(["observe", "live"]).default("observe"),
    POLYMARKET_KEY_ID: optionalSecret,
    POLYMARKET_SECRET_KEY: optionalSecret,
    KALSHI_API_KEY_ID: optionalSecret,
    KALSHI_PRIVATE_KEY: optionalSecret,
    KALSHI_API_BASE_URL: optionalKalshiApiBaseUrl,
    AGENT_MEMORY_SCOPE: optionalAgentMemoryScope,
    LLM_API_KEY: optionalSecret,
    LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
    LLM_BASE_URL: optionalHttpUrl,
    LLM_MODEL: z.string().min(1),
    LLM_CATALOG_MODEL: optionalModelId,
    MARKETCASTER_CONFIG_PATH: optionalFileSystemPath,
    MARKETCASTER_DECISION_PROMPT_PATH: optionalFileSystemPath,
    MARKETCASTER_REPORT_DIR: optionalFileSystemPath,
    GITHUB_RUN_ID: z.string().optional(),
    GITHUB_STEP_SUMMARY: z.string().optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if (value.EXCHANGE_ID === "polymarket-us") {
      if (value.POLYMARKET_KEY_ID === undefined) {
        context.addIssue({
          code: "custom",
          path: ["POLYMARKET_KEY_ID"],
          message: "Required for Polymarket account reconstruction",
        });
      }
      if (value.POLYMARKET_SECRET_KEY === undefined) {
        context.addIssue({
          code: "custom",
          path: ["POLYMARKET_SECRET_KEY"],
          message: "Required for Polymarket account reconstruction",
        });
      }
    }

    if (value.EXCHANGE_ID === "kalshi") {
      if (value.KALSHI_API_KEY_ID === undefined) {
        context.addIssue({
          code: "custom",
          path: ["KALSHI_API_KEY_ID"],
          message: "Required for Kalshi API authentication",
        });
      }
      if (value.KALSHI_PRIVATE_KEY === undefined) {
        context.addIssue({
          code: "custom",
          path: ["KALSHI_PRIVATE_KEY"],
          message: "Required for Kalshi API authentication",
        });
      }
    }

    if (value.LLM_API_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["LLM_API_KEY"],
        message: `Required for the ${value.LLM_PROVIDER} decision provider`,
      });
    }
  });

export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;

export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  return env.TRADING_MODE === "live" ? "live" : "observe";
}

export function parseRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): RuntimeEnvironment {
  return RuntimeEnvironmentSchema.parse(env);
}
