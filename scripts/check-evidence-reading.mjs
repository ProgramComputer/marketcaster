import assert from "node:assert/strict";
import {
  assertPublicEvidenceUrl,
  EvidencePageReadError,
  evidencePageReadFailureReason,
  fetchEvidencePage,
  isPublicIpAddress,
} from "../dist/src/agent/evidence-provenance.js";
import { loadPromptBundle } from "../dist/src/config/prompts.js";
import { DEFAULT_DECISION_LIMITS } from "../dist/src/llm/decision-provider.js";
import {
  DecisionResearchTools,
  selectEvidenceSourceText,
} from "../dist/src/llm/research-tools.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const pageUrl = "https://example.com/observations";

let requestHeaders;
const source = `<html><body><pre>COLUMN  DATE  VALUE\nROW  2026-09-04  42</pre>${"x".repeat(
  2 * 1_048_576,
)}</body></html>`;
const page = await fetchEvidencePage(pageUrl, {
  lookupImplementation: publicLookup,
  fetchImplementation: async (_url, init) => {
    requestHeaders = new globalThis.Headers(init?.headers);
    return new globalThis.Response(source, {
      headers: { "content-type": "text/html" },
    });
  },
});

assert.match(page.text, /COLUMN DATE VALUE\nROW 2026-09-04 42/u);
assert.match(requestHeaders?.get("user-agent") ?? "", /^MarketCaster\//u);
assert.equal(requestHeaders?.get("accept-language"), "en-US,en;q=0.8");

await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response("denied", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
  }),
  (error) => evidencePageReadFailureReason(error) === "ACCESS_DENIED",
);

await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response("oversized", {
        headers: {
          "content-length": String(4 * 1_048_576 + 1),
          "content-type": "text/plain",
        },
      }),
  }),
  (error) => evidencePageReadFailureReason(error) === "RESPONSE_TOO_LARGE",
);

let redirectBodyCancelled = false;
await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response(
        new globalThis.ReadableStream({
          cancel() {
            redirectBodyCancelled = true;
          },
        }),
        {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        },
      ),
  }),
  (error) => evidencePageReadFailureReason(error) === "UNSAFE_URL",
);
assert.equal(redirectBodyCancelled, true);

let rebindingLookupCount = 0;
await assert.rejects(
  fetchEvidencePage("http://rebind.invalid/source", {
    lookupImplementation: async () => {
      rebindingLookupCount += 1;
      return rebindingLookupCount === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
  }),
  (error) => evidencePageReadFailureReason(error) === "UNSAFE_URL",
);
assert.ok(rebindingLookupCount >= 2);

assert.equal(isPublicIpAddress("0:0:0:0:0:0:0:1"), false);
assert.equal(isPublicIpAddress("0:0:0:0:0:ffff:7f00:1"), false);
assert.equal(isPublicIpAddress("::ffff:8.8.8.8"), true);
assert.equal(isPublicIpAddress("fec0::1"), false);
assert.equal(isPublicIpAddress("64:ff9b:1::7f00:1"), false);
assert.equal(isPublicIpAddress("64:ff9b::7f00:1"), false);
assert.equal(isPublicIpAddress("64:ff9b::808:808"), true);
assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
await assert.rejects(
  assertPublicEvidenceUrl("http://[0:0:0:0:0:0:0:1]/"),
  (error) => evidencePageReadFailureReason(error) === "UNSAFE_URL",
);

await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response("x".repeat(4 * 1_048_576 + 1), {
        headers: { "content-type": "text/plain" },
      }),
  }),
  (error) => evidencePageReadFailureReason(error) === "RESPONSE_TOO_LARGE",
);

const exactSelection = selectEvidenceSourceText(
  `${"prefix ".repeat(200)}ROW ITEM VALUE 42${" suffix".repeat(200)}`,
  "ROW ITEM VALUE 42",
);
assert.ok(
  exactSelection.claimExcerptCandidates.some((candidate) =>
    candidate.includes("ROW ITEM VALUE 42"),
  ),
);
assert.ok(
  exactSelection.claimExcerptCandidates.every(
    (candidate) => candidate.length <= 600 && !candidate.includes("\n...\n"),
  ),
);

const unicodePrefixSelection = selectEvidenceSourceText(
  `${"İ".repeat(50)} TARGET VALUE 42`,
  "target value 42",
);
assert.ok(
  unicodePrefixSelection.claimExcerptCandidates.some((candidate) =>
    candidate.includes("TARGET VALUE 42"),
  ),
);

