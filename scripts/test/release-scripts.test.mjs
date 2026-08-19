import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildSpdxDocument,
  classifyPublishedVersion,
  environmentWithoutNpmCredentials,
  loadReleaseManifest,
  parseReleaseManifest,
  preflightReleasePublication,
  verifyReleaseGitState,
  verifyFixtureDigests,
  verifyPublicPackageMetadata,
  verifyReleasePackageManifest,
} from "../release-lib.mjs";

let directory;

const firstPublicPackages = [
  ["@payops/contracts", "0.1.0", "packages/contracts"],
  ["@payops/core", "0.1.0", "packages/core"],
  ["@payops/ingestion", "0.1.0", "packages/ingestion"],
  ["@payops/webhooks", "0.1.0", "packages/webhooks"],
  ["@payops/reconciliation", "0.1.0", "packages/reconciliation"],
  ["@payops/pilot", "0.1.0", "packages/pilot"],
  ["@payops/sdk", "0.1.0", "packages/sdk"],
];

const currentPublicPackages = firstPublicPackages.map(([name, , path]) => [
  name,
  "0.1.1",
  path,
]);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "payops-release-test-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("release manifest validation", () => {
  it("accepts the exact first-public v0.1.0 bundle", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../release/manifests/0.1.0.json", import.meta.url),
        "utf8",
      ),
    );

    const parsed = parseReleaseManifest(manifest, "v0.1.0");
    assert.deepEqual(
      parsed.packages.map(({ name, version, path }) => [name, version, path]),
      firstPublicPackages,
    );
  });

  it("accepts the exact v0.1.1 patch bundle", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../release/manifests/0.1.1.json", import.meta.url),
        "utf8",
      ),
    );

    const parsed = parseReleaseManifest(manifest, "v0.1.1");
    assert.deepEqual(
      parsed.packages.map(({ name, version, path }) => [name, version, path]),
      currentPublicPackages,
    );
  });

  it("requires every public source package to use v0.1.1", async () => {
    const sourcePackages = await Promise.all(
      currentPublicPackages.map(
        async ([expectedName, expectedVersion, path]) => {
          const manifest = JSON.parse(
            await readFile(
              new URL(`../../${path}/package.json`, import.meta.url),
              "utf8",
            ),
          );
          return [manifest.name, manifest.version, path];
        },
      ),
    );

    assert.deepEqual(sourcePackages, currentPublicPackages);
  });

  it("ships the immutable v0.1 release manifests", async () => {
    const files = await readdir(
      new URL("../../release/manifests", import.meta.url),
    );

    assert.deepEqual(files.sort(), ["0.1.0.json", "0.1.1.json"]);
  });

  it("rejects bundle mismatch, duplicates, unsafe paths, order, and versions", () => {
    const base = releaseManifest();
    assert.throws(
      () =>
        parseReleaseManifest({ ...base, bundleVersion: "v0.1.1" }, "v0.1.0"),
      /bundle/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          {
            ...base,
            packages: [
              base.packages[0],
              base.packages[0],
              ...base.packages.slice(2),
            ],
          },
          "v0.1.0",
        ),
      /exact package order/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          {
            ...base,
            packages: [
              { ...base.packages[0], path: "../outside" },
              ...base.packages.slice(1),
            ],
          },
          "v0.1.0",
        ),
      /exact package order/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          {
            ...base,
            packages: [
              base.packages[1],
              base.packages[0],
              ...base.packages.slice(2),
            ],
          },
          "v0.1.0",
        ),
      /exact package order/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          {
            ...base,
            packages: [
              { ...base.packages[0], version: "v0.1.1" },
              ...base.packages.slice(1),
            ],
          },
          "v0.1.0",
        ),
      /semver/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          {
            ...base,
            packages: [
              ...base.packages,
              {
                name: "@payops/private",
                version: "0.1.0",
                path: "packages/private",
              },
            ],
          },
          "v0.1.0",
        ),
      /every public package/i,
    );
    assert.throws(
      () =>
        parseReleaseManifest(
          { ...base, packages: base.packages.slice(0, -1) },
          "v0.1.0",
        ),
      /every public package/i,
    );
  });

  it("rejects an unsafe tag before resolving a manifest path", async () => {
    await assert.rejects(
      loadReleaseManifest(directory, "../../package"),
      /canonical/i,
    );
  });

  it("rejects a missing exact release manifest", async () => {
    await assert.rejects(loadReleaseManifest(directory, "v0.1.0"), /missing/i);
  });

  it("rejects package metadata that differs from the release manifest", () => {
    const item = releaseManifest().packages[0];
    assert.doesNotThrow(() =>
      verifyReleasePackageManifest(item, {
        name: "@payops/contracts",
        version: "0.1.0",
      }),
    );
    assert.throws(
      () =>
        verifyReleasePackageManifest(item, {
          name: "@payops/contracts",
          version: "0.1.1",
        }),
      /metadata mismatch/i,
    );
  });
});

