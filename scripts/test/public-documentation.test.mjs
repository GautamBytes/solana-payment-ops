import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const files = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "docs/open-core/security-model.md",
  "release/README.md",
];
const stale =
  /pending publication|does not make them available on npm|invitation-only alpha|until `v0\.1\.0` is published|does not yet advertise a dedicated private vulnerability intake/i;

test("public documentation describes the shipped project", () => {
  const failures = files.filter((file) =>
    stale.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(failures, []);
});
