import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCleanRepository,
  buildArguments,
  parseBuildRevision,
} from "../build-containers.mjs";

test("container build revision accepts only an immutable lowercase Git SHA", () => {
  const revision = "a".repeat(40);
  assert.equal(parseBuildRevision(revision), revision);
  for (const invalid of [
    "development",
    "A".repeat(40),
    "a".repeat(39),
    `${"a".repeat(40)}\n`,
    `sha-${"a".repeat(40)}`,
  ]) {
    assert.throws(() => parseBuildRevision(invalid), /invalid_build_revision/u);
  }
});

test("container builds reject any tracked, staged, or untracked source drift", () => {
  assert.doesNotThrow(() => assertCleanRepository(""));
  for (const dirty of [
    " M Dockerfile\n",
    "M  package.json\n",
    "?? local-secret.env\n",
  ]) {
    assert.throws(
      () => assertCleanRepository(dirty),
      /container_build_requires_clean_checkout/u,
    );
  }
});

test("every image target receives the same validated revision build argument", () => {
  const revision = "b".repeat(40);
  for (const target of [
    "payops-api",
    "payops-worker",
    "payops-web",
    "payops-migrate",
  ]) {
    assert.deepEqual(buildArguments(target, revision), [
      "buildx",
      "build",
      "--load",
      "--target",
      target,
      "--build-arg",
      `PAYOPS_BUILD_REVISION=${revision}`,
      "-t",
      `${target}:local`,
      ".",
    ]);
  }
});
