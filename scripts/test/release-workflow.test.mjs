import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const rootManifest = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("release workflow policy", () => {
  it("runs only for version tags with least privilege", () => {
    assert.match(
      workflow,
      /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ["']v\*["']/u,
    );
    assert.doesNotMatch(
      workflow,
      /\b(?:branches|pull_request|workflow_dispatch):/u,
    );
    const permissions = workflow.match(
      /permissions:\n((?: {2}\S[^\n]*\n)+)/u,
    )?.[1];
    assert.equal(
      permissions?.trim(),
      "contents: write\n  id-token: write",
      "release permissions must be exact",
    );
  });

  it("serializes protected publication without cancellation", () => {
    assert.match(
      workflow,
      /concurrency:\s*\n\s+group: npm-release\s*\n\s+cancel-in-progress: false/u,
    );
    assert.match(workflow, /environment: npm-release/u);
  });

  it("pins actions, PostgreSQL, and disables checkout credentials", () => {
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map(
      ([, value]) => value,
    );
    assert.ok(actionUses.length >= 3);
    for (const action of actionUses) {
      assert.match(action, /@[a-f0-9]{40}$/u);
    }
    assert.match(workflow, /postgres:16-alpine@sha256:[a-f0-9]{64}/u);
    assert.match(workflow, /persist-credentials: false/u);
  });

  it("installs safely before running one complete release gate", () => {
    const install = workflow.indexOf(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    const releaseGate = workflow.indexOf("pnpm release:verify");
    const tagGate = workflow.indexOf("scripts/verify-release-tag.mjs");
    const evidence = workflow.indexOf("scripts/build-release-evidence.mjs");
    const publish = workflow.indexOf("scripts/publish-release.mjs");
    const githubRelease = workflow.indexOf("gh release create");
    assert.equal(
      workflow.indexOf("- run:"),
      workflow.indexOf(
        "- run: pnpm install --frozen-lockfile --ignore-scripts",
      ),
      "dependency installation must precede repository commands",
    );
    assert.ok(install >= 0 && install < releaseGate);
    assert.ok(
      releaseGate < tagGate &&
        tagGate < evidence &&
        evidence < publish &&
        publish < githubRelease,
      "release gates and mutations must remain ordered",
    );
  });

  it("scopes registry and GitHub credentials to required steps", () => {
    assert.doesNotMatch(workflow, /^\s{4}NODE_AUTH_TOKEN:/mu);
    assert.doesNotMatch(workflow, /^\s{4}NPM_TOKEN:/mu);
    assert.equal(
      [
        ...workflow.matchAll(
          /NODE_AUTH_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/gu,
        ),
      ].length,
      2,
    );
    assert.equal(
      [...workflow.matchAll(/GH_TOKEN:\s*\$\{\{ github\.token \}\}/gu)].length,
      1,
    );
  });
});

describe("release verification command", () => {
  it("contains every pre-publication gate in order", () => {
    assert.equal(
      rootManifest.scripts["release:verify"],
      "pnpm check && pnpm schemas:check && pnpm openapi:check && pnpm conformance fixtures/v0.1/manifest.json && pnpm packages:verify && pnpm audit --prod",
    );
  });
});
