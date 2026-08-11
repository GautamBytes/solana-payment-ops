import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureManifestError, loadFixtureManifest } from "../src/index.js";
import {
  cleanupTemporaryDirectories,
  copyCanonicalFixture,
  fixtureDirectory,
  validCase,
  writeFixture,
  writeManifest,
} from "./support/manifest-test-kit.js";

afterEach(cleanupTemporaryDirectories);

describe("fixture manifest safety", () => {
  it("loads ordered cases after checking their exact bytes", async () => {
    const directory = await fixtureDirectory();
    const fixture = await copyCanonicalFixture(directory);
    const manifestPath = await writeManifest(directory, [validCase(fixture)]);

    const loaded = await loadFixtureManifest(manifestPath);

    expect(loaded.manifest.cases.map(({ id }) => id)).toEqual([
      "canonical-finalized-payment",
    ]);
    expect(loaded.cases[0]).toMatchObject({
      absolutePath: await realpath(join(directory, fixture.file)),
      digest: fixture.sha256,
    });
    expect(loaded.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      "duplicate IDs",
      (value: ReturnType<typeof validCase>) => [
        { ...value },
        { ...value, file: "second.json" },
      ],
    ],
    [
      "duplicate files",
      (value: ReturnType<typeof validCase>) => [
        { ...value },
        { ...value, id: "second" },
      ],
    ],
  ])("rejects %s", async (_name, cases) => {
    const directory = await fixtureDirectory();
    const fixture = await copyCanonicalFixture(directory);
    await copyCanonicalFixture(directory, "second.json");
    const manifestPath = await writeManifest(
      directory,
      cases(validCase(fixture)),
    );

    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
  });

  it("rejects lexical and symlink path escapes", async () => {
    const directory = await fixtureDirectory();
    const outside = await fixtureDirectory();
    const externalFixture = await copyCanonicalFixture(outside);
    const lexicalPath = await writeManifest(directory, [
      validCase({
        ...externalFixture,
        file: `../${outside.split("/").at(-1)}/${externalFixture.file}`,
      }),
    ]);
    await expect(loadFixtureManifest(lexicalPath)).rejects.toMatchObject({
      code: "unsafe_fixture_path",
    });

    const symlinkPath = join(directory, "linked.json");
    await symlink(join(outside, externalFixture.file), symlinkPath);
    const manifestPath = await writeManifest(directory, [
      validCase({ file: "linked.json", sha256: externalFixture.sha256 }),
    ]);
    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "unsafe_fixture_path",
    });
  });

  it("rejects aliases that resolve to the same fixture", async () => {
    const directory = await fixtureDirectory();
    const fixture = await copyCanonicalFixture(directory);
    await symlink(join(directory, fixture.file), join(directory, "alias.json"));
    const manifestPath = await writeManifest(directory, [
      validCase(fixture, "original"),
      validCase({ ...fixture, file: "alias.json" }, "alias"),
    ]);

    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
  });

  it("rejects a wrong digest before parsing fixture JSON", async () => {
    const directory = await fixtureDirectory();
    const fixture = await writeFixture(directory, "broken.json", "not-json");
    const manifestPath = await writeManifest(directory, [
      validCase({ ...fixture, sha256: "0".repeat(64) }),
    ]);

    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "fixture_digest_mismatch",
    });
  });

  it.each([
    ["unknown tag", { tags: ["surprise"] }],
    [
      "negative count",
      {
        expected: {
          outcome: "verification_failure",
          eventCount: -1,
          verifiedCount: 0,
          eventIds: [],
          verificationCodes: [],
          exceptionCode: null,
        },
      },
    ],
    [
      "verified count above parsed count",
      {
        expected: {
          outcome: "verification_failure",
          eventCount: 1,
          verifiedCount: 2,
          eventIds: ["event-001"],
          verificationCodes: [],
          exceptionCode: null,
        },
      },
    ],
  ])("rejects an invalid manifest with %s", async (_name, change) => {
    const directory = await fixtureDirectory();
    const fixture = await copyCanonicalFixture(directory);
    const manifestPath = await writeManifest(directory, [
      { ...validCase(fixture), ...change },
    ]);

    await expect(loadFixtureManifest(manifestPath)).rejects.toBeInstanceOf(
      FixtureManifestError,
    );
  });

  it("rejects a fixture larger than 2 MiB", async () => {
    const directory = await fixtureDirectory();
    const fixture = await writeFixture(
      directory,
      "oversized.json",
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    const manifestPath = await writeManifest(directory, [validCase(fixture)]);

    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "fixture_too_large",
    });
  });

  it("fails closed on an oversized manifest", async () => {
    const directory = await fixtureDirectory();
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, Buffer.alloc(2 * 1024 * 1024 + 1));

    await expect(loadFixtureManifest(manifestPath)).rejects.toMatchObject({
      code: "invalid_manifest",
    });
  });
});