describe("public package metadata", () => {
  it("accepts the exact public package identity", () => {
    assert.doesNotThrow(() =>
      verifyPublicPackageMetadata(publicPackageManifest(), {
        expectedName: "@payops/core",
        expectedDirectory: "packages/core",
        expectedVersion: "0.1.1",
      }),
    );
  });

  it("accepts every current public source package", async () => {
    for (const [
      expectedName,
      expectedVersion,
      expectedDirectory,
    ] of currentPublicPackages) {
      const manifest = JSON.parse(
        await readFile(
          new URL(`../../${expectedDirectory}/package.json`, import.meta.url),
          "utf8",
        ),
      );
      assert.doesNotThrow(() =>
        verifyPublicPackageMetadata(manifest, {
          expectedName,
          expectedDirectory,
          expectedVersion,
        }),
      );
    }
  });

  for (const [name, change, message] of [
    ["private package", { private: true }, /must be public/i],
    ["non-boolean private marker", { private: "true" }, /must be public/i],
    [
      "wrong repository directory",
      {
        repository: {
          type: "git",
          url: "https://github.com/payops-labs/solana-payment-ops.git",
          directory: "packages/other",
        },
      },
      /repository/i,
    ],
    ["insecure homepage", { homepage: "http://example.test" }, /homepage/i],
    [
      "wrong issue tracker",
      { bugs: { url: "https://example.test/issues" } },
      /issue tracker/i,
    ],
    ["wrong license", { license: "MIT" }, /license/i],
    ["missing public access", { publishConfig: {} }, /public access/i],
    ["missing Node floor", { engines: {} }, /node engine/i],
    ["too few keywords", { keywords: ["solana", "payments"] }, /keywords/i],
    [
      "duplicate keywords",
      { keywords: ["solana", "payments", "payments"] },
      /keywords/i,
    ],
    [
      "unsafe file root",
      { files: ["dist", "README.md", "LICENSE", "test"] },
      /package files/i,
    ],
    [
      "certificate file",
      { files: ["dist", "README.md", "LICENSE", "receiver.crt"] },
      /package files/i,
    ],
    [
      "private repository notes",
      { files: ["dist", "README.md", "LICENSE", "private-notes"] },
      /package files/i,
    ],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () =>
          verifyPublicPackageMetadata(
            { ...publicPackageManifest(), ...change },
            {
              expectedName: "@payops/core",
              expectedDirectory: "packages/core",
              expectedVersion: "0.1.1",
            },
          ),
        message,
      );
    });
  }
});

