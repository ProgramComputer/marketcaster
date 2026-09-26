// check-evidence-adapter.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { log } = await import("node:console");
  const { createHash } = await import("node:crypto");
  const { fetchEvidencePage } =
    await import("../dist/src/agent/evidence-provenance.js");
  const { assertStrategyPolicy, referenceStrategy } =
    await import("../dist/src/strategy/policy.js");
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
})();

// check-evidence-reading.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const {
    assertPublicEvidenceUrl,
    EvidencePageReadError,
    evidencePageReadFailureReason,
    fetchEvidencePage,
    isPublicIpAddress,
    validateDecisionEvidence,
  } = await import("../dist/src/agent/evidence-provenance.js");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DEFAULT_DECISION_LIMITS } =
    await import("../dist/src/llm/decision-provider.js");
  const { DecisionResearchTools, selectEvidenceSourceText } =
    await import("../dist/src/llm/research-tools.js");
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
    maximumEvidenceSourceReadRequests: 1,
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

  const repeatedFailedRead = await researchSession.execute(
    "read_evidence_source",
    readInput,
    readSignal,
  );
  assert.deepEqual(repeatedFailedRead, firstFailedRead);
  assert.equal(researchSession.counts.evidenceSourceReads, 1);
  const secondSourceUrl = "https://example.com/another-source";
  researchTools.recordProviderEvidenceSources([
    {
      url: secondSourceUrl,
      title: "Another synthetic source",
      observedAt: "2026-09-04T12:00:00.000Z",
      provider: "CLIENT_WEB_SEARCH",
    },
  ]);
  const exhaustedRead = await researchSession.execute(
    "read_evidence_source",
    { url: secondSourceUrl },
    readSignal,
  );
  assert.equal(exhaustedRead.errorCode, "EVIDENCE_SOURCE_READ_LIMIT_REACHED");
  assert.equal(
    cachedFailureReadCount,
    1,
    "Cached failures never retry the network or grant another fetch",
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
  assert.equal(
    bodyCancelled,
    true,
    "An aborted streaming read cancels the body",
  );

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
  const absent = selectEvidenceSourceText(
    "A simple unrelated source",
    "needle",
  );
  assert.equal(absent.selectionMode, "NO_MATCH_PREFIX");
  assert.deepEqual(absent.claimExcerptCandidates, [
    "A simple unrelated source",
  ]);
  assert.equal(
    absent.matchCount,
    0,
    "A useful prefix does not claim a query match",
  );
  const prefixTable = `${"Synthetic introduction. ".repeat(50)}TABLE ROW VALUE 43.5`;
  const unmatchedTable = selectEvidenceSourceText(prefixTable, "absent query");
  assert.ok(
    unmatchedTable.claimExcerptCandidates.some((candidate) =>
      candidate.includes("TABLE ROW VALUE 43.5"),
    ),
    "No-match candidates include later source rows instead of only the page introduction",
  );
  assert.ok(
    unmatchedTable.claimExcerptCandidates.every(
      (candidate) => prefixTable.includes(candidate) && candidate.length <= 600,
    ),
  );
  const boundaryRows = `HEADER\n${"row 17 value 42\n".repeat(20)}`;
  const boundarySource = `${"x".repeat(450)}${boundaryRows}${"x".repeat(450)}`;
  assert.ok(
    selectEvidenceSourceText(
      boundarySource,
      "absent query",
    ).claimExcerptCandidates.some((candidate) =>
      candidate.includes(boundaryRows),
    ),
    "Overlapping candidates preserve a table section crossing a candidate boundary",
  );
  const longPrefix = `${"Synthetic introduction. ".repeat(200)}${boundaryRows}`;
  const cappedPrefixSelection = selectEvidenceSourceText(
    longPrefix,
    "absent query",
  );
  assert.equal(cappedPrefixSelection.text, longPrefix.slice(0, 4_000));
  assert.ok(
    cappedPrefixSelection.claimExcerptCandidates.length <= 8,
    "No-match candidate duplication stays bounded while the full source prefix remains readable",
  );
  assert.deepEqual(
    selectEvidenceSourceText("", null).claimExcerptCandidates,
    [],
  );

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
    maximumEvidenceSourceReadRequests: 1,
  });
  cachedSuccessTools.recordProviderEvidenceSources([
    {
      url: pageUrl,
      title: "Synthetic table",
      observedAt: "2026-01-02T00:00:00Z",
      provider: "CLIENT_WEB_SEARCH",
    },
  ]);
  for (const [index, find] of [
    "FIRST VALUE",
    "SECOND VALUE",
    "FIRST VALUE",
  ].entries()) {
    const result = await cachedSuccess.execute(
      "read_evidence_source",
      { url: pageUrl, find },
      readSignal,
    );
    assert.equal(result.isError, false);
    const selection = JSON.parse(result.content);
    assert.equal(selection.reusedSnapshot, index > 0);
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
  assert.equal(cachedSuccess.counts.evidenceSourceReads, 1);
  assert.equal(cachedSuccess.counts.successfulEvidenceSourceReads, 1);
  assert.equal(cachedSuccessTools.evidencePageSnapshots.size, 1);

  // No-match live feeds cannot pass off an unrelated prefix as a matching record.
  const absentFeedTools = new DecisionResearchTools({
    prompts: prompts.research,
    evidencePageReader: async (url) => ({
      finalUrl: url,
      text: "Unrelated record",
    }),
  });
  const absentFeedSession = absentFeedTools.createSession(
    DEFAULT_DECISION_LIMITS,
  );
  absentFeedTools.recordProviderEvidenceSources([
    {
      url: pageUrl,
      title: "Synthetic live feed",
      observedAt: "2026-01-02T00:00:00Z",
      provider: "SYSTEM_LIVE_FEED",
    },
  ]);
  const absentFeed = JSON.parse(
    (
      await absentFeedSession.execute(
        "read_evidence_source",
        { url: pageUrl, find: "absent event" },
        readSignal,
      )
    ).content,
  );
  assert.equal(absentFeed.selectionMode, "NO_MATCH_PREFIX");
  assert.deepEqual(absentFeed.claimExcerptCandidates, []);
  assert.match(absentFeed.text, /No matching live-score record/u);

  // Reproduce incomplete table claims offline. Repairs offer exact source spans;
  // they do not weaken numeric, excerpt, event-year, or timestamp validation.
  const tableSnapshot =
    "DATE HOUR READING 6-hour maximum\n02 10:00 43.5 43.5\n02 11:00 42 43.5";
  const observation = {
    url: pageUrl,
    title: "Synthetic sensor observations",
    excerpt: "02 11:00 42 43.5",
    observedAt: "2026-01-02T12:00:00Z",
    provider: "CLIENT_WEB_SEARCH",
  };
  const tableEvidence = {
    title: observation.title,
    url: pageUrl,
    evidenceClass: "LIVE_DATA",
    claimEventYear: 2026,
    asOf: observation.observedAt,
    claimExcerpt: "02 10:00 43.5 43.5",
    relevance: "The 6-hour maximum was 43.5; the later reading was 42.",
  };
  const syntheticTarget = {
    marketSlug: "synthetic-sensor-2026",
    estimatedProbability: "0.71",
    thesis:
      "My inferred probability is 71%; the source reports observations, not this forecast.",
    evidence: [tableEvidence],
  };
  const validateTable = (evidence, overrides = {}) =>
    validateDecisionEvidence({
      decision: {
        portfolioTargets: [{ ...syntheticTarget, evidence: [evidence] }],
        candidateDispositions: [],
      },
      observedSources: [observation],
      marketsBySlug: new Map([
        [
          syntheticTarget.marketSlug,
          {
            slug: syntheticTarget.marketSlug,
            title: "Synthetic sensor 2026",
            description: "A synthetic threshold contract",
            settlementRules: "The final reading determines settlement.",
            closesAt: new Date("2026-01-03T00:00:00Z"),
          },
        ],
      ]),
      minimumIndependentSources: 1,
      now: new Date(observation.observedAt),
      evidencePageSnapshots: new Map([
        [pageUrl, Promise.resolve({ finalUrl: pageUrl, text: tableSnapshot })],
      ]),
      fetchImplementation: async () => {
        throw new Error("Validation must reuse the captured source");
      },
      ...overrides,
    });
  const incompleteTable = await validateTable(tableEvidence);
  assert.equal(incompleteTable.valid, false);
  const numericIssue = incompleteTable.issues.find(
    (issue) => issue.code === "CLAIM_NUMERIC_DETAIL_UNSUPPORTED",
  );
  assert.deepEqual(numericIssue.unsupportedNumericDetails, ["6", "42"]);
  assert.equal(numericIssue.repairContext.sourceKind, "PAGE_SNAPSHOT");
  assert.ok(
    !incompleteTable.issues.some(
      (issue) => issue.code === "SOURCE_FETCH_FAILED",
    ),
  );
  for (const candidate of numericIssue.repairContext.claimExcerptCandidates) {
    assert.ok(tableSnapshot.includes(candidate));
    assert.ok(candidate.length <= 600);
  }
  const correctedTable = {
    ...tableEvidence,
    claimExcerpt: numericIssue.repairContext.claimExcerptCandidates[0],
  };
  assert.equal((await validateTable(correctedTable)).valid, true);
  assert.equal(
    (
      await validateTable({
        ...correctedTable,
        claimExcerpt: "Invented reading 999",
      })
    ).valid,
    false,
  );
  assert.equal(
    (
      await validateTable({
        ...correctedTable,
        relevance: "The reading was 999.",
      })
    ).valid,
    false,
  );
  assert.equal(
    (await validateTable({ ...correctedTable, claimEventYear: 2025 })).valid,
    false,
  );
  assert.equal(
    (await validateTable({ ...correctedTable, asOf: "2025-01-02T12:00:00Z" }))
      .valid,
    false,
  );
  assert.equal(
    (
      await validateTable({
        ...correctedTable,
        relevance: "The source estimates 71%.",
      })
    ).valid,
    false,
    "The model's inferred probability belongs in its thesis, not the cited facts",
  );
  const unavailableTable = await validateTable(tableEvidence, {
    evidencePageSnapshots: new Map([
      [
        pageUrl,
        Promise.reject(
          new EvidencePageReadError("TIMEOUT", "Synthetic timeout"),
        ),
      ],
    ]),
  });
  assert.equal(
    unavailableTable.issues.find(
      (issue) => issue.code === "SOURCE_FETCH_FAILED",
    ).sourceFetchFailureReason,
    "TIMEOUT",
  );

  // A new cycle cannot reuse or expose an earlier cycle's pages.
  cachedSuccessTools.createSession(DEFAULT_DECISION_LIMITS);
  assert.equal(cachedSuccessTools.evidencePageSnapshots.size, 0);
})();