const prompts = await loadPromptBundle();
const failingSourceUrl = "https://example.com/failing-source";
let cachedFailureReadCount = 0;
const researchTools = new DecisionResearchTools({
  prompts: prompts.research,
  evidencePageReader: () => {
    cachedFailureReadCount += 1;
    return Promise.reject(
      new EvidencePageReadError("ACCESS_DENIED", "Synthetic denied page"),
    );
  },
});
const researchSession = researchTools.createSession({
  ...DEFAULT_DECISION_LIMITS,
  maximumEvidenceSourceReadRequests: 2,
});
researchTools.recordProviderEvidenceSources([
  {
    url: failingSourceUrl,
    title: "Synthetic source",
    observedAt: "2026-09-04T12:00:00.000Z",
    provider: "CLIENT_WEB_SEARCH",
  },
]);
const readInput = { url: failingSourceUrl };
const readSignal = new globalThis.AbortController().signal;
const firstFailedRead = await researchSession.execute(
  "read_evidence_source",
  readInput,
  readSignal,
);
const secondFailedRead = await researchSession.execute(
  "read_evidence_source",
  readInput,
  readSignal,
);
assert.deepEqual(secondFailedRead, firstFailedRead);
assert.equal(firstFailedRead.errorCode, "EVIDENCE_SOURCE_READ_FAILED");
assert.equal(JSON.parse(firstFailedRead.content).reason, "ACCESS_DENIED");
assert.equal(cachedFailureReadCount, 1);

const exhaustedRead = await researchSession.execute(
  "read_evidence_source",
  readInput,
  readSignal,
);
assert.equal(exhaustedRead.errorCode, "EVIDENCE_SOURCE_READ_LIMIT_REACHED");
assert.equal(
  cachedFailureReadCount,
  1,
  "Failure caching does not grant extra tool attempts",
);

for (const [status, reason] of [
  [401, "ACCESS_DENIED"],
  [429, "HTTP_ERROR"],
  [503, "HTTP_ERROR"],
]) {
  let cancelled = false;
  await assert.rejects(
    fetchEvidencePage(pageUrl, {
      lookupImplementation: publicLookup,
      fetchImplementation: async () =>
        new globalThis.Response(
          new globalThis.ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { "content-type": "text/plain" } },
        ),
    }),
    (error) => evidencePageReadFailureReason(error) === reason,
  );
  assert.equal(cancelled, true, "Rejected HTTP bodies release resources");
}
await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response("%PDF", {
        headers: { "content-type": "application/pdf" },
      }),
  }),
  (error) => evidencePageReadFailureReason(error) === "UNSUPPORTED_CONTENT",
);
await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () => {
      throw new Error("Synthetic network failure");
    },
  }),
  (error) => evidencePageReadFailureReason(error) === "FETCH_FAILED",
);

for (const unsafe of [
  "not a URL",
  "file:///example",
  "http://user:pass@example.com",
  "http://localhost",
  "http://169.254.169.254",
  "http://[::ffff:127.0.0.1]",
]) {
  let called = false;
  await assert.rejects(
    fetchEvidencePage(unsafe, {
      lookupImplementation: publicLookup,
      fetchImplementation: async () => {
        called = true;
        throw new Error("Should not fetch");
      },
    }),
    (error) => evidencePageReadFailureReason(error) === "UNSAFE_URL",
  );
  assert.equal(called, false);
}
await assert.rejects(
  assertPublicEvidenceUrl(pageUrl, async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]),
  (error) => evidencePageReadFailureReason(error) === "UNSAFE_URL",
);

let redirects = 0;
await assert.rejects(
  fetchEvidencePage(pageUrl, {
    lookupImplementation: publicLookup,
    fetchImplementation: async () => {
      redirects += 1;
      return new globalThis.Response(null, {
        status: 302,
        headers: { location: "/next" },
      });
    },
  }),
  (error) => evidencePageReadFailureReason(error) === "HTTP_ERROR",
);
assert.equal(redirects, 4, "Redirect budget stays bounded");
const requestedUrls = [];
const redirected = await fetchEvidencePage(pageUrl, {
  lookupImplementation: publicLookup,
  fetchImplementation: async (url) => {
    requestedUrls.push(String(url));
    return requestedUrls.length === 1
      ? new globalThis.Response(null, {
          status: 302,
          headers: { location: "/table" },
        })
      : new globalThis.Response("COLUMN\tVALUE\r\nROW\t42\r\n", {
          headers: { "content-type": "text/plain" },
        });
  },
});
assert.equal(redirected.finalUrl, "https://example.com/table");
assert.equal(redirected.text, "COLUMN\tVALUE\nROW\t42");
assert.deepEqual(requestedUrls, [pageUrl, "https://example.com/table"]);

