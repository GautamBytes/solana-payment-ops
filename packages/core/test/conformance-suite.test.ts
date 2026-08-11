import { afterEach, describe, expect, it } from "vitest";
import { evaluateManifest } from "../src/index.js";
import {
  cleanupTemporaryDirectories,
  copyCanonicalFixture,
  fixtureDirectory,
  validCase,
  writeFixture,
  writeManifest,
} from "./support/manifest-test-kit.js";

afterEach(cleanupTemporaryDirectories);

describe("manifest conformance suite", () => {
  it("evaluates in manifest order with stable digests", async () => {
    const directory = await fixtureDirectory();
    const firstFixture = await copyCanonicalFixture(directory, "first.json");
    const secondFixture = await copyCanonicalFixture(directory, "second.json");
    const firstCase = validCase(firstFixture, "first");
    const secondCase = validCase(secondFixture, "second");
    const manifestPath = await writeManifest(directory, [
      firstCase,
      secondCase,
    ]);

    const first = await evaluateManifest(manifestPath);
    const second = await evaluateManifest(manifestPath);

    expect(first).toEqual(second);
    expect(first.passed).toBe(true);
    expect(first.cases.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(first.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.suiteDigest).toMatch(/^[0-9a-f]{64}$/);

    const reversedPath = await writeManifest(directory, [
      secondCase,
      firstCase,
    ]);
    const reversed = await evaluateManifest(reversedPath);
    expect(reversed.cases.map(({ id }) => id)).toEqual(["second", "first"]);
    expect(reversed.manifestDigest).not.toBe(first.manifestDigest);
    expect(reversed.suiteDigest).not.toBe(first.suiteDigest);
  });

  it("counts an expected parse rejection as a passing case", async () => {
    const directory = await fixtureDirectory();
    const fixture = await writeFixture(directory, "malformed.json", "{");
    const manifestPath = await writeManifest(directory, [
      {
        id: "malformed-envelope",
        file: fixture.file,
        sha256: fixture.sha256,
        kind: "schema_rejection",
        tags: ["malformed", "negative"],
        expected: {
          outcome: "parse_failure",
          eventCount: 0,
          verifiedCount: 0,
          eventIds: [],
          verificationCodes: [],
          exceptionCode: null,
          parseFailureCode: "invalid_fixture",
        },
      },
    ]);

    await expect(evaluateManifest(manifestPath)).resolves.toMatchObject({
      passed: true,
      cases: [
        {
          id: "malformed-envelope",
          passed: true,
          outcome: "parse_failure",
          errorCode: "invalid_fixture",
        },
      ],
    });
  });

  it("fails the suite on an expectation mismatch", async () => {
    const directory = await fixtureDirectory();
    const fixture = await copyCanonicalFixture(directory);
    const manifestPath = await writeManifest(directory, [
      {
        ...validCase(fixture),
        expected: {
          outcome: "verification_failure",
          eventCount: 1,
          verifiedCount: 0,
          eventIds: [
            "mainnet-beta:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T:0:outer",
          ],
          verificationCodes: ["amount"],
          exceptionCode: "partial_payment",
        },
      },
    ]);

    await expect(evaluateManifest(manifestPath)).resolves.toMatchObject({
      passed: false,
      cases: [{ passed: false, outcome: "pass" }],
    });
  });
});
