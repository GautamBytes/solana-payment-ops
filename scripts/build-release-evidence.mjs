import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeterministicTarGzip } from "./release-archive.mjs";
import { buildSpdxDocument, loadReleaseManifest } from "./release-lib.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const outputDirectory = resolve(
  process.argv[3] ?? join(repository, "release", "evidence"),
);
if (tag === undefined) throw new Error("Release tag argument is required");
const { manifest } = await loadReleaseManifest(repository, tag);
const version = tag.slice(1);
await mkdir(outputDirectory, { recursive: true });

const conformance = execFileSync(
  process.execPath,
  [
    join(repository, "packages", "core", "dist", "cli.js"),
    join(repository, "fixtures", "v0.1", "manifest.json"),
  ],
  { encoding: "utf8" },
);
await writeFile(
  join(outputDirectory, `payops-v${version}-conformance.json`),
  conformance,
);
await cp(
  join(repository, "fixtures", "v0.1", "manifest.json"),
  join(outputDirectory, `payops-v${version}-fixture-manifest.json`),
);

const sourceDateEpoch = Number(
  process.env.SOURCE_DATE_EPOCH ??
    execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
);
const schemaDirectory = join(repository, "packages", "contracts", "schemas");
const schemaFiles = (await readdir(schemaDirectory)).sort();
const schemaEntries = await Promise.all(
  schemaFiles.map(async (file) => ({
    name: `schemas/${file}`,
    bytes: await readFile(join(schemaDirectory, file)),
  })),
);
await writeFile(
  join(outputDirectory, `payops-v${version}-schemas.tar.gz`),
  buildDeterministicTarGzip(schemaEntries, sourceDateEpoch),
);

const created = new Date(sourceDateEpoch * 1_000).toISOString();
const packageDirectory = await mkdtemp(join(tmpdir(), "payops-evidence-pack-"));
const packageArtifacts = [];
try {
  for (const item of manifest.packages) {
    const packed = JSON.parse(
      execFileSync(
        "pnpm",
        [
          "--dir",
          join(repository, item.path),
          "pack",
          "--json",
          "--pack-destination",
          packageDirectory,
        ],
        { encoding: "utf8", env: { ...process.env, CI: "true" } },
      ),
    );
    const bytes = await readFile(resolve(packageDirectory, packed.filename));
    packageArtifacts.push({
      name: item.name,
      file: basename(packed.filename),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    });
  }
} finally {
  await rm(packageDirectory, { recursive: true, force: true });
}
const sbomPackages = await Promise.all(
  manifest.packages.map(async (item, index) => {
    const packageManifest = JSON.parse(
      await readFile(join(repository, item.path, "package.json"), "utf8"),
    );
    const artifact = packageArtifacts[index];
    if (artifact === undefined || artifact.name !== item.name) {
      throw new Error(`Package artifact order mismatch: ${item.name}`);
    }
    return {
      name: item.name,
      version: item.version,
      license: packageManifest.license,
      dependencies: packageManifest.dependencies ?? {},
      artifact,
    };
  }),
);
const sbom = buildSpdxDocument({
  tag,
  created,
  repositoryUrl: "https://github.com/payops-labs/solana-payment-ops",
  packages: sbomPackages,
});
await writeFile(
  join(outputDirectory, `payops-v${version}-sbom.spdx.json`),
  `${JSON.stringify(sbom, null, 2)}\n`,
);

const evidenceFiles = (await readdir(outputDirectory))
  .filter((file) => file !== "SHA256SUMS")
  .sort();
const sums = [];
for (const file of evidenceFiles) {
  const bytes = await readFile(join(outputDirectory, file));
  sums.push(
    `${createHash("sha256").update(bytes).digest("hex")}  ${basename(file)}`,
  );
}
await writeFile(join(outputDirectory, "SHA256SUMS"), `${sums.join("\n")}\n`);
