import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPublicPackageMetadata } from "./release-lib.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packages = [
  {
    name: "@payops/contracts",
    version: "0.1.1",
    path: "packages/contracts",
    roots: ["dist/", "schemas/"],
  },
  {
    name: "@payops/core",
    version: "0.1.1",
    path: "packages/core",
    roots: ["dist/"],
  },
  {
    name: "@payops/ingestion",
    version: "0.1.1",
    path: "packages/ingestion",
    roots: ["dist/", "migrations/"],
  },
  {
    name: "@payops/webhooks",
    version: "0.1.1",
    path: "packages/webhooks",
    roots: ["dist/", "migrations/", "examples/", "src/examples/"],
  },
  {
    name: "@payops/reconciliation",
    version: "0.1.1",
    path: "packages/reconciliation",
    roots: ["dist/", "migrations/", "examples/"],
  },
  {
    name: "@payops/pilot",
    version: "0.1.1",
    path: "packages/pilot",
    roots: ["dist/", "migrations/", "examples/"],
  },
  {
    name: "@payops/sdk",
    version: "0.1.1",
    path: "packages/sdk",
    roots: ["dist/"],
  },
];
const alwaysAllowed = new Set(["package.json", "README.md", "LICENSE"]);
const banned =
  /(^|\/)(?:test|tests|coverage|internal-notes|private-notes)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.(?:cer|crt|key|p12|pfx|pem|tsbuildinfo)$|\.DS_Store$/;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "payops-packages-"));

