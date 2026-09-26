// check-summary-boundary.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { log } = await import("node:console");
  const { default: process } = await import("node:process");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { appendJobSummary } =
    await import("../dist/src/reporting/job-summary.js");
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
    assert.doesNotMatch(
      content,
      /account|balance|position|market slug|P&L|PnL/i,
    );
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
})();

// check-distribution-boundary.mjs
await (async () => {
  const { default: assert } = await import("node:assert/strict");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { default: process } = await import("node:process");
  const { URL } = await import("node:url");
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const excluded =
    /^(?:reports|state|logs|node_modules|dist)\/|(?:^|\/)\.env$|\.(?:pem|key|bundle)$/u;
  assert.deepEqual(
    tracked.filter((path) => excluded.test(path)),
    [],
  );
  assert.deepEqual(
    tracked.filter(
      (path) =>
        path.startsWith(".github/workflows/") ||
        /^\.github\/dependabot\.ya?ml$/u.test(path),
    ),
    [],
  );
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const check of ["format:check", "lint", "typecheck", "build", "test"]) {
    assert.equal(
      typeof scripts[check],
      "string",
      `Missing local check: ${check}`,
    );
  }
  for (const file of ["check-boundaries.mjs", "check-policy.mjs"])
    assert(scripts.test.includes(`scripts/${file}`), `npm test omits ${file}`);
  process.stdout.write(
    "Distribution and local validation boundaries passed.\n",
  );
})();
