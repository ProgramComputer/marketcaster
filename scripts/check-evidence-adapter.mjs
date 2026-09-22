import assert from "node:assert/strict";
import { log } from "node:console";
import { createHash } from "node:crypto";
import { fetchEvidencePage } from "../dist/src/agent/evidence-provenance.js";
import {
  assertStrategyPolicy,
  referenceStrategy,
} from "../dist/src/strategy/policy.js";

const requestedUrl = "https://source.example.test/records";
const body = JSON.stringify({
  observation: "Synthetic observed value: 7",
  datePublished: "2026-01-01T00:00:00Z",
});
const requests = [];
const options = {
  lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchImplementation: async (url) => {
    requests.push(String(url));
    return new globalThis.Response(body, {
      headers: { "content-type": "application/json" },
    });
  },
};
const adapter = {
  apiVersion: 1,
  extractText(input) {
    assert(Object.isFrozen(input));
    assert.deepEqual(input, {
      source: body,
      requestedUrl,
      finalUrl: requestedUrl,
      contentType: "application/json",
    });
    return JSON.parse(input.source).observation;
  },
};
const page = await fetchEvidencePage(requestedUrl, {
  ...options,
  contentAdapter: adapter,
});
assert.deepEqual(requests, [requestedUrl]);
assert.equal(page.text, "Synthetic observed value: 7");
assert.equal(page.finalUrl, requestedUrl);
assert.equal(page.publishedAt, "2026-01-01T00:00:00.000Z");
assert.equal(page.retrieval.requestedUrl, requestedUrl);
assert.equal(page.retrieval.finalUrl, requestedUrl);
assert.equal(page.retrieval.extractionMethod, "STRUCTURED_FEED");
assert.equal(
  page.retrieval.decodedBodySha256,
  createHash("sha256").update(body).digest("hex"),
);
assert.equal(
  page.retrieval.extractedTextSha256,
  createHash("sha256").update(page.text).digest("hex"),
);
assert.equal((await fetchEvidencePage(requestedUrl, options)).text, body);
assert.equal(
  (
    await fetchEvidencePage(requestedUrl, {
      ...options,
      contentAdapter: { apiVersion: 1, extractText: () => undefined },
    })
  ).text,
  body,
);
for (const invalid of [
  { apiVersion: 2, extractText: () => "x" },
  { apiVersion: 1 },
  null,
]) {
  const before = requests.length;
  await assert.rejects(
    fetchEvidencePage(requestedUrl, { ...options, contentAdapter: invalid }),
    /version 1/,
  );
  assert.equal(requests.length, before);
  assert.throws(
    () =>
      assertStrategyPolicy({
        ...referenceStrategy,
        evidenceContentAdapter: invalid,
      }),
    /version 1/,
  );
}
for (const extractText of [
  async () => "x",
  () => ({ text: "x", finalUrl: "https://other.example.test/" }),
]) {
  await assert.rejects(
    fetchEvidencePage(requestedUrl, {
      ...options,
      contentAdapter: { apiVersion: 1, extractText },
    }),
    /synchronously/,
  );
}
// Repeating an observed context field can expand a compact response. The
// existing bound applies to bytes retrieved, not formatted output length.
const compactBody = JSON.stringify({
  context: "Synthetic context ".repeat(4_000),
  observations: Array.from(
    { length: 70 },
    (_, index) => `Observation ${index}`,
  ),
});
assert(compactBody.length < 4 * 1_048_576);
const expanded = await fetchEvidencePage(requestedUrl, {
  ...options,
  fetchImplementation: async () =>
    new globalThis.Response(compactBody, {
      headers: { "content-type": "application/json" },
    }),
  contentAdapter: {
    apiVersion: 1,
    extractText({ source }) {
      const parsed = JSON.parse(source);
      return parsed.observations
        .map((observation) => `${parsed.context} | ${observation}`)
        .join("\n");
    },
  },
});
assert(expanded.text.length > 4 * 1_048_576);
assert.equal(expanded.retrieval.requestedUrl, requestedUrl);
assert.equal(
  expanded.retrieval.decodedBodySha256,
  createHash("sha256").update(compactBody).digest("hex"),
);
assert.equal(
  expanded.retrieval.extractedTextSha256,
  createHash("sha256").update(expanded.text).digest("hex"),
);
let oversizedAdapterCalls = 0;
for (const declared of [true, false]) {
  await assert.rejects(
    fetchEvidencePage(requestedUrl, {
      ...options,
      fetchImplementation: async () =>
        new globalThis.Response(
          declared ? body : "x".repeat(4 * 1_048_576 + 1),
          {
            headers: {
              "content-type": "application/json",
              ...(declared
                ? { "content-length": String(4 * 1_048_576 + 1) }
                : {}),
            },
          },
        ),
      contentAdapter: {
        apiVersion: 1,
        extractText() {
          oversizedAdapterCalls += 1;
          return "short text";
        },
      },
    }),
    (error) => error.reason === "RESPONSE_TOO_LARGE",
  );
}
assert.equal(oversizedAdapterCalls, 0);
let adapterCalls = 0;
await assert.rejects(
  fetchEvidencePage("https://127.0.0.1/", {
    ...options,
    contentAdapter: {
      apiVersion: 1,
      extractText: () => {
        adapterCalls += 1;
        return "x";
      },
    },
  }),
);
assert.equal(adapterCalls, 0);

// A redirect is validated before the adapter sees the final response identity.
let redirectInput;
const finalUrl = "https://destination.example.test/record";
const redirected = await fetchEvidencePage(requestedUrl, {
  ...options,
  fetchImplementation: async (url) =>
    String(url) === requestedUrl
      ? new globalThis.Response(null, {
          status: 302,
          headers: { location: finalUrl },
        })
      : new globalThis.Response(body, {
          headers: { "content-type": "application/json" },
        }),
  contentAdapter: {
    apiVersion: 1,
    extractText(input) {
      redirectInput = input;
      return JSON.parse(input.source).observation;
    },
  },
});
assert.equal(redirectInput.requestedUrl, requestedUrl);
assert.equal(redirectInput.finalUrl, finalUrl);
assert.equal(redirected.retrieval.finalUrl, finalUrl);
log(
  "Evidence adapter identity, raw provenance, bounds, SSRF, redirects, and contract checks passed.",
);