const timeoutController = new globalThis.AbortController();
const timeoutRead = fetchEvidencePage(pageUrl, {
  signal: timeoutController.signal,
  lookupImplementation: () =>
    new Promise(() => {
      /* Synthetic stalled DNS. */
    }),
  fetchImplementation: async () => {
    throw new Error("DNS has not completed");
  },
});
timeoutController.abort(
  new globalThis.DOMException("Synthetic timeout", "TimeoutError"),
);
await assert.rejects(
  timeoutRead,
  (error) => evidencePageReadFailureReason(error) === "TIMEOUT",
);
let bodyCancelled = false;
const bodyController = new globalThis.AbortController();
await assert.rejects(
  fetchEvidencePage(pageUrl, {
    signal: bodyController.signal,
    lookupImplementation: publicLookup,
    fetchImplementation: async () =>
      new globalThis.Response(
        new globalThis.ReadableStream({
          pull() {
            bodyController.abort();
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  }),
  (error) => evidencePageReadFailureReason(error) === "TIMEOUT",
);
assert.equal(bodyCancelled, true, "An aborted streaming read cancels the body");

const htmlTable = await fetchEvidencePage(pageUrl, {
  lookupImplementation: publicLookup,
  fetchImplementation: async () =>
    new globalThis.Response(
      "<html><script>INVISIBLE SCRIPT</script><style>INVISIBLE STYLE</style><table><tr><th>LABEL</th><th>VALUE</th></tr><tr><td>A</td><td>42</td></tr></table><p>Next<br>line</p></html>",
      { headers: { "content-type": "text/html" } },
    ),
});
assert.match(htmlTable.text, /LABEL VALUE\nA 42\n{1,2}Next\nline/u);
assert.doesNotMatch(htmlTable.text, /INVISIBLE/u);

// Multiple matching fragments remain separate exact slices, never invented quotations.
const discontinuousSource = `FIRST VALUE 42${" unrelated ".repeat(800)}SECOND VALUE 42`;
const fragments = selectEvidenceSourceText(discontinuousSource, "VALUE 42");
assert.equal(fragments.returnedFragments, 2);
assert.ok(fragments.text.includes("\n...\n"));
assert.equal(fragments.claimExcerptCandidates.length, 2);
for (const candidate of fragments.claimExcerptCandidates) {
  assert.ok(discontinuousSource.includes(candidate));
  assert.ok(candidate.length <= 600);
  assert.ok(!candidate.includes("\n...\n"));
}
const absent = selectEvidenceSourceText("A simple unrelated source", "needle");
assert.equal(absent.selectionMode, "NO_MATCH_PREFIX");
assert.deepEqual(absent.claimExcerptCandidates, []);
assert.deepEqual(selectEvidenceSourceText("", null).claimExcerptCandidates, []);

let successfulReads = 0;
const cachedSuccessTools = new DecisionResearchTools({
  prompts: prompts.research,
  evidencePageReader: async (url) => {
    successfulReads += 1;
    return { finalUrl: url, text: discontinuousSource };
  },
});
const cachedSuccess = cachedSuccessTools.createSession({
  ...DEFAULT_DECISION_LIMITS,
  maximumEvidenceSourceReadRequests: 2,
});
cachedSuccessTools.recordProviderEvidenceSources([
  {
    url: pageUrl,
    title: "Synthetic table",
    observedAt: "2026-01-02T00:00:00Z",
    provider: "CLIENT_WEB_SEARCH",
  },
]);
for (const find of ["FIRST VALUE", "SECOND VALUE"]) {
  const result = await cachedSuccess.execute(
    "read_evidence_source",
    { url: pageUrl, find },
    readSignal,
  );
  assert.equal(result.isError, false);
  const selection = JSON.parse(result.content);
  assert.ok(
    selection.claimExcerptCandidates.some((candidate) =>
      candidate.includes(find),
    ),
  );
}
assert.equal(
  successfulReads,
  1,
  "Different excerpt queries share one observed source snapshot",
);
