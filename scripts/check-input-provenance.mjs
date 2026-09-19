import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { loadPromptBundle } from "../src/config/prompts.ts";
import { loadRepositoryConfig } from "../src/config/schema.ts";
import { referenceStrategy } from "../src/strategy/policy.ts";
import { AnthropicDecisionProvider } from "../src/llm/anthropic-provider.ts";
import { OpenAIDecisionProvider } from "../src/llm/openai-provider.ts";
import { DecisionResearchTools } from "../src/llm/research-tools.ts";
import {
  provenanceIdentityFromEnvironment,
  redactedProvenanceSnapshot,
  renderedInputProvenance,
  runtimeInputProvenance,
} from "../src/reporting/decision-input-provenance.ts";
import {
  createRunJournal,
  decisionRequestRoundArtifactKind,
} from "../src/reporting/run-journal.ts";
import { checkCycleForecastMemory } from "./check-memory-cycle.mjs";

// Synthetic fixtures only. No production data or external requests.
const directory = await mkdtemp(join(tmpdir(), "input-provenance-check-"));
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Unexpected network access");
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const providerSecret = "synthetic-provider-credential";
const exchangeSecret = "synthetic-exchange-credential";
const identity = provenanceIdentityFromEnvironment({
  MARKETCASTER_DEPLOYMENT_SHA: "a".repeat(40),
  MARKETCASTER_ENGINE_SHA: "b".repeat(40),
  LLM_API_KEY: providerSecret,
  POLYMARKET_SECRET_KEY: exchangeSecret,
  LLM_BASE_URL:
    "https://endpoint-user:endpoint-password@example.invalid/?key=endpoint-token",
  UNRELATED_ENVIRONMENT_VALUE: "must-not-be-copied",
});
try {
  const config = await loadRepositoryConfig();
  const runtime = runtimeInputProvenance({
    identity,
    provider: "synthetic",
    model: "synthetic-primary",
    config: { ...config, unrelated: "must-not-be-copied" },
    strategy: { ...referenceStrategy, unrelated: "must-not-be-copied" },
  });
  assert.equal(runtime.productionSha, "a".repeat(40));
  assert.equal(runtime.engineSha, "b".repeat(40));
  assert.equal(
    runtime.effectiveConfiguration.sha256,
    hash(runtime.effectiveConfiguration.json),
  );
  assert.ok(!JSON.stringify(runtime).includes("must-not-be-copied"));
  assert.ok(!JSON.stringify(runtime).includes(providerSecret));
  assert.equal(
    provenanceIdentityFromEnvironment({ MARKETCASTER_ENGINE_SHA: "invalid" })
      .engineSha,
    null,
  );

  const secretFixture = redactedProvenanceSnapshot(
    {
      nested: {
        apiKey: "nested-secret",
        privateKey: "nested-private",
        access_token: "nested-token",
      },
      prose: `Credentials ${providerSecret} and ${exchangeSecret}; endpoint-user endpoint-password endpoint-token; apiKey="embedded-key"`,
      url: "https://user:pass@example.invalid/source?key=url-secret&access_token=url-token&part=visible",
      maximumOutputTokens: 123,
    },
    identity.secretValues,
  );
  for (const secret of [
    providerSecret,
    exchangeSecret,
    "nested-secret",
    "nested-private",
    "nested-token",
    "embedded-key",
    "url-secret",
    "url-token",
    "user:pass",
    "endpoint-user",
    "endpoint-password",
    "endpoint-token",
  ]) {
    assert.ok(
      !secretFixture.json.includes(secret),
      `Credential leaked: ${secret}`,
    );
  }
  assert.equal(secretFixture.redacted, true);
  assert.equal(secretFixture.sha256, hash(secretFixture.json));
  assert.equal(JSON.parse(secretFixture.json).maximumOutputTokens, 123);
  assert.ok(secretFixture.json.includes("part=visible"));
  const quotedSecret = 'synthetic "quoted" credential';
  const escapedSecret = redactedProvenanceSnapshot(
    { text: JSON.stringify({ note: quotedSecret }) },
    [quotedSecret],
  );
  assert.ok(!escapedSecret.json.includes("quoted"));
  assert.equal(escapedSecret.redacted, true);
  for (const key of [
    "token",
    "secret",
    "signature",
    "credentials",
    "access_token",
    "clientSecret",
  ]) {
    const credential = 'synthetic-unlisted-"quoted"-credential';
    const embedded = JSON.stringify({ outer: { [key]: credential } });
    for (const content of [
      embedded,
      JSON.stringify(embedded),
      `Synthetic prose ${key}=${JSON.stringify(credential)}`,
    ]) {
      const snapshot = redactedProvenanceSnapshot({ content });
      assert.equal(
        snapshot.redacted,
        true,
        `${key}: embedded credentials must mark redaction`,
      );
      assert.ok(
        !snapshot.json.includes("synthetic-unlisted"),
        `${key}: embedded credential leaked`,
      );
      assert.ok(
        !snapshot.json.includes("quoted"),
        `${key}: escaped credential suffix leaked`,
      );
      assert.equal(snapshot.sha256, hash(snapshot.json));
    }
  }
  const cleanEmbedded =
    '  { "result": "Synthetic clean content", "count": 2 }  ';
  const cleanEmbeddedSnapshot = redactedProvenanceSnapshot({
    content: cleanEmbedded,
    encoded: JSON.stringify(cleanEmbedded),
  });
  assert.deepEqual(JSON.parse(cleanEmbeddedSnapshot.json), {
    content: cleanEmbedded,
    encoded: JSON.stringify(cleanEmbedded),
  });
  assert.equal(cleanEmbeddedSnapshot.redacted, false);
  const cleanPrompt = {
    system: "Synthetic system",
    user: "Synthetic user with Unicode \u2603",
  };
  const clean = renderedInputProvenance(cleanPrompt, []);
  assert.deepEqual(JSON.parse(clean.prompt.json), cleanPrompt);
  assert.equal(clean.prompt.redacted, false);

  const prompts = await loadPromptBundle();
  for (const [Provider, providerId] of [
    [AnthropicDecisionProvider, "anthropic"],
    [OpenAIDecisionProvider, "openai"],
  ]) {
    const journal = await createRunJournal({
      rootDirectory: directory,
      runId: "synthetic",
      cycleId: providerId,
      mode: "observe",
      exchangeId: "kalshi",
    });
    let attempts = 0;
    let prepared;
    let originalBody;
    const provider = new Provider({
      apiKey: providerSecret,
      modelId: "synthetic-primary",
      catalogModelId: "synthetic-catalog",
      fetchImplementation: async (_url, init) => {
        attempts += 1;
        originalBody = init.body;
        // Persistence finishes before HTTP and a retry reuses the same identity.
        const saved = JSON.parse(
          await readFile(
            join(journal.runDirectory, "decision-request.round-0001.json"),
            "utf8",
          ),
        );
        assert.deepEqual(saved.data, prepared);
        return new globalThis.Response("{}", {
          status: attempts === 1 ? 429 : 400,
          headers: { "retry-after": "0" },
        });
      },
    });
    await assert.rejects(
      provider.decide({
        prompt: {
          system: `Synthetic system ${providerSecret}`,
          user: `Synthetic input ${exchangeSecret}`,
        },
        researchTools: new DecisionResearchTools({ prompts: prompts.research }),
        limits: {
          maximumRounds: 2,
          maximumWebSearches: 0,
          timeoutMilliseconds: 5000,
        },
        provenanceSecretValues: identity.secretValues,
        recordModelRequest: async (request) => {
          assert.equal(
            prepared,
            undefined,
            "Transport retries do not overwrite the prepared request",
          );
          prepared = request;
          await journal.recordArtifact(
            decisionRequestRoundArtifactKind(request.round),
            request,
          );
        },
      }),
      (error) => error.code === "HTTP",
    );
    assert.equal(attempts, 2);
    assert.equal(prepared.model, "synthetic-catalog");
    assert.equal(prepared.phase, "PREPARED_BEFORE_SEND");
    assert.equal(
      prepared.request.sha256,
      hash(prepared.request.initialBodyJson),
    );
    assert.equal(prepared.tools.sha256, hash(prepared.tools.json));
    assert.equal(prepared.settings.sha256, hash(prepared.settings.json));
    assert.equal(prepared.request.redacted, true);
    assert.ok(
      originalBody.includes(providerSecret),
      "Capture does not mutate provider inputs",
    );
    assert.ok(!JSON.stringify(prepared).includes(providerSecret));
    assert.ok(!JSON.stringify(prepared).includes(exchangeSecret));
    assert.ok(!Object.hasOwn(prepared, "headers"));
    await assert.rejects(
      journal.recordArtifact(decisionRequestRoundArtifactKind(1), {
        replacement: true,
      }),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(journal.runDirectory, "decision-request.round-0001.json"),
          "utf8",
        ),
      ).data,
      prepared,
      "A rejected duplicate cannot change the original artifact",
    );
    await journal.fail({ error: "Synthetic provider failure" });
    const manifest = JSON.parse(
      await readFile(join(journal.runDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.stage, "FAILED");
    assert.ok(manifest.artifacts["decision-request.round-0001"]);

    const invalidJournal = await createRunJournal({
      rootDirectory: directory,
      runId: "synthetic",
      cycleId: `${providerId}-invalid`,
      mode: "observe",
      exchangeId: "kalshi",
    });
    let cleanPrepared;
    const invalidProvider = new Provider({
      apiKey: providerSecret,
      modelId: "synthetic-primary",
      fetchImplementation: async (_url, init) => {
        assert.equal(
          cleanPrepared.request.initialBodyJson,
          init.body,
          "Without redaction the initial capture matches the exact serialized HTTP body",
        );
        return new globalThis.Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(
      invalidProvider.decide({
        prompt: cleanPrompt,
        researchTools: new DecisionResearchTools({ prompts: prompts.research }),
        limits: {
          maximumRounds: 1,
          maximumWebSearches: 0,
          timeoutMilliseconds: 5000,
        },
        recordModelRequest: async (request) => {
          cleanPrepared = request;
          await invalidJournal.recordArtifact(
            decisionRequestRoundArtifactKind(request.round),
            request,
          );
        },
      }),
      (error) => error.code === "INVALID_RESPONSE",
    );
    assert.equal(cleanPrepared.model, "synthetic-primary");
    assert.equal(cleanPrepared.request.redacted, false);
    await invalidJournal.fail({ error: "Synthetic invalid response" });
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(invalidJournal.runDirectory, "decision-request.round-0001.json"),
          "utf8",
        ),
      ).data,
      cleanPrepared,
    );
  }
  // Existing offline cycle fixture proves the integration writes rendered inputs
  // even for a custom provider which has no HTTP request callback.
  await checkCycleForecastMemory(directory, prompts);
  const cycleDirectory = join(
    directory,
    "full-cycle",
    "runs",
    "memory-fixture",
    "scalar-conflict",
  );
  const captured = JSON.parse(
    await readFile(join(cycleDirectory, "decision-input.json"), "utf8"),
  );
  assert.equal(captured.data.prompt.sha256, hash(captured.data.prompt.json));
  assert.ok(JSON.parse(captured.data.prompt.json).user.length > 0);
  const effective = JSON.parse(
    await readFile(join(cycleDirectory, "runtime-provenance.json"), "utf8"),
  );
  assert.equal(
    effective.data.effectiveConfiguration.sha256,
    hash(effective.data.effectiveConfiguration.json),
  );
  process.stdout.write(
    "Input provenance checks passed (offline, redacted, immutable, failure-preserving)\n",
  );
} finally {
  globalThis.fetch = previousFetch;
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
