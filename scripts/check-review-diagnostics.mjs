import assert from "node:assert/strict";
import { log } from "node:console";
import { Decimal } from "decimal.js";
import {
  createReviewDiagnostics,
  deriveEvidenceReceipts,
} from "../src/reporting/review-diagnostics.ts";

// Wholly synthetic review data. No network, account, credentials or environment reads.
{
  const collector = createReviewDiagnostics();
  const event = {
    amount: new Decimal("1.25"),
    sequence: 3n,
    at: new Date("2040-01-01T00:00:00Z"),
    invalid: Number.NaN,
    error: new Error("synthetic failure"),
  };
  event.self = event;
  collector.append("execution-diagnostics", event);
  const snapshot = collector.snapshot("execution-diagnostics");
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.equal(snapshot.events[0].amount, "1.25");
  assert.equal(snapshot.events[0].sequence, "3");
  assert.equal(snapshot.events[0].at, "2040-01-01T00:00:00.000Z");
  assert.equal(snapshot.events[0].self, "[CIRCULAR]");
  assert.equal(snapshot.events[0].invalid, "[NON_FINITE_NUMBER]");
  assert.equal(snapshot.events[0].error.message, "synthetic failure");
  event.amount = new Decimal("99");
  snapshot.events[0].amount = "mutated copy";
  assert.equal(
    collector.snapshot("execution-diagnostics").events[0].amount,
    "1.25",
  );
}

{
  const secret = "synthetic-credential-value";
  const collector = createReviewDiagnostics({ secretValues: [secret] });
  collector.append("execution-diagnostics", {
    authorization: "synthetic-header-value",
    nested: { api_key: "synthetic-key-value", password: "synthetic-password" },
    environment: { ORDINARY_VARIABLE: "synthetic-env-payload" },
    encrypted_content: "synthetic-ciphertext",
    message: `known credential ${secret}; Bearer abcdefghijklmnop`,
    url: "https://name:password@example.test/resource?token=synthetic-query-value&item=1",
  });
  const serialized = JSON.stringify(
    collector.snapshot("execution-diagnostics"),
  );
  for (const forbidden of [
    secret,
    "synthetic-header-value",
    "synthetic-key-value",
    "synthetic-password",
    "synthetic-env-payload",
    "synthetic-ciphertext",
    "abcdefghijklmnop",
    "synthetic-query-value",
    "name:password",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(serialized.includes("item=1"));
}

{
  const collector = createReviewDiagnostics();
  let getterCalls = 0;
  const withAccessor = Object.defineProperty({}, "data", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
  });
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile object");
      },
    },
  );
  assert.doesNotThrow(() =>
    collector.append("history-attribution", withAccessor),
  );
  assert.doesNotThrow(() => collector.append("history-attribution", hostile));
  assert.equal(getterCalls, 0);
  assert.equal(
    collector.snapshot("history-attribution").sanitizationFailures,
    1,
  );
  assert.equal(
    collector.snapshot("history-attribution").events[0].data,
    "[ACCESSOR_OMITTED]",
  );
}

{
  const collector = createReviewDiagnostics({
    maximumEventsPerArtifact: 2,
    maximumStringCharacters: 12,
  });
  collector.append("history-attribution", { text: "x".repeat(200) });
  collector.append("history-attribution", {
    items: Array.from({ length: 100 }, (_, i) => i),
  });
  collector.append("history-attribution", { ignored: true });
  const snapshot = collector.snapshot("history-attribution");
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.omittedEvents, 1);
  assert.equal(snapshot.truncatedValues, 2);
  assert.ok(snapshot.events[0].text.endsWith("[TRUNCATED]"));
  assert.equal(snapshot.events[1].items.at(-1), "[TRUNCATED]");
  const small = createReviewDiagnostics({ maximumArtifactCharacters: 256 });
  for (let i = 0; i < 20; i += 1)
    small.append("history-attribution", { value: "y".repeat(200) });
  const compact = JSON.stringify(small.snapshot("history-attribution"));
  assert.ok(compact.length <= 256);
  assert.equal(small.snapshot("history-attribution").omittedEvents, 20);
}

{
  const collector = createReviewDiagnostics();
  collector.append("execution-diagnostics", { code: "SYNTHETIC" });
  const attempted = [];
  // A detached method and failing sink are also harmless; all categories run.
  const flush = collector.flush;
  await assert.doesNotReject(
    flush(async (kind) => {
      attempted.push(kind);
      throw new Error("synthetic disk failure");
    }),
  );
  assert.deepEqual(attempted, [
    "execution-diagnostics",
    "history-attribution",
    "evidence-receipts",
  ]);
  assert.equal(collector.snapshot("execution-diagnostics").events.length, 1);
}

const readRound = (content, extra = {}) => ({
  round: 3,
  toolCalls: [
    {
      callId: "read-1",
      name: "read_evidence_source",
      input: { url: "https://example.test/record" },
    },
  ],
  toolResults: [
    {
      callId: "read-1",
      name: "read_evidence_source",
      result: { kind: "TOOL_RESULT", content, isError: false },
    },
  ],
  response: { content: [] },
  ...extra,
});