// check-source-provenance.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { createHash } = await import("node:crypto");
  const { Decimal } = await import("decimal.js");
  const { buildMarketDetailContext } =
    await import("../dist/src/agent/context-builder.js");
  const { fetchEvidencePage } =
    await import("../dist/src/agent/evidence-provenance.js");
  const { MarketFamilyResolver } =
    await import("../dist/src/agent/market-family-resolver.js");
  const { loadPromptBundle } = await import("../dist/src/config/prompts.js");
  const { DEFAULT_DECISION_LIMITS } =
    await import("../dist/src/llm/decision-provider.js");
  const { DecisionResearchTools, selectEvidenceSourceText } =
    await import("../dist/src/llm/research-tools.js");
  const { PolymarketMarketSchema } =
    await import("../dist/src/exchanges/polymarket-us/schemas.js");
  const { mapMarket: mapPolymarketMarket } =
    await import("../dist/src/exchanges/polymarket-us/mappers.js");
  const { KalshiMarketSchema } =
    await import("../dist/src/exchanges/kalshi/schemas.js");
  const { mapMarket: mapKalshiMarket } =
    await import("../dist/src/exchanges/kalshi/mappers.js");
  // Wholly synthetic responses; these checks never connect to a source or exchange.
  const url = "https://example.com/synthetic-source";
  const published = "2040-01-01T05:00:00Z";
  const modified = "2040-01-01T06:00:00Z";
  const source = `<meta content="${published}" property="article:published_time">
<script type="application/ld+json">{"dateModified":"${modified}"}</script>
<time datetime="2040-01-02T08:00:00Z">An event time, not publication</time>
<time datetime="2040-01-02T09:00:00">A time with no zone</time>
<pre>Item | Value | Unit\nalpha | 12 | widgets\nbeta | 17 | widgets</pre>`;
  const options = (body) => ({
    lookupImplementation: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImplementation: async () =>
      new globalThis.Response(body, {
        headers: {
          "content-type": "text/html",
          "last-modified": "Sun, 01 Jan 2040 06:30:00 GMT",
        },
      }),
  });
  const page = await fetchEvidencePage(url, options(source));
  assert.equal(page.publishedAt, "2040-01-01T05:00:00.000Z");
  assert.equal(
    page.sourceTimestamps.find((entry) => entry.role === "MODIFICATION")
      .timestamp,
    "2040-01-01T06:00:00.000Z",
  );
  assert.equal(
    page.sourceTimestamps.find(
      (entry) => entry.rawValue === "2040-01-02T09:00:00",
    ).timestamp,
    undefined,
  );
  assert.equal(
    page.sourceTimestamps.find((entry) => entry.field === "time.datetime").role,
    "UNSPECIFIED",
  );
  assert.ok(
    Date.parse(page.retrieval.fetchedAt) >=
      Date.parse(page.retrieval.fetchStartedAt),
  );
  assert.equal(page.retrieval.requestedUrl, url);
  assert.equal(
    page.retrieval.decodedBodySha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(
    page.retrieval.extractedTextSha256,
    createHash("sha256").update(page.text).digest("hex"),
  );
  const generic = await fetchEvidencePage(
    url,
    options('<time datetime="2040-01-02T08:00:00Z">Event</time>'),
  );
  assert.equal(
    generic.publishedAt,
    undefined,
    "A generic time element cannot authorize a publication-date claim",
  );
  assert.notEqual(
    generic.retrieval.fetchId,
    page.retrieval.fetchId,
    "Separate fetches have distinct identities, even at the same URL",
  );

  const prompts = await loadPromptBundle();
  let reads = 0;
  const tools = new DecisionResearchTools({
    prompts: prompts.research,
    evidencePageReader: async () => {
      reads += 1;
      return page;
    },
  });
  const session = tools.createSession({
    ...DEFAULT_DECISION_LIMITS,
    maximumEvidenceSourceReadRequests: 1,
  });
  const discoveredAt = "2039-12-31T00:00:00Z";
  tools.recordProviderEvidenceSources([
    {
      url,
      title: "Synthetic source",
      observedAt: discoveredAt,
      provider: "CLIENT_WEB_SEARCH",
    },
  ]);
  for (const [index, find] of ["alpha", "beta"].entries()) {
    const result = await session.execute(
      "read_evidence_source",
      { url, find },
      new globalThis.AbortController().signal,
    );
    assert.equal(result.isError, false);
    const content = JSON.parse(result.content);
    assert.equal(content.discoveredAt, "2039-12-31T00:00:00.000Z");
    assert.deepEqual(
      content.retrieval,
      page.retrieval,
      "Cached selection retains the original fetch identity and time",
    );
    assert.deepEqual(content.sourceTimestamps, page.sourceTimestamps);
    assert.equal(content.reusedSnapshot, index > 0);
  }
  assert.equal(reads, 1);
  assert.deepEqual(tools.observedEvidenceSources[0].retrieval, page.retrieval);

  const longSource = `HEADER | UNITS\n${"Unrelated context\n".repeat(1200)}needle | 31 | items${"\nFooter context".repeat(1200)}`;
  const selection = selectEvidenceSourceText(longSource, "needle");
  assert.equal(selection.textCoverage, "PARTIAL_EXTRACTED_TEXT");
  assert.ok(
    selection.textRanges[0].start > 0,
    "A query excerpt must not imply coverage of the header",
  );
  assert.equal(
    selection.text,
    selection.textRanges
      .map(({ start, end }) => longSource.slice(start, end))
      .join("\n...\n"),
  );
  assert.equal(
    selectEvidenceSourceText("small source", null).textCoverage,
    "FULL_EXTRACTED_TEXT",
  );

  const rawMarket = {
    id: "101",
    slug: "synthetic-item-a",
    title: "Synthetic item A",
    description: "Description fallback.",
    active: true,
    closed: false,
    archived: false,
    priceTick: "0.01",
    minimumTradeQuantity: "1",
  };
  const map = (extra = {}) =>
    mapPolymarketMarket(
      PolymarketMarketSchema.parse({ ...rawMarket, ...extra }),
    );
  const fallback = map();
  assert.deepEqual(fallback.settlementRulesProvenance, {
    sourceFields: ["description"],
    origin: "DESCRIPTION_FALLBACK",
    completeness: "UNKNOWN",
  });
  const disclaimer = map({ rulesDisclaimer: "Auxiliary disclaimer." });
  assert.equal(
    disclaimer.settlementRulesProvenance.origin,
    "DISCLAIMER_FALLBACK",
  );
  const explicit = map({
    settlementRules: "Primary rule.",
    resolutionRules: "Other rule.",
  });
  assert.equal(explicit.settlementRules, "Primary rule.");
  assert.deepEqual(explicit.settlementRulesProvenance.sourceFields, [
    "settlementRules",
  ]);
  assert.equal(explicit.settlementRulesProvenance.completeness, "UNKNOWN");
  const detail = buildMarketDetailContext({
    market: fallback,
    held: false,
    account: { positions: [] },
  });
  assert.deepEqual(
    detail.settlementRulesProvenance,
    fallback.settlementRulesProvenance,
  );
  const detailTools = new DecisionResearchTools({
    prompts: prompts.research,
    marketDetailsHandler: async () => detail,
  });
  const detailSession = detailTools.createSession(DEFAULT_DECISION_LIMITS);
  const detailResult = await detailSession.execute(
    "get_market_details",
    { marketSlug: fallback.slug },
    new globalThis.AbortController().signal,
  );
  assert.equal(detailResult.isError, false);
  assert.deepEqual(
    JSON.parse(detailResult.content).market.settlementRulesProvenance,
    fallback.settlementRulesProvenance,
    "Rule origin survives the adapter, context builder and strict tool-result schema",
  );
  const kalshi = mapKalshiMarket(
    KalshiMarketSchema.parse({
      ticker: "SYNTHETIC-A",
      event_ticker: "SYNTHETIC",
      market_type: "binary",
      status: "open",
      rules_primary: "Primary rule.",
      rules_secondary: "Secondary rule.",
      early_close_condition: "Auxiliary condition.",
    }),
  );
  assert.deepEqual(kalshi.settlementRulesProvenance.sourceFields, [
    "rules_primary",
    "rules_secondary",
    "early_close_condition",
  ]);

  const catalog = (markets) => ({
    markets,
    bySlug: new Map(markets.map((market) => [market.slug, market])),
    heldSlugs: new Set(),
  });
  const exchange = (markets, group) => ({
    getMarketBySlug: async (slug) => {
      const market = markets.find((item) => item.slug === slug);
      if (market === undefined) throw new Error("Synthetic missing member");
      return market;
    },
    getBbo: async () => {
      throw new Error("Synthetic unavailable quote");
    },
    ...(group === undefined ? {} : { listMarketGroupMembers: group }),
  });
  const seedOnly = await new MarketFamilyResolver(
    exchange([fallback]),
    catalog([fallback]),
  ).resolve(fallback);
  assert.equal(seedOnly.family.source, "MARKET_SLUG");
  assert.equal(
    seedOnly.membershipCompleteness,
    "UNKNOWN",
    "Seed-only fallback does not establish independent-event coverage",
  );
  const seed = map({ eventId: "synthetic-event" });
  const member = map({
    id: "102",
    slug: "synthetic-item-b",
    eventId: "synthetic-event",
  });
  const complete = await new MarketFamilyResolver(
    exchange([seed, member], async () => ({
      items: [seed.slug, member.slug],
      eof: true,
    })),
    catalog([seed]),
  ).resolve(seed);
  assert.equal(complete.membershipCompleteness, "EXCHANGE_GROUP_ENUMERATED");
  const partial = await new MarketFamilyResolver(
    exchange([seed], async () => ({
      items: [seed.slug, member.slug],
      eof: true,
    })),
    catalog([seed]),
  ).resolve(seed);
  assert.equal(
    partial.membershipCompleteness,
    "PARTIAL",
    "A failed detail read makes membership coverage partial despite EOF",
  );
  const cursorMissing = await new MarketFamilyResolver(
    exchange([seed], async () => ({ items: [seed.slug], eof: false })),
    catalog([seed]),
  ).resolve(seed);
  assert.equal(cursorMissing.membershipCompleteness, "PARTIAL");

  const groupingMarkets = [
    seed,
    member,
    map({
      id: "103",
      slug: "synthetic-series-member",
      seriesId: "synthetic-series",
    }),
    map({ id: "106", slug: "synthetic-fallback-a" }),
    map({ id: "104", slug: "synthetic-fallback-b" }),
    map({
      id: "105",
      slug: "synthetic-alias-member",
      eventId: "synthetic-event",
    }),
  ];
  const groupingTools = new DecisionResearchTools({
    prompts: prompts.research,
    candidateFamilies: groupingMarkets.map((market) => ({
      marketSlug: market.slug,
      eventId: market.eventId,
      seriesId: market.seriesId,
    })),
    researchFamilyAliases: new Map([
      ["synthetic-alias-member", "scout:synthetic-alias"],
    ]),
    marketDetailsHandler: async (slug) =>
      buildMarketDetailContext({
        market: groupingMarkets.find((market) => market.slug === slug),
        held: false,
        account: { positions: [] },
      }),
    passResearchRequirements: {
      minimumDiscoveryRequests: 0,
      minimumDistinctDiscoveryModes: 0,
      minimumInspectedMarkets: 0,
      minimumDistinctEventFamilies: 5,
      minimumWebSearches: 0,
      minimumMarketAnalyses: 0,
      minimumTradePreviews: 0,
      maximumQualifiedSpread: new Decimal("0.1"),
    },
  });
  const groupingSession = groupingTools.createSession(DEFAULT_DECISION_LIMITS);
  assert.equal(groupingTools.strictPassResearchReadiness.allowed, false);
  for (const market of groupingMarkets) {
    const result = await groupingSession.execute(
      "get_market_details",
      { marketSlug: market.slug },
      new globalThis.AbortController().signal,
    );
    assert.equal(result.isError, false);
  }
  const readiness = groupingTools.strictPassResearchReadiness;
  assert.equal(
    readiness.allowed,
    true,
    "The configured legacy research gate is unchanged",
  );
  assert.equal(readiness.requiredDistinctEventFamilies, 5);
  assert.equal(readiness.inspectedDistinctEventFamilies, 5);
  assert.equal(readiness.groupingDiagnostics.nativeEventGroups, 1);
  assert.equal(readiness.groupingDiagnostics.nativeSeriesGroups, 1);
  assert.equal(readiness.groupingDiagnostics.marketFallbackGroups, 2);
  assert.equal(readiness.groupingDiagnostics.advisoryAliasGroups, 1);
  assert.equal(readiness.groupingDiagnostics.inspectedMarkets.length, 6);
  assert.equal(
    readiness.groupingDiagnostics.legacyGateCountBasis,
    "RESEARCH_GROUP_KEYS_NOT_INDEPENDENT_EVENTS",
  );
  globalThis.console.log(
    "Synthetic source, settlement-rule and native-family provenance checks passed",
  );
})();

