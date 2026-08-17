import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
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
const walkthroughImages = [
  "home.png",
  "sample-workspace.png",
  "public-wallet.png",
  "checkout.png",
  "operations.png",
  "evidence.png",
  "developer-docs.png",
  "roadmap.png",
].map((name) => `docs/assets/project-walkthrough/${name}`);

test("public documentation describes the shipped project", () => {
  const failures = files.filter((file) =>
    stale.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(failures, []);
});

test("publishes a bounded, linked walkthrough image set", () => {
  const walkthrough = readFileSync("docs/project-walkthrough.md", "utf8");
  let totalBytes = 0;
  for (const file of walkthroughImages) {
    const size = statSync(file).size;
    totalBytes += size;
    assert.ok(size <= 750 * 1024, `${file} exceeds 750 KiB`);
    assert.match(walkthrough, new RegExp(file.split("/").at(-1)));
  }
  assert.ok(totalBytes <= 5 * 1024 * 1024, "walkthrough exceeds 5 MiB");
});