{
  const transcript = readRound({
    ok: true,
    url: "https://example.test/record",
    finalUrl: "https://example.test/record?version=2",
    text: "Issued yesterday for location B. Current observations from entity A. Forecast result: 12.",
    retrieval: {
      fetchedAt: "2040-01-02T10:00:00Z",
      extractedTextSha256: "synthetic-digest",
    },
    sourceTimestamps: [],
  });
  const before = JSON.stringify(transcript);
  const [receipt] = deriveEvidenceReceipts({ data: { rounds: [transcript] } });
  assert.equal(receipt.kind, "READ_EVIDENCE_SOURCE");
  assert.equal(receipt.round, 3);
  assert.equal(receipt.callId, "read-1");
  assert.equal(receipt.textStatus, "READABLE");
  assert.equal(receipt.text, transcript.toolResults[0].result.content.text);
  assert.equal(receipt.structured.retrieval.fetchedAt, "2040-01-02T10:00:00Z");
  assert.equal(
    receipt.structured.sourceIssueTime,
    null,
    "no date inferred from prose or retrieval time",
  );
  assert.equal(receipt.structured.sourceValidPeriod, null);
  assert.equal(
    receipt.structured.location,
    null,
    "nearby source/entity names are not inferred",
  );
  assert.equal(
    receipt.structured.role,
    null,
    "no observation/forecast classification inferred",
  );
  assert.equal(
    JSON.stringify(transcript),
    before,
    "review does not change model data",
  );
}

{
  const [receipt] = deriveEvidenceReceipts(
    readRound({
      text: "Structured source result",
      sourceIssueTime: "2040-01-01T05:00:00Z",
      validPeriod: {
        start: "2040-01-02T00:00:00Z",
        end: "2040-01-03T00:00:00Z",
      },
      location: { entityId: "synthetic-entity-A" },
      role: "SOURCE_SUPPLIED_ROLE",
    }),
  );
  assert.equal(receipt.structured.sourceIssueTime, "2040-01-01T05:00:00Z");
  assert.equal(
    receipt.structured.sourceValidPeriod.start,
    "2040-01-02T00:00:00Z",
  );
  assert.equal(receipt.structured.location.entityId, "synthetic-entity-A");
  assert.equal(receipt.structured.role, "SOURCE_SUPPLIED_ROLE");
}

{
  const receipts = deriveEvidenceReceipts({
    rounds: [
      readRound(
        {},
        {
          response: {
            content: [
              {
                type: "web_search_tool_result",
                content: [
                  {
                    type: "web_search_result",
                    url: "https://example.test/opaque?lat=1",
                    title: "Entity A",
                    encrypted_content: "never-decode-this",
                    page_age: "2 days ago",
                  },
                  {
                    type: "web_search_result",
                    url: "https://example.test/readable",
                    snippet: "Readable source excerpt",
                    published_at: "2040-01-01T01:00:00Z",
                  },
                  {
                    type: "url_citation",
                    url: "https://example.test/citation",
                    title: "A URL alone",
                  },
                ],
              },
            ],
          },
        },
      ),
    ],
  });
  const provider = receipts.filter(
    (receipt) => receipt.kind === "PROVIDER_RESULT",
  );
  assert.equal(provider.length, 3);
  assert.equal(provider[0].textStatus, "OPAQUE");
  assert.equal(provider[0].text, null);
  assert.equal(provider[0].structured.location, null);
  assert.equal(provider[0].structured.sourceIssueTime, null);
  assert.equal(provider[1].textStatus, "READABLE");
  assert.equal(
    provider[1].structured.sourcePublicationTime,
    "2040-01-01T01:00:00Z",
  );
  assert.equal(provider[1].structured.sourceIssueTime, null);
  assert.equal(provider[2].textStatus, "UNKNOWN");
  assert.equal(JSON.stringify(receipts).includes("never-decode-this"), false);
}

{
  const [receipt] = deriveEvidenceReceipts(
    readRound({ ok: false, message: "Unavailable" }),
  );
  assert.equal(
    receipt.url,
    "https://example.test/record",
    "requested URL remains available when a read failed",
  );
  assert.equal(receipt.textStatus, "UNKNOWN");
  assert.equal(receipt.text, null);
  const oversized = deriveEvidenceReceipts({
    round: 1,
    response: Array.from({ length: 300 }, (_, i) => ({
      type: "web_search_result",
      url: `https://example.test/item/${i}`,
    })),
  });
  assert.ok(oversized.length <= 257);
  assert.equal(oversized.at(-1).kind, "RECEIPTS_TRUNCATED");
  assert.doesNotThrow(() =>
    deriveEvidenceReceipts(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("blocked");
          },
        },
      ),
    ),
  );
  assert.equal(
    deriveEvidenceReceipts(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("blocked");
          },
        },
      ),
    )[0].kind,
    "RECEIPTS_TRUNCATED",
  );
}

log("Review diagnostics checks passed.");
