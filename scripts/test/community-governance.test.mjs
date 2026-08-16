import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requiredFiles = [
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/question.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
];

async function read(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("repository publishes complete community governance surfaces", async () => {
  const entries = await Promise.all(
    requiredFiles.map(async (path) => [path, await read(path)]),
  );

  for (const [path, contents] of entries) {
    assert.ok(contents.trim().length > 0, `${path} must not be empty`);
  }
});

test("public support paths separate questions, bugs, features, and security", async () => {
  const support = await read("SUPPORT.md");
  const config = await read(".github/ISSUE_TEMPLATE/config.yml");

  assert.match(support, /question\.yml/);
  assert.match(support, /bug\.yml/);
  assert.match(support, /feature\.yml/);
  assert.match(support, /SECURITY\.md/);
  assert.match(config, /blank_issues_enabled: false/);
  assert.match(config, /security\/advisories\/new/);
});

test("contribution path names the required review evidence", async () => {
  const contributing = await read("CONTRIBUTING.md");
  const pullRequestTemplate = await read(".github/pull_request_template.md");

  assert.match(contributing, /issue form/i);
  assert.match(contributing, /CODE_OF_CONDUCT\.md/);
  assert.match(pullRequestTemplate, /User impact/);
  assert.match(pullRequestTemplate, /Security implications/);
  assert.match(pullRequestTemplate, /Migration implications/);
  assert.match(pullRequestTemplate, /Verification/);
});