// check-input-provenance.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { createHash } = await import("node:crypto");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join, resolve } = await import("node:path");
  const { default: process } = await import("node:process");
  const { loadPromptBundle } = await import("../src/config/prompts.ts");
  const { loadRepositoryConfig } = await import("../src/config/schema.ts");
  const { referenceStrategy } = await import("../src/strategy/policy.ts");
  const { AnthropicDecisionProvider } =
    await import("../src/llm/anthropic-provider.ts");
  const { OpenAIDecisionProvider } =
    await import("../src/llm/openai-provider.ts");
  const { DecisionResearchTools } =
    await import("../src/llm/research-tools.ts");
  const {
    provenanceIdentityFromEnvironment,
    redactedProvenanceSnapshot,
    renderedInputProvenance,
    runtimeInputProvenance,
  } = await import("../src/reporting/decision-input-provenance.ts");
  const { createRunJournal, decisionRequestRoundArtifactKind } =
    await import("../src/reporting/run-journal.ts");
  const { checkCycleForecastMemory } = await import("./check-memory-cycle.mjs");
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
          researchTools: new DecisionResearchTools({
            prompts: prompts.research,
          }),
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
          researchTools: new DecisionResearchTools({
            prompts: prompts.research,
          }),
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
            join(
              invalidJournal.runDirectory,
              "decision-request.round-0001.json",
            ),
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
})();
