import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_REPORT_DIRECTORY,
  loadRuntimeConfiguration,
} from "../dist/src/config/runtime-overrides.js";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "marketcaster-overrides-"),
);

try {
  const defaults = await loadRuntimeConfiguration({});
  assert.equal(defaults.config.reporting.directory, DEFAULT_REPORT_DIRECTORY);
  assert.equal(
    defaults.config.marketSelection.opportunityBoardVariant,
    "EXCHANGE_RANK",
  );
  assert.deepEqual(defaults.config.exchange.managedRestingBuyOrders, {
    enabled: false,
    maximumLifetimeMinutes: 15,
  });

  const alternatePromptPath = join(temporaryDirectory, "decision-system.md");
  const alternatePrompt = "Reference override smoke-test system prompt.";
  await writeFile(alternatePromptPath, alternatePrompt, "utf8");

  const alternateConfigPath = join(temporaryDirectory, "production.json");
  const defaultConfig = await readFile(
    resolve("config", "default.json"),
    "utf8",
  );
  const alternateConfig = defaultConfig
    .replace('"maximumPromptMarkets": 24', '"maximumPromptMarkets": 23')
    .replace(
      '"enabled": false,\n      "maximumLifetimeMinutes": 15',
      '"enabled": true,\n      "maximumLifetimeMinutes": 10',
    )
    .replace('"directory": "reports"', '"directory": "from-explicit-config"');
  assert.notEqual(alternateConfig, defaultConfig);
  await writeFile(alternateConfigPath, alternateConfig, "utf8");

  const overridden = await loadRuntimeConfiguration({
    MARKETCASTER_CONFIG_PATH: alternateConfigPath,
    MARKETCASTER_DECISION_PROMPT_PATH: alternatePromptPath,
    MARKETCASTER_REPORT_DIR: "from-report-override",
  });
  assert.equal(overridden.config.marketSelection.maximumPromptMarkets, 23);
  assert.deepEqual(overridden.config.exchange.managedRestingBuyOrders, {
    enabled: true,
    maximumLifetimeMinutes: 10,
  });
  assert.equal(overridden.config.reporting.directory, "from-report-override");
  assert.equal(overridden.prompts.decision.system, alternatePrompt);
  assert.equal(
    overridden.prompts.decision.user,
    defaults.prompts.decision.user,
  );

  const restored = await loadRuntimeConfiguration({});
  assert.equal(
    restored.config.marketSelection.maximumPromptMarkets,
    defaults.config.marketSelection.maximumPromptMarkets,
  );
  assert.equal(
    restored.prompts.decision.system,
    defaults.prompts.decision.system,
  );

  await assert.rejects(
    loadRuntimeConfiguration({
      MARKETCASTER_CONFIG_PATH: join(temporaryDirectory, "missing.json"),
    }),
  );
  await assert.rejects(
    loadRuntimeConfiguration({
      MARKETCASTER_DECISION_PROMPT_PATH: join(
        temporaryDirectory,
        "missing-system.md",
      ),
    }),
  );

  const malformedConfigPath = join(temporaryDirectory, "malformed.json");
  await writeFile(malformedConfigPath, "{", "utf8");
  await assert.rejects(
    loadRuntimeConfiguration({
      MARKETCASTER_CONFIG_PATH: malformedConfigPath,
    }),
    /Invalid JSON in configuration file/u,
  );

  const customVariantPath = join(temporaryDirectory, "custom-variant.json");
  await writeFile(
    customVariantPath,
    defaultConfig.replace('"EXCHANGE_RANK"', '"SYNTHETIC_CUSTOM"'),
  );
  await assert.rejects(
    loadRuntimeConfiguration({ MARKETCASTER_CONFIG_PATH: customVariantPath }),
    /requires MARKETCASTER_STRATEGY_PATH/,
  );
  await assert.rejects(
    loadRuntimeConfiguration({
      MARKETCASTER_STRATEGY_PATH: join(temporaryDirectory, "missing.mjs"),
    }),
  );
  const invalidConfigPath = join(temporaryDirectory, "invalid.json");
  await writeFile(invalidConfigPath, "{}\n", "utf8");
  await assert.rejects(
    loadRuntimeConfiguration({
      MARKETCASTER_CONFIG_PATH: invalidConfigPath,
    }),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
