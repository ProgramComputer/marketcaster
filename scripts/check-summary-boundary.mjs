import assert from "node:assert/strict";
import { log } from "node:console";
import process from "node:process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJobSummary } from "../dist/src/reporting/job-summary.js";

const directory = await mkdtemp(join(tmpdir(), "summary-boundary-"));
const original = process.env.MARKETCASTER_SUMMARY_DETAIL;
try {
  delete process.env.MARKETCASTER_SUMMARY_DETAIL;
  const path = join(directory, "summary.md");
  // Default output must not inspect or serialize any report field.
  const report = new Proxy(
    {},
    {
      get() {
        throw new Error("Sensitive report accessed");
      },
    },
  );
  await appendJobSummary(report, path);
  const content = await readFile(path, "utf8");
  assert.match(content, /Application run/);
  assert.doesNotMatch(content, /account|balance|position|market slug|P&L|PnL/i);
  process.env.MARKETCASTER_SUMMARY_DETAIL = "invalid";
  await appendJobSummary(report, path);
  assert.equal(await readFile(path, "utf8"), content + content);
} finally {
  if (original === undefined) delete process.env.MARKETCASTER_SUMMARY_DETAIL;
  else process.env.MARKETCASTER_SUMMARY_DETAIL = original;
  await rm(directory, { recursive: true, force: true });
}
log(
  "Default job summary excludes report contents; unknown detail modes fail closed.",
);
