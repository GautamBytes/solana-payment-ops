import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("hosted runtime source contract", async () => {
  const [
    nextConfig,
    apiBin,
    workerBin,
    webLive,
    webReady,
    tryPage,
    runtimeConfig,
    embeddedRoute,
  ] = await Promise.all([
    source("apps/web/next.config.ts"),
    source("apps/api/src/bin.ts"),
    source("apps/worker/src/bin.ts"),
    source("apps/web/app/health/live/route.ts"),
    source("apps/web/app/health/ready/route.ts"),
    source("apps/web/app/try/page.tsx"),
    source("apps/web/lib/runtime-config.ts"),
    source("apps/web/app/v1/public-wallet-analysis/route.ts"),
  ]);

  assert.match(nextConfig, /output:\s*["']standalone["']/u);
  assert.match(nextConfig, /process\.env\.VERCEL\s*===\s*["']1["']/u);
  assert.match(apiBin, /PAYOPS_API_HOST/u);
  assert.match(apiBin, /\?\?\s*["']127\.0\.0\.1["']/u);
  assert.match(apiBin, /server\.listen\(\{\s*host,\s*port\s*\}\)/u);
  assert.match(apiBin, /SIGTERM/u);
  assert.match(apiBin, /await server\.close\(\)/u);
  assert.doesNotMatch(apiBin, /process\.exit\(/u);
  assert.match(workerBin, /SIGTERM/u);
  assert.match(workerBin, /Promise\.allSettled/u);
  assert.doesNotMatch(workerBin, /process\.exit\(/u);
  assert.doesNotMatch(webLive, /process\.env|fetch\s*\(/u);
  assert.equal(webReady.match(/fetch\s*\(/gu)?.length, 1);
  assert.match(webReady, /fetch\(`\$\{config\.apiOrigin\}\/health\/ready`/u);
  assert.match(webReady, /cache:\s*["']no-store["']/u);
  assert.match(webReady, /AbortSignal\.timeout\(3_000\)/u);
  assert.match(webReady, /api_unavailable/u);
  assert.match(tryPage, /export const dynamic\s*=\s*"force-dynamic"/u);
  assert.match(tryPage, /process\.env\.PAYOPS_API_ORIGIN/u);
  assert.match(runtimeConfig, /PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED/u);
  assert.match(runtimeConfig, /PAYOPS_PUBLIC_ANALYSIS_EDGE_RATE_LIMITED/u);
  assert.match(runtimeConfig, /PAYOPS_PUBLIC_SOLANA_RPC_URL/u);
  assert.match(embeddedRoute, /export const maxDuration\s*=\s*30/u);
  assert.match(embeddedRoute, /analyzePublicWallet/u);
});

test("container build contract", async () => {
  const [dockerfile, dockerignore, packageJson, buildScript] =
    await Promise.all([
      source("Dockerfile"),
      source(".dockerignore"),
      source("package.json").then(JSON.parse),
      source("scripts/build-containers.mjs"),
    ]);
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.\d+$/mu);
  assert.match(
    dockerfile,
    /node:22\.18\.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e/u,
  );
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.doesNotMatch(
    dockerfile,
    /^\s*(?:ARG|ENV)\s+[^\n]*(?:TOKEN|SECRET|PASSWORD|PRIVATE|DATABASE_URL)/imu,
  );
  assert.match(dockerfile, /^ARG PAYOPS_BUILD_REVISION$/mu);
  assert.doesNotMatch(dockerfile, /PAYOPS_BUILD_REVISION=development/u);
  assert.match(dockerfile, /\^\[0-9a-f\]\{40\}\$/u);
  for (const target of [
    "payops-api",
    "payops-worker",
    "payops-web",
    "payops-migrate",
  ]) {
    assert.match(dockerfile, new RegExp(`^FROM \\S+ AS ${target}$`, "mu"));
    const stage = finalStage(dockerfile, target);
    assert.match(stage, /^USER\s+[1-9][0-9]*:[1-9][0-9]*$/mu);
    assert.match(stage, /^(?:ENTRYPOINT|CMD)\s+\[.+\]$/mu);
    assert.match(stage, /^STOPSIGNAL\s+SIGTERM$/mu);
  }
  assert.match(finalStage(dockerfile, "payops-api"), /^EXPOSE\s+3000$/mu);
  assert.match(finalStage(dockerfile, "payops-web"), /^EXPOSE\s+3001$/mu);
  for (const directory of [
    "packages/ingestion/migrations",
    "packages/webhooks/migrations",
    "packages/reconciliation/migrations",
    "packages/platform/migrations",
  ]) {
    assert.match(
      finalStage(dockerfile, "payops-migrate"),
      new RegExp(directory),
    );
  }
  for (const ignored of [
    ".git",
    "node_modules",
    "dist",
    "test-results",
    "*.pem",
  ]) {
    assert.match(dockerignore, new RegExp(escapeRegExp(ignored)));
  }
  assert.equal(
    packageJson.scripts["containers:build"],
    "node scripts/build-containers.mjs",
  );
  assert.match(buildScript, /git["'],\s*\["rev-parse",\s*"HEAD"\]/u);
  assert.match(
    buildScript,
    /git["'],\s*\["status",\s*"--porcelain=v1",\s*"--untracked-files=all"\]/u,
  );
  assert.match(buildScript, /PAYOPS_BUILD_REVISION=/u);
  for (const target of [
    "payops-api",
    "payops-worker",
    "payops-web",
    "payops-migrate",
  ]) {
    assert.match(buildScript, new RegExp(`["]${target}["]`, "u"));
  }
  assert.equal(
    packageJson.scripts["containers:test"],
    "node deploy/smoke/run.mjs",
  );
});

test("provider-neutral Compose and environment capability contract", async () => {
  const composePath = new URL("deploy/compose.yaml", root);
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--file",
      fileURLPath(composePath),
      "config",
      "--no-interpolate",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const model = JSON.parse(result.stdout);
  const requiredServices = [
    "postgres",
    "upstreams",
    "role-bootstrap",
    "migrate",
    "api",
    "worker",
    "web",
  ];
  assert.deepEqual(Object.keys(model.services).sort(), requiredServices.sort());
  assert.equal(model.networks.payops.driver, "bridge");
  assert.equal(model.services.postgres.ports, undefined);
  assert.equal(
    model.services["role-bootstrap"].depends_on.postgres.condition,
    "service_healthy",
  );
  assert.equal(
    model.services.api.depends_on.migrate.condition,
    "service_completed_successfully",
  );
  assert.equal(
    model.services.worker.depends_on.migrate.condition,
    "service_completed_successfully",
  );
  assert.equal(model.services.web.depends_on.api.condition, "service_healthy");
  for (const service of requiredServices) {
    const definition = model.services[service];
    assert.deepEqual(definition.cap_drop, ["ALL"]);
    assert.ok(definition.security_opt.includes("no-new-privileges:true"));
    assert.ok(definition.deploy.resources.limits.memory);
    assert.ok(definition.deploy.resources.limits.cpus);
  }
  for (const service of ["role-bootstrap", "migrate"]) {
    assert.equal(model.services[service].restart, undefined);
  }
  for (const service of ["api", "worker", "web"]) {
    assert.equal(model.services[service].restart, "unless-stopped");
  }
  assertDatabaseEnvironment(model.services["role-bootstrap"], [
    "PAYOPS_DATABASE_ADMIN_URL",
  ]);
  assertDatabaseEnvironment(model.services.migrate, [
    "PAYOPS_MIGRATOR_DATABASE_URL",
  ]);
  assertDatabaseEnvironment(model.services.api, [
    "DATABASE_URL",
    "PAYOPS_PRODUCTION_CONTROL_DATABASE_URL",
    "PAYOPS_READINESS_VERIFIER_DATABASE_URL",
  ]);
  assertDatabaseEnvironment(model.services.worker, [
    "DATABASE_URL",
    "PAYOPS_SHADOW_PROJECTOR_DATABASE_URL",
  ]);
  assertDatabaseEnvironment(model.services.web, []);

  const [composeSource, example] = await Promise.all([
    source("deploy/compose.yaml"),
    source("deploy/.env.example"),
  ]);
  assert.doesNotMatch(
    composeSource,
    /["']?\$\{PAYOPS_SMOKE_SECRET_DIRECTORY:\?required\}:\/run\/payops:ro["']?/u,
  );
  assert.equal(
    [
      ...composeSource.matchAll(
        /source:\s*\$\{PAYOPS_SMOKE_SECRET_DIRECTORY:\?required\}/gu,
      ),
    ].length,
    3,
  );
  const referenced = new Set(
    [...composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?required\}/gu)].map(
      (match) => match[1],
    ),
  );
  const documented = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gmu)].map((match) => match[1]),
  );
  for (const name of referenced) {
    assert.ok(documented.has(name), `undocumented Compose variable ${name}`);
  }
  for (const name of [
    "PAYOPS_PUBLIC_ANALYSIS_ENABLED",
    "PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET",
    "PAYOPS_PUBLIC_ANALYSIS_CLIENT_LIMIT",
    "PAYOPS_PUBLIC_ANALYSIS_GLOBAL_LIMIT",
    "PAYOPS_PUBLIC_ANALYSIS_WINDOW_SECONDS",
    "PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED",
  ]) {
    assert.ok(documented.has(name), `missing public-analysis variable ${name}`);
  }
  assert.equal(
    model.services.api.environment.PAYOPS_PUBLIC_ANALYSIS_ENABLED,
    "${PAYOPS_PUBLIC_ANALYSIS_ENABLED:?required}",
  );
  assert.equal(
    model.services.api.environment.PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET,
    "${PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET:?required}",
  );
  assert.equal(
    model.services.web.environment.PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED,
    "${PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED:?required}",
  );
  assert.equal(
    model.services.web.environment.PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET,
    undefined,
  );
  assert.doesNotMatch(
    example,
    /-----BEGIN|postgres(?:ql)?:\/\/[^<\n]+:[^<\n]+@|https:\/\/(?:api|app|pay)\.[a-z0-9-]+\.(?:com|io)/iu,
  );
});

test("CI container gate and operator documentation contract", async () => {
  const [workflow, runbook, first, upgrade, incident, rootReadme] =
    await Promise.all([
      source(".github/workflows/ci.yml"),
      source("deploy/README.md"),
      source("deploy/checklists/first-deployment.md"),
      source("deploy/checklists/upgrade.md"),
      source("deploy/checklists/incident.md"),
      source("README.md"),
    ]);
  const containersJob = workflow.slice(workflow.indexOf("\n  containers:"));
  assert.match(workflow, /^  containers:\n    needs: verify$/mu);
  assert.match(workflow, /timeout-minutes:\s*30/u);
  assert.match(workflow, /permissions:\n\s+contents: read/u);
  assert.match(workflow, /docker\/setup-buildx-action@[0-9a-f]{40}/u);
  assert.match(workflow, /pnpm containers:build/u);
  assert.match(workflow, /pnpm containers:test/u);
  assert.match(workflow, /if: failure\(\)[\s\S]*upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /if: always\(\)[\s\S]*cleanup\.mjs payops-ci-smoke/u);
  assert.doesNotMatch(
    containersJob,
    /docker\/login-action|NPM_TOKEN|DATABASE_URL:/u,
  );

  for (const phrase of [
    "Initial deployment order",
    "Backup and restore",
    "Secret rotation",
    "Upgrade and rollback",
    "Incident control",
    "bootstrap the first owner",
    "forward-only",
  ]) {
    assert.match(runbook, new RegExp(escapeRegExp(phrase), "iu"));
  }
  assert.match(first, /Six unique principals/u);
  assert.match(upgrade, /never roll back schema/u);
  assert.match(incident, /manual SQL/u);
  assert.match(
    rootReadme,
    /payops-api[\s\S]*payops-worker[\s\S]*payops-web[\s\S]*payops-migrate/u,
  );
  assert.match(rootReadme, /invitation-only alpha/u);
  assert.match(rootReadme, /public-wallet analysis[\s\S]*read-only/iu);
  assert.doesNotMatch(runbook, /pilot traffic/iu);
  assert.match(runbook, /live merchant traffic/iu);
  assert.doesNotMatch(rootReadme, /https:\/\/payops\.[a-z]+/iu);
});

test("smoke lifecycle is interruption-safe and output-bounded", async () => {
  const [smoke, cleanup] = await Promise.all([
    source("deploy/smoke/run.mjs"),
    source("deploy/smoke/cleanup.mjs"),
  ]);

  assert.match(smoke, /new AbortController\(\)/u);
  assert.match(smoke, /process\.once\("SIGINT"/u);
  assert.match(smoke, /process\.once\("SIGTERM"/u);
  assert.match(smoke, /shutdown\.abort\(/u);
  assert.match(
    smoke,
    /Object\.hasOwn\(options, "signal"\)[\s\S]{0,120}shutdown\.signal/u,
  );
  assert.match(smoke, /^\s+signal,$/mu);
  assert.match(smoke, /process\.removeListener\("SIGINT"/u);
  assert.match(smoke, /process\.removeListener\("SIGTERM"/u);
  assert.match(smoke, /PAYOPS_PUBLIC_ANALYSIS_ENABLED:\s*"false"/u);
  assert.match(smoke, /PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED:\s*"false"/u);
  assert.match(
    smoke,
    /PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET:\s*randomBytes\(32\)\.toString\("base64url"\)/u,
  );
  assert.match(
    smoke,
    /try\s*\{\s*if \(temporary\) await rm[\s\S]{0,180}cleanupFailure/u,
  );
  assert.match(
    smoke,
    /finally\s*\{\s*process\.removeListener\("SIGINT"[\s\S]{0,120}process\.removeListener\("SIGTERM"/u,
  );
  assert.match(cleanup, /MAX_OUTPUT_BYTES/u);
  assert.match(cleanup, /appendBounded/u);
  assert.doesNotMatch(cleanup, /stdout\s*\+=\s*chunk|stderr\s*\+=\s*chunk/u);
});

async function source(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

function finalStage(dockerfile, name) {
  const marker = new RegExp(`^FROM \\S+ AS ${name}$`, "mu");
  const match = marker.exec(dockerfile);
  assert.ok(match, `missing ${name} stage`);
  const start = match.index;
  const remaining = dockerfile.slice(start + match[0].length);
  const nextStage = remaining.search(/^FROM\s+/mu);
  return dockerfile.slice(
    start,
    nextStage === -1 ? undefined : start + match[0].length + nextStage,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertDatabaseEnvironment(service, expected) {
  const names = Object.keys(service.environment ?? {}).filter(
    (name) => name === "DATABASE_URL" || /DATABASE_(?:ADMIN_)?URL$/u.test(name),
  );
  assert.deepEqual(names.sort(), [...expected].sort());
}

function fileURLPath(url) {
  return decodeURIComponent(url.pathname);
}