try {
  const tarballs = [];
  for (const definition of packages) {
    const packageDirectory = join(repository, definition.path);
    const sourceManifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    verifyPublicPackageMetadata(sourceManifest, {
      expectedName: definition.name,
      expectedDirectory: definition.path,
      expectedVersion: definition.version,
    });
    const inventory = JSON.parse(
      execFileSync(
        "pnpm",
        ["--dir", packageDirectory, "pack", "--dry-run", "--json"],
        { encoding: "utf8", env: { ...process.env, CI: "true" } },
      ),
    );
    assert(
      inventory.name === definition.name,
      `${definition.name}: wrong package name`,
    );
    assert(
      inventory.version === definition.version,
      `${definition.name}: version must be ${definition.version}`,
    );
    const files = inventory.files.map(({ path }) => path);
    for (const required of alwaysAllowed) {
      assert(
        files.includes(required),
        `${definition.name}: missing ${required}`,
      );
    }
    for (const path of files) {
      assert(
        !banned.test(path),
        `${definition.name}: forbidden artifact ${path}`,
      );
      assert(
        alwaysAllowed.has(path) ||
          definition.roots.some((root) => path.startsWith(root)),
        `${definition.name}: undeclared artifact ${path}`,
      );
      if (path.endsWith(".map")) {
        const contents = await readFile(join(packageDirectory, path), "utf8");
        assert(
          !contents.includes(repository) && !contents.includes("file://"),
          `${definition.name}: source map exposes a local path`,
        );
      }
    }
    if (definition.name === "@payops/core") {
      assert(
        files.includes("dist/fixtures/v0.1/manifest.json"),
        "@payops/core: bundled manifest is missing",
      );
      assert(
        files.filter((path) => path.startsWith("dist/fixtures/v0.1/cases/"))
          .length === 25,
        "@payops/core: bundled fixture corpus must contain 25 cases",
      );
    }

    const output = execFileSync(
      "pnpm",
      [
        "--dir",
        packageDirectory,
        "pack",
        "--json",
        "--pack-destination",
        temporaryDirectory,
      ],
      { encoding: "utf8", env: { ...process.env, CI: "true" } },
    );
    const packed = JSON.parse(output);
    const tarball = resolve(temporaryDirectory, packed.filename);
    tarballs.push(tarball);

    const extracted = join(
      temporaryDirectory,
      definition.name.replace("/", "-"),
    );
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
    const packedManifest = JSON.parse(
      await readFile(join(extracted, "package", "package.json"), "utf8"),
    );
    verifyPublicPackageMetadata(packedManifest, {
      expectedName: definition.name,
      expectedDirectory: definition.path,
      expectedVersion: definition.version,
    });
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, range] of Object.entries(
        packedManifest[section] ?? {},
      )) {
        if (name.startsWith("@payops/")) {
          const dependency = packages.find((item) => item.name === name);
          assert(
            dependency !== undefined && range === `^${dependency.version}`,
            `${definition.name}: ${name} must pack as the released minor line`,
          );
        }
        assert(
          typeof range === "string" && !range.startsWith("workspace:"),
          `${definition.name}: ${section} contains an unresolved workspace range`,
        );
      }
    }
  }

  const consumer = join(temporaryDirectory, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "payops-clean-consumer",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: consumer, stdio: "pipe" },
  );
  await writeFile(join(consumer, "smoke.mjs"), cleanConsumerSmoke());
  execFileSync(process.execPath, [join(consumer, "smoke.mjs")], {
    cwd: consumer,
    stdio: "inherit",
  });
  for (const [binary, expectedStatus, args = []] of [
    [
      "payops-conformance",
      0,
      [
        join(
          consumer,
          "node_modules",
          "@payops",
          "core",
          "dist",
          "fixtures",
          "v0.1",
          "manifest.json",
        ),
      ],
    ],
    ["payops-ingestion", 2],
    ["payops-webhooks", 2],
    ["payops-reconciliation", 2],
    ["payops-pilot", 2],
  ]) {
    const result = spawnSync(
      join(consumer, "node_modules", ".bin", binary),
      args,
      {
        cwd: consumer,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert(
      result.status === expectedStatus,
      `${binary}: installed executable returned ${result.status}`,
    );
    assert(
      result.stdout.length + result.stderr.length > 0,
      `${binary}: installed executable silently did nothing`,
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanConsumerSmoke() {
  return `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as contracts from "@payops/contracts";
import * as core from "@payops/core";
import * as ingestion from "@payops/ingestion";
import * as webhooks from "@payops/webhooks";
import { createExampleConsumer } from "@payops/webhooks/consumer-example";
import * as reconciliation from "@payops/reconciliation";
import * as pilot from "@payops/pilot";
import { createPayOpsClient } from "@payops/sdk";

assert.equal(contracts.LIFECYCLE_SCHEMA_VERSION, "0.1");
assert.equal(typeof core.evaluateManifest, "function");
assert.equal(typeof ingestion.PostgresIngestionStore, "function");
assert.equal(typeof webhooks.verifyWebhook, "function");
assert.equal(typeof reconciliation.reconcileEvent, "function");
assert.equal(typeof pilot.buildAuditArtifacts, "function");
let sdkRequests = 0;
const sdk = createPayOpsClient({
  baseUrl: "https://api.example.com",
  apiKey: "payops_clean_consumer_key",
  fetch: async (url, init) => {
    sdkRequests += 1;
    assert.equal(String(url), "https://api.example.com/v1/organization");
    assert.equal(new Headers(init.headers).get("x-api-key"), "payops_clean_consumer_key");
    return Response.json({
      organizationId: "00000000-0000-4000-8000-000000000001",
      actorKind: "api_key",
      permissions: { organizationRead: true }
    }, { headers: { "x-request-id": "00000000-0000-4000-8000-000000000002" } });
  }
});
assert.equal((await sdk.getOrganization()).actorKind, "api_key");
assert.equal(sdkRequests, 1);

const manifestPath = fileURLToPath(import.meta.resolve("@payops/core/fixtures/v0.1/manifest.json"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.cases.length, 25);
assert.equal((await core.evaluateManifest(manifestPath)).passed, true);

const now = new Date("2026-08-11T12:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1000));
const eventId = "00000000-0000-4000-8000-000000000006";
const body = JSON.stringify({
  schemaVersion: "0.1",
  id: eventId,
  type: "invoice.issued",
  occurredAt: now.toISOString(),
  statusAtOccurrence: "issued",
  object: { type: "invoice", id: "invoice-001", version: 1 },
  data: {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    publicReference: "INV-001",
    currency: "USD",
    totalMinorUnits: "1250",
    dueAt: "2026-08-20T00:00:00.000Z",
    issuedAt: now.toISOString(),
    acceptedAssetSymbols: ["USDC", "USDT"]
  }
});
let applied = 0;
const consumer = createExampleConsumer({
  currentSecret: "clean-consumer-secret",
  now: () => now,
  apply: async () => { applied += 1; }
});
const request = {
  rawBody: body,
  eventId,
  timestamp,
  signature: webhooks.signWebhook(body, timestamp, "clean-consumer-secret")
};
assert.deepEqual(await consumer.handle(request), { status: 204 });
assert.deepEqual(await consumer.handle(request), { status: 204 });
assert.equal(applied, 1);
`;
}
