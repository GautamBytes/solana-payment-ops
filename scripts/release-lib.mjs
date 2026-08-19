import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const RELEASE_PACKAGES = Object.freeze([
  { name: "@payops/contracts", path: "packages/contracts" },
  { name: "@payops/core", path: "packages/core" },
  { name: "@payops/ingestion", path: "packages/ingestion" },
  { name: "@payops/webhooks", path: "packages/webhooks" },
  { name: "@payops/reconciliation", path: "packages/reconciliation" },
  { name: "@payops/pilot", path: "packages/pilot" },
  { name: "@payops/sdk", path: "packages/sdk" },
]);

const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const packageKeys = new Set(["name", "version", "path"]);

export function parseCanonicalReleaseTag(tag) {
  assert(
    typeof tag === "string" && tagPattern.test(tag),
    "Release tag must be canonical vMAJOR.MINOR.PATCH",
  );
  return Object.freeze({ tag, version: tag.slice(1) });
}

export function parseReleaseManifest(value, tag) {
  parseCanonicalReleaseTag(tag);
  assertObject(value, "Release manifest");
  assertExactKeys(
    value,
    new Set(["schemaVersion", "bundleVersion", "packages"]),
    "Release manifest",
  );
  assert(
    value.schemaVersion === "0.1",
    "Release manifest schema version is unsupported",
  );
  assert(
    value.bundleVersion === tag,
    "Release manifest bundle does not match the tag",
  );
  assert(
    Array.isArray(value.packages),
    "Release manifest packages must be an array",
  );
  assert(
    value.packages.length === RELEASE_PACKAGES.length,
    "Release manifest must include every public package",
  );
  let previousIndex = -1;
  const packages = value.packages.map((entry, index) => {
    assertObject(entry, `Release package ${index}`);
    assertExactKeys(entry, packageKeys, `Release package ${index}`);
    const expectedIndex = RELEASE_PACKAGES.findIndex(
      (candidate) => candidate.name === entry.name,
    );
    const expected = RELEASE_PACKAGES[expectedIndex];
    assert(
      expected !== undefined && expectedIndex > previousIndex,
      "Release manifest must use the exact package order",
    );
    previousIndex = expectedIndex;
    assert(
      entry.name === expected.name && entry.path === expected.path,
      "Release manifest must use the exact package order and safe package paths",
    );
    assert(
      typeof entry.version === "string" &&
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
          entry.version,
        ),
      "Release package version must be canonical SemVer",
    );
    return Object.freeze({
      name: entry.name,
      version: entry.version,
      path: entry.path,
    });
  });
  return Object.freeze({ schemaVersion: "0.1", bundleVersion: tag, packages });
}

export async function verifyFixtureDigests(manifest, fixtureDirectory) {
  assertObject(manifest, "Fixture manifest");
  assert(
    Array.isArray(manifest.cases),
    "Fixture manifest cases must be an array",
  );
  const root = await realpath(fixtureDirectory);
  const paths = new Set();
  for (const item of manifest.cases) {
    assertObject(item, "Fixture case");
    assert(typeof item.file === "string", "Fixture path must be a string");
    assert(/^[0-9a-f]{64}$/.test(item.sha256), "Fixture digest is invalid");
    assert(
      !isAbsolute(item.file) && !item.file.includes("\\"),
      "Fixture path is unsafe",
    );
    let path;
    try {
      path = await realpath(resolve(root, item.file));
    } catch {
      throw new Error(`Fixture is missing: ${item.file}`);
    }
    const child = relative(root, path);
    assert(
      child.length > 0 &&
        child !== ".." &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child),
      "Fixture path escapes the fixture directory",
    );
    assert(!paths.has(path), "Fixture manifest contains a duplicate file");
    paths.add(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert(digest === item.sha256, `Fixture digest mismatch: ${item.file}`);
  }
}

export async function loadReleaseManifest(repository, tag) {
  const { version } = parseCanonicalReleaseTag(tag);
  const path = resolve(repository, "release", "manifests", `${version}.json`);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Release manifest is missing for ${tag}`);
  }
  return { path, manifest: parseReleaseManifest(JSON.parse(raw), tag) };
}

export function environmentWithoutNpmCredentials(environment) {
  const sanitized = { ...environment };
  delete sanitized.NODE_AUTH_TOKEN;
  delete sanitized.NPM_TOKEN;
  return sanitized;
}

export function verifyReleaseGitState(status, head, taggedCommit) {
  assert(status.length === 0, "Release source tree must be clean");
  assert(
    head === taggedCommit,
    "Release tag must identify the checked-out commit",
  );
}

export function verifyReleasePackageManifest(item, packageManifest) {
  assertObject(packageManifest, `Package manifest for ${item.name}`);
  assert(
    packageManifest.name === item.name &&
      packageManifest.version === item.version,
    `Release package metadata mismatch: ${item.name}`,
  );
}

export function verifyPublicPackageMetadata(
  packageManifest,
  { expectedName, expectedDirectory, expectedVersion },
) {
  assertObject(packageManifest, `Package manifest for ${expectedName}`);
  assert(
    packageManifest.name === expectedName &&
      packageManifest.version === expectedVersion,
    `Public package identity is invalid: ${expectedName}`,
  );
  assert(
    !Object.hasOwn(packageManifest, "private"),
    `Public package must be public: ${expectedName}`,
  );
  assert(
    typeof packageManifest.description === "string" &&
      packageManifest.description.length > 0 &&
      packageManifest.description.length <= 160,
    `Public package description is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.repository?.type === "git" &&
      packageManifest.repository.url ===
        "https://github.com/payops-labs/solana-payment-ops.git" &&
      packageManifest.repository.directory === expectedDirectory,
    `Public package repository is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.homepage ===
      "https://github.com/payops-labs/solana-payment-ops#readme",
    `Public package homepage is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.bugs?.url ===
      "https://github.com/payops-labs/solana-payment-ops/issues",
    `Public package issue tracker is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.license === "Apache-2.0",
    `Public package license is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.engines?.node === ">=22.18.0",
    `Public package Node engine is invalid: ${expectedName}`,
  );
  assert(
    packageManifest.publishConfig?.access === "public",
    `Public package must declare public access: ${expectedName}`,
  );

  const keywords = packageManifest.keywords;
  assert(
    Array.isArray(keywords) &&
      keywords.length >= 3 &&
      keywords.length <= 6 &&
      keywords.every(
        (keyword) =>
          typeof keyword === "string" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(keyword),
      ) &&
      new Set(keywords).size === keywords.length &&
      keywords.includes("solana") &&
      keywords.includes("payments"),
    `Public package keywords are invalid: ${expectedName}`,
  );

  const files = packageManifest.files;
  const forbiddenFile =
    /(^|\/)(?:test|tests|coverage|internal-notes|private-notes)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.(?:cer|crt|key|p12|pfx|pem|tsbuildinfo)$/iu;
  assert(
    Array.isArray(files) &&
      files.length > 0 &&
      new Set(files).size === files.length &&
      files.every(
        (path) =>
          typeof path === "string" &&
          path.length > 0 &&
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.split("/").includes("..") &&
          !forbiddenFile.test(path),
      ),
    `Public package files are invalid: ${expectedName}`,
  );
}

