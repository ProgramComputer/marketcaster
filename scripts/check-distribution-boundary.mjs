import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

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
for (const check of [
  "format:check",
  "lint",
  "typecheck",
  "build",
  "check:policy",
  "check:summary",
  "check:distribution",
]) {
  assert.equal(
    typeof scripts[check],
    "string",
    `Missing local check: ${check}`,
  );
}
process.stdout.write("Distribution and local validation boundaries passed.\n");