describe("public release documentation", () => {
  const rootDocuments = [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "release/README.md",
  ];

  it("ships the required repository documents", async () => {
    for (const path of rootDocuments) {
      const contents = await readFile(
        new URL(`../../${path}`, import.meta.url),
        "utf8",
      );
      assert.ok(contents.trim().length > 0, `${path} must not be empty`);
    }
  });

  it("documents private security reporting and secret-safe disclosure", async () => {
    const security = await readFile(
      new URL("../../SECURITY.md", import.meta.url),
      "utf8",
    );
    assert.match(security, /private vulnerability reporting/i);
    for (const forbiddenDisclosure of [
      /wallet secrets/i,
      /private keys/i,
      /production credentials/i,
      /customer payment data/i,
    ]) {
      assert.match(security, forbiddenDisclosure);
    }
  });

  it("documents the current PayOps package version", async () => {
    const documentation = await Promise.all(
      [
        ...rootDocuments,
        ...currentPublicPackages.map(([, , path]) => `${path}/README.md`),
      ].map((path) =>
        readFile(new URL(`../../${path}`, import.meta.url), "utf8"),
      ),
    );
    const qualifiedVersions = documentation
      .join("\n")
      .matchAll(/@payops\/[a-z-]+@(\d+\.\d+\.\d+)/gu);
    for (const [, version] of qualifiedVersions) {
      assert.equal(version, "0.1.1");
    }
  });
});