export function classifyPublishedVersion(result, expectedIntegrity) {
  if (result.status === 0) {
    let existing;
    try {
      existing = JSON.parse(result.stdout);
    } catch {
      throw new Error("Unable to inspect the published package version");
    }
    assert(
      existing === expectedIntegrity,
      "Package version already exists with different bytes",
    );
    return "already-published";
  }
  if (`${result.stderr}${result.stdout}`.includes("E404")) return "publish";
  throw new Error("Unable to inspect the published package version");
}

export function preflightReleasePublication(artifacts, inspect) {
  assert(Array.isArray(artifacts), "Release artifacts must be an array");
  assert(typeof inspect === "function", "Registry inspector is required");
  return Object.freeze(
    artifacts.map((artifact) =>
      Object.freeze({
        ...artifact,
        publication: classifyPublishedVersion(
          inspect(artifact),
          artifact.integrity,
        ),
      }),
    ),
  );
}

export function buildSpdxDocument({ tag, created, repositoryUrl, packages }) {
  parseCanonicalReleaseTag(tag);
  const releasedByName = new Map(packages.map((item) => [item.name, item]));
  assert(
    releasedByName.size === packages.length,
    "SBOM release packages must be unique",
  );
  const describedPackages = packages.map((item) => spdxReleasedPackage(item));
  const dependencyPackages = new Map();
  const relationships = [];

  for (const item of packages) {
    const sourceId = spdxPackageId(item.name, item.version);
    relationships.push({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: sourceId,
    });
    for (const [name, range] of Object.entries(item.dependencies ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const releasedDependency = releasedByName.get(name);
      const version = releasedDependency?.version ?? range;
      if (releasedDependency !== undefined) {
        assert(
          range === `workspace:^${version}`,
          `Internal dependency range is not release-safe: ${item.name} -> ${name}`,
        );
      } else {
        assert(
          /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version),
          `External dependency must use an exact version: ${item.name} -> ${name}`,
        );
        const dependencyId = spdxPackageId(name, version);
        if (!dependencyPackages.has(dependencyId)) {
          dependencyPackages.set(
            dependencyId,
            spdxDependencyPackage(name, version),
          );
        }
      }
      relationships.push({
        spdxElementId: sourceId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: spdxPackageId(name, version),
      });
    }
  }

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `payops-${tag}`,
    documentNamespace: `${repositoryUrl}/releases/tag/${tag}/sbom`,
    creationInfo: {
      created,
      creators: ["Tool: PayOps release evidence builder"],
    },
    documentDescribes: describedPackages.map((item) => item.SPDXID),
    packages: [
      ...describedPackages,
      ...[...dependencyPackages.values()].sort((left, right) =>
        left.SPDXID.localeCompare(right.SPDXID),
      ),
    ],
    relationships,
  };
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function spdxReleasedPackage(item) {
  assertObject(item, "SBOM package");
  assertObject(item.artifact, "SBOM package artifact");
  return {
    SPDXID: spdxPackageId(item.name, item.version),
    name: item.name,
    versionInfo: item.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: item.license,
    licenseDeclared: item.license,
    copyrightText: "NOASSERTION",
    packageFileName: item.artifact.file,
    checksums: [
      { algorithm: "SHA256", checksumValue: item.artifact.sha256 },
      { algorithm: "SHA512", checksumValue: item.artifact.sha512 },
    ],
    externalRefs: [npmPurl(item.name, item.version)],
  };
}

function spdxDependencyPackage(name, version) {
  return {
    SPDXID: spdxPackageId(name, version),
    name,
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [npmPurl(name, version)],
  };
}

function spdxPackageId(name, version) {
  const identifier = `${name}-${version}`
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9.-]+/g, "-");
  return `SPDXRef-Package-${identifier}`;
}

function npmPurl(name, version) {
  const locator = name.startsWith("@")
    ? `${encodeURIComponent(name.split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return {
    referenceCategory: "PACKAGE-MANAGER",
    referenceType: "purl",
    referenceLocator: `pkg:npm/${locator}@${encodeURIComponent(version)}`,
  };
}

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertExactKeys(value, allowed, label) {
  assert(
    Object.keys(value).every((key) => allowed.has(key)) &&
      Object.keys(value).length === allowed.size,
    `${label} contains missing or unknown fields`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
