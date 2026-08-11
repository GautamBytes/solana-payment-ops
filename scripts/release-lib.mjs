import { execFileSync } from "node:child_process";
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
  const { version } = parseCanonicalReleaseTag(tag);
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
    "Release manifest must use the exact package order",
  );
  const packages = value.packages.map((entry, index) => {
    assertObject(entry, `Release package ${index}`);
    assertExactKeys(entry, packageKeys, `Release package ${index}`);
    const expected = RELEASE_PACKAGES[index];
    assert(
      expected !== undefined,
      "Release manifest must use the exact package order",
    );
    assert(
      entry.name === expected.name && entry.path === expected.path,
      "Release manifest must use the exact package order and safe package paths",
    );
    assert(
      entry.version === version,
      `Release package version must equal ${version}`,
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

export function verifyNpmOwnership(scope, expectedOwner, run = execFileSync) {
  assert(/^@[a-z0-9][a-z0-9-]*$/.test(scope), "Npm scope is invalid");
  assert(
    typeof expectedOwner === "string" && expectedOwner.length > 0,
    "NPM_SCOPE_OWNER ownership evidence is missing",
  );
  const whoami = run("npm", ["whoami"], { encoding: "utf8" }).trim();
  assert(
    whoami === expectedOwner,
    "Authenticated npm user does not match NPM_SCOPE_OWNER",
  );
  const members = JSON.parse(
    run("npm", ["org", "ls", scope.slice(1), "--json"], { encoding: "utf8" }),
  );
  assert(
    members !== null &&
      typeof members === "object" &&
      !Array.isArray(members) &&
      members[expectedOwner] === "owner",
    `Npm user ${expectedOwner} is not an owner of ${scope}`,
  );
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