describe("fixture digest validation", () => {
  it("accepts exact bytes and rejects missing or changed fixtures", async () => {
    const fixtures = join(directory, "fixtures");
    await mkdir(fixtures);
    const bytes = '{"fixtureVersion":"0.1"}\n';
    await writeFile(join(fixtures, "case.json"), bytes);
    const manifest = {
      cases: [
        {
          file: "case.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
    await verifyFixtureDigests(manifest, fixtures);
    await writeFile(join(fixtures, "case.json"), `${bytes} `);
    await assert.rejects(verifyFixtureDigests(manifest, fixtures), /digest/i);
    manifest.cases[0].file = "missing.json";
    await assert.rejects(verifyFixtureDigests(manifest, fixtures), /fixture/i);
  });
});

describe("npm credential isolation", () => {
  it("removes publication credentials from unprivileged child steps", () => {
    const environment = environmentWithoutNpmCredentials({
      NODE_AUTH_TOKEN: "node-token",
      NPM_TOKEN: "npm-token",
      PATH: "/usr/bin",
    });

    assert.deepEqual(environment, { PATH: "/usr/bin" });
  });
});

describe("release source and resumable publication", () => {
  it("requires a clean exact tagged checkout", () => {
    assert.doesNotThrow(() => verifyReleaseGitState("", "abc", "abc"));
    assert.throws(
      () => verifyReleaseGitState(" M package.json", "abc", "abc"),
      /clean/i,
    );
    assert.throws(
      () => verifyReleaseGitState("", "abc", "def"),
      /checked-out commit/i,
    );
  });

  it("publishes only missing versions and accepts only matching bytes", () => {
    assert.equal(
      classifyPublishedVersion(
        { status: 1, stdout: "", stderr: "npm error code E404" },
        "sha512-local",
      ),
      "publish",
    );
    assert.equal(
      classifyPublishedVersion(
        { status: 0, stdout: '"sha512-local"\n', stderr: "" },
        "sha512-local",
      ),
      "already-published",
    );
    assert.throws(
      () =>
        classifyPublishedVersion(
          { status: 0, stdout: '"sha512-other"\n', stderr: "" },
          "sha512-local",
        ),
      /different bytes/i,
    );
    assert.throws(
      () =>
        classifyPublishedVersion(
          { status: 1, stdout: "", stderr: "npm error code E401" },
          "sha512-local",
        ),
      /inspect/i,
    );
  });

  it("preflights every registry version before returning a publication plan", () => {
    const inspected = [];
    const artifacts = [
      {
        name: "@payops/contracts",
        version: "0.1.0",
        integrity: "sha512-contracts",
      },
      {
        name: "@payops/core",
        version: "0.1.0",
        integrity: "sha512-core",
      },
    ];
    const plan = preflightReleasePublication(artifacts, (artifact) => {
      inspected.push(artifact.name);
      return artifact.name === "@payops/contracts"
        ? { status: 1, stdout: "", stderr: "npm error code E404" }
        : { status: 0, stdout: '"sha512-core"\n', stderr: "" };
    });

    assert.deepEqual(inspected, ["@payops/contracts", "@payops/core"]);
    assert.deepEqual(
      plan.map(({ name, publication }) => [name, publication]),
      [
        ["@payops/contracts", "publish"],
        ["@payops/core", "already-published"],
      ],
    );
  });
});

describe("release SBOM", () => {
  it("describes released tarballs and exact direct dependencies with valid purls", () => {
    const document = buildSpdxDocument({
      tag: "v0.1.0",
      created: "2026-08-11T00:00:00.000Z",
      repositoryUrl: "https://github.com/payops-labs/solana-payment-ops",
      packages: [
        {
          name: "@payops/contracts",
          version: "0.1.0",
          license: "Apache-2.0",
          dependencies: { zod: "4.4.3" },
          artifact: {
            file: "payops-contracts-0.1.0.tgz",
            sha256: "a".repeat(64),
            sha512: "b".repeat(128),
          },
        },
        {
          name: "@payops/core",
          version: "0.1.0",
          license: "Apache-2.0",
          dependencies: {
            "@payops/contracts": "workspace:^0.1.0",
            zod: "4.4.3",
          },
          artifact: {
            file: "payops-core-0.1.0.tgz",
            sha256: "c".repeat(64),
            sha512: "d".repeat(128),
          },
        },
      ],
    });

    assert.deepEqual(document.documentDescribes, [
      "SPDXRef-Package-payops-contracts-0.1.0",
      "SPDXRef-Package-payops-core-0.1.0",
    ]);
    assert.ok(
      document.packages.some((item) =>
        item.externalRefs?.some(
          (reference) =>
            reference.referenceLocator === "pkg:npm/%40payops/contracts@0.1.0",
        ),
      ),
    );
    assert.ok(
      document.packages.some((item) =>
        item.externalRefs?.some(
          (reference) => reference.referenceLocator === "pkg:npm/zod@4.4.3",
        ),
      ),
    );
    assert.ok(
      document.relationships.some(
        (relationship) =>
          relationship.spdxElementId === "SPDXRef-Package-payops-core-0.1.0" &&
          relationship.relationshipType === "DEPENDS_ON" &&
          relationship.relatedSpdxElement ===
            "SPDXRef-Package-payops-contracts-0.1.0",
      ),
    );
    assert.equal(
      JSON.stringify(document).includes("workspace:%5E0.1.0"),
      false,
    );
  });
});

function releaseManifest() {
  return {
    schemaVersion: "0.1",
    bundleVersion: "v0.1.0",
    packages: [
      {
        name: "@payops/contracts",
        version: "0.1.0",
        path: "packages/contracts",
      },
      { name: "@payops/core", version: "0.1.0", path: "packages/core" },
      {
        name: "@payops/ingestion",
        version: "0.1.0",
        path: "packages/ingestion",
      },
      { name: "@payops/webhooks", version: "0.1.0", path: "packages/webhooks" },
      {
        name: "@payops/reconciliation",
        version: "0.1.0",
        path: "packages/reconciliation",
      },
      { name: "@payops/pilot", version: "0.1.0", path: "packages/pilot" },
      { name: "@payops/sdk", version: "0.1.0", path: "packages/sdk" },
    ],
  };
}

function publicPackageManifest() {
  return {
    name: "@payops/core",
    version: "0.1.1",
    description: "Deterministic Solana payment verification primitives",
    license: "Apache-2.0",
    engines: { node: ">=22.18.0" },
    files: ["dist", "README.md", "LICENSE"],
    repository: {
      type: "git",
      url: "https://github.com/payops-labs/solana-payment-ops.git",
      directory: "packages/core",
    },
    homepage: "https://github.com/payops-labs/solana-payment-ops#readme",
    bugs: {
      url: "https://github.com/payops-labs/solana-payment-ops/issues",
    },
    keywords: ["solana", "payments", "verification"],
    publishConfig: { access: "public" },
  };
}
