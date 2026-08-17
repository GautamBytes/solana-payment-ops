import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 65_536;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = join(repository, "deploy/compose.yaml");
const postgresImage =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const shutdown = new AbortController();
let interruptedExitCode;
const interrupt = (signal) => {
  if (shutdown.signal.aborted) return;
  interruptedExitCode = signal === "SIGINT" ? 130 : 143;
  shutdown.abort(new Error("smoke_interrupted"));
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

let temporary;
let project;
let environmentFile;
let failed = false;
let failure;
let cleanupFailure;
let restoreContainerName;

try {
  temporary = await mkdtemp(join(tmpdir(), "payops-smoke-"));
  shutdown.signal.throwIfAborted();
  project =
    process.env.PAYOPS_SMOKE_PROJECT ??
    `payops-smoke-${process.pid}-${randomBytes(4).toString("hex")}`;
  if (!/^payops-(?:ci-)?smoke(?:-[a-z0-9-]{1,48})?$/u.test(project)) {
    throw new Error("invalid_smoke_project");
  }
  environmentFile = join(temporary, "smoke.env");
  const apiPort = await availablePort();
  const webPort = await availablePort();
  await createCertificate(temporary);
  const values = smokeEnvironment({ temporary, apiPort, webPort });
  await writeFile(
    environmentFile,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  const compose = (...arguments_) =>
    run("docker", [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      project,
      "--file",
      composeFile,
      ...arguments_,
    ]);

  await compose("config", "--quiet");
  await compose("up", "--detach", "postgres", "upstreams");
  await compose("run", "--rm", "--no-deps", "role-bootstrap");
  await compose("run", "--rm", "--no-deps", "migrate");
  await compose("run", "--rm", "--no-deps", "migrate");
  restoreContainerName = `${project}-restore`;
  const backupRestore = await assertBackupRestore({
    compose,
    project,
    restoreContainerName,
    temporary,
    values,
  });
  await compose("up", "--detach", "--no-deps", "worker", "api");
  await waitFor(`http://127.0.0.1:${apiPort}/health/live`, 200, 90_000);
  await waitFor(`http://127.0.0.1:${apiPort}/health/ready`, 200, 90_000);
  await compose("up", "--detach", "--no-deps", "web");
  await waitFor(`http://127.0.0.1:${webPort}/health/live`, 200, 60_000);
  await waitFor(`http://127.0.0.1:${webPort}/health/ready`, 200, 60_000);

  await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    "payops-migrate:local",
    "-c",
    "test ! -e /workspace/apps/api && test ! -e /workspace/apps/worker",
  ]);
  await run("docker", roleAssertionArguments(project, values));
  await assertRuntimeEnvironment(compose);
  const initialWorkerId = (await compose("ps", "--quiet", "worker")).trim();
  if (!/^[0-9a-f]{64}$/u.test(initialWorkerId))
    throw new Error("worker_container_missing");
  await compose("stop", "--timeout", "15", "worker");
  await waitForConsecutiveStatuses(
    `http://127.0.0.1:${apiPort}/health/ready`,
    503,
    2,
    60_000,
  );
  await assertContainerExitCode(initialWorkerId, "worker_shutdown_failed");
  await compose("up", "--detach", "--no-deps", "worker");
  await waitForConsecutiveStatuses(
    `http://127.0.0.1:${apiPort}/health/ready`,
    200,
    2,
    60_000,
  );
  const incidentRecovery = true;
  const recoveredWorkerId = (await compose("ps", "--quiet", "worker")).trim();
  if (!/^[0-9a-f]{64}$/u.test(recoveredWorkerId))
    throw new Error("recovered_worker_container_missing");
  await compose("stop", "--timeout", "15", "worker");
  await assertContainerExitCode(recoveredWorkerId, "worker_shutdown_failed");
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      images: 4,
      roleSeparation: true,
      backupRestore,
      incidentRecovery,
      gracefulShutdown: true,
    })}\n`,
  );
} catch (error) {
  failed = true;
  failure = error;
  if (!shutdown.signal.aborted) {
    process.stderr.write(`container_smoke_failed:${safeMessage(error)}\n`);
    try {
      await run(
        "docker",
        [
          "compose",
          "--env-file",
          environmentFile,
          "--project-name",
          project,
          "--file",
          composeFile,
          "logs",
          "--no-color",
          "--tail",
          "200",
        ],
        { signal: undefined },
      );
    } catch {
      // The original bounded failure is authoritative.
    }
  }
} finally {
  if (restoreContainerName) {
    try {
      await removeRestoreContainer(restoreContainerName);
    } catch {
      cleanupFailure = new Error("smoke_restore_cleanup_failed");
    }
  }
  if (project && environmentFile) {
    try {
      await run(
        "docker",
        [
          "compose",
          "--env-file",
          environmentFile,
          "--project-name",
          project,
          "--file",
          composeFile,
          "down",
          "--volumes",
          "--remove-orphans",
          "--timeout",
          "15",
        ],
        { signal: undefined },
      );
    } catch (error) {
      cleanupFailure = new Error("smoke_cleanup_failed");
    }
  }
  try {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  } catch {
    cleanupFailure = new Error("smoke_cleanup_failed");
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (cleanupFailure) throw cleanupFailure;
else if (interruptedExitCode !== undefined)
  process.exitCode = interruptedExitCode;
else if (failure) throw failure;

async function assertContainerExitCode(containerId, failureCode) {
  const exitCode = (
    await run("docker", [
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      containerId,
    ])
  ).trim();
  if (exitCode !== "0") throw new Error(failureCode);
}

async function assertBackupRestore({
  compose,
  project,
  restoreContainerName: target,
  temporary,
  values,
}) {
  if (!/^payops-(?:ci-)?smoke(?:-[a-z0-9-]{1,48})?-restore$/u.test(target)) {
    throw new Error("invalid_restore_container");
  }
  const source = (await compose("ps", "--quiet", "postgres")).trim();
  if (!/^[0-9a-f]{64}$/u.test(source))
    throw new Error("source_database_container_missing");

  const backupPath = join(temporary, "payops-smoke.dump");
  const marker = `recovery-${randomBytes(12).toString("hex")}`;
  const restorePassword = randomBytes(32).toString("hex");
  const restoreDatabase = "payops_restore";
  const psql = (container, role, database, sql, password) =>
    run("docker", [
      "exec",
      "--env",
      `PGPASSWORD=${password}`,
      container,
      "psql",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--username",
      role,
      "--dbname",
      database,
      "--command",
      sql,
    ]);

  await psql(
    source,
    values.PAYOPS_DATABASE_ADMIN_ROLE,
    values.PAYOPS_DATABASE_NAME,
    `CREATE TABLE IF NOT EXISTS payops.smoke_recovery_marker (value text PRIMARY KEY); INSERT INTO payops.smoke_recovery_marker (value) VALUES ('${marker}');`,
    values.PAYOPS_DATABASE_ADMIN_PASSWORD,
  );
  await runToFile(
    "docker",
    [
      "exec",
      "--env",
      `PGPASSWORD=${values.PAYOPS_DATABASE_ADMIN_PASSWORD}`,
      source,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--username",
      values.PAYOPS_DATABASE_ADMIN_ROLE,
      "--dbname",
      values.PAYOPS_DATABASE_NAME,
    ],
    backupPath,
  );
  const backupSha256 = createHash("sha256")
    .update(await readFile(backupPath))
    .digest("hex");
  if (!/^[0-9a-f]{64}$/u.test(backupSha256))
    throw new Error("backup_digest_invalid");

  try {
    await run("docker", [
      "run",
      "--detach",
      "--name",
      target,
      "--network",
      `${project}_payops`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/run/postgresql:rw,nosuid,size=16m",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,size=512m",
      "--env",
      "POSTGRES_USER=payops_restore_admin",
      "--env",
      `POSTGRES_PASSWORD=${restorePassword}`,
      "--env",
      `POSTGRES_DB=${restoreDatabase}`,
      postgresImage,
    ]);
    await waitForDatabase(target, "payops_restore_admin", restoreDatabase);
    await runFromFile(
      "docker",
      [
        "exec",
        "--interactive",
        "--env",
        `PGPASSWORD=${restorePassword}`,
        target,
        "pg_restore",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--username",
        "payops_restore_admin",
        "--dbname",
        restoreDatabase,
      ],
      backupPath,
    );

    const ledgerQuery =
      "SET search_path TO payops; SELECT name || ':' || COALESCE(checksum_sha256, '') FROM payops_schema_migrations ORDER BY name;";
    const sourceLedger = await psql(
      source,
      values.PAYOPS_DATABASE_ADMIN_ROLE,
      values.PAYOPS_DATABASE_NAME,
      ledgerQuery,
      values.PAYOPS_DATABASE_ADMIN_PASSWORD,
    );
    const targetLedger = await psql(
      target,
      "payops_restore_admin",
      restoreDatabase,
      ledgerQuery,
      restorePassword,
    );
    if (sourceLedger.trim() !== targetLedger.trim())
      throw new Error("restored_migration_ledger_mismatch");
    const restoredMarker = await psql(
      target,
      "payops_restore_admin",
      restoreDatabase,
      `SELECT value FROM payops.smoke_recovery_marker WHERE value = '${marker}';`,
      restorePassword,
    );
    if (restoredMarker.trim() !== marker)
      throw new Error("restored_marker_mismatch");
  } finally {
    await removeRestoreContainer(target);
  }
  return true;
}

async function waitForDatabase(container, role, database) {
  const deadline = Date.now() + 30_000;
  let readyCount = 0;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    try {
      await run("docker", [
        "exec",
        container,
        "pg_isready",
        "--username",
        role,
        "--dbname",
        database,
      ]);
      readyCount += 1;
      if (readyCount >= 3) return;
    } catch (error) {
      if (shutdown.signal.aborted) throw error;
      readyCount = 0;
    }
    await delay(500, undefined, { signal: shutdown.signal });
  }
  throw new Error("restore_database_deadline_exceeded");
}

async function removeRestoreContainer(container) {
  if (!/^payops-(?:ci-)?smoke(?:-[a-z0-9-]{1,48})?-restore$/u.test(container)) {
    throw new Error("invalid_restore_container");
  }
  const present = (
    await run(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `name=^/${container}$`],
      { signal: undefined },
    )
  ).trim();
  if (present !== "") {
    if (!/^[0-9a-f]{12,64}$/u.test(present))
      throw new Error("invalid_restore_container_id");
    await run("docker", ["rm", "--force", container], { signal: undefined });
  }
}

function smokeEnvironment({ temporary, apiPort, webPort }) {
  const password = () => randomBytes(32).toString("hex");
  const admin = password();
  const migrator = password();
  const runtime = password();
  const control = password();
  const verifier = password();
  const projector = password();
  const database = "payops_smoke";
  const url = (role, secret) =>
    `postgresql://${role}:${secret}@postgres:5432/${database}?options=-c%20search_path%3Dpayops`;
  const evidenceKey = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  return {
    PAYOPS_DATABASE_NAME: database,
    PAYOPS_DATABASE_ADMIN_ROLE: "payops_smoke_admin",
    PAYOPS_DATABASE_ADMIN_PASSWORD: admin,
    PAYOPS_DATABASE_ADMIN_URL: url("payops_smoke_admin", admin),
    PAYOPS_MIGRATOR_ROLE: "payops_smoke_migrator",
    PAYOPS_MIGRATOR_PASSWORD: migrator,
    PAYOPS_MIGRATOR_DATABASE_URL: url("payops_smoke_migrator", migrator),
    PAYOPS_RUNTIME_ROLE: "payops_smoke_runtime",
    PAYOPS_RUNTIME_PASSWORD: runtime,
    PAYOPS_RUNTIME_DATABASE_URL: url("payops_smoke_runtime", runtime),
    PAYOPS_CONTROL_ROLE: "payops_smoke_control",
    PAYOPS_CONTROL_PASSWORD: control,
    PAYOPS_CONTROL_DATABASE_URL: url("payops_smoke_control", control),
    PAYOPS_READINESS_VERIFIER_ROLE: "payops_smoke_verifier",
    PAYOPS_READINESS_VERIFIER_PASSWORD: verifier,
    PAYOPS_READINESS_VERIFIER_DATABASE_URL: url(
      "payops_smoke_verifier",
      verifier,
    ),
    PAYOPS_SHADOW_PROJECTOR_ROLE: "payops_smoke_projector",
    PAYOPS_SHADOW_PROJECTOR_PASSWORD: projector,
    PAYOPS_SHADOW_PROJECTOR_DATABASE_URL: url(
      "payops_smoke_projector",
      projector,
    ),
    PAYOPS_SMOKE_SECRET_DIRECTORY: temporary,
    PAYOPS_SMOKE_API_PORT: String(apiPort),
    PAYOPS_SMOKE_WEB_PORT: String(webPort),
    PAYOPS_PUBLIC_API_ORIGIN: "https://api.payops.test",
    PAYOPS_CHECKOUT_ORIGIN: "https://web.payops.test",
    PAYOPS_WEB_ORIGIN: "https://web.payops.test",
    PAYOPS_TRUSTED_ORIGINS: "https://web.payops.test",
    PAYOPS_WALLET_PROOF_DOMAIN: "payops.test",
    PAYOPS_RPC_PRIMARY_PROVIDER_ID: "smoke-primary",
    PAYOPS_PRIMARY_SOLANA_RPC_URL: "https://upstreams/rpc-primary",
    PAYOPS_RPC_SECONDARY_PROVIDER_ID: "smoke-secondary",
    PAYOPS_SECONDARY_SOLANA_RPC_URL: "https://upstreams/rpc-secondary",
    PAYOPS_PUBLIC_ANALYSIS_ENABLED: "false",
    PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET:
      randomBytes(32).toString("base64url"),
    PAYOPS_PUBLIC_ANALYSIS_CLIENT_LIMIT: "5",
    PAYOPS_PUBLIC_ANALYSIS_GLOBAL_LIMIT: "100",
    PAYOPS_PUBLIC_ANALYSIS_WINDOW_SECONDS: "60",
    PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED: "false",
    BETTER_AUTH_SECRETS: `${randomBytes(32).toString("base64url")},${randomBytes(32).toString("base64url")}`,
    PAYOPS_CHECKOUT_TOKEN_KEYS: `smoke-v1:${randomBytes(32).toString("base64url")}`,
    PAYOPS_PYTH_HERMES_ENDPOINT: "https://upstreams/pyth",
    PAYOPS_PYTH_ACCESS_TOKEN: randomBytes(32).toString("hex"),
    PAYOPS_PYTH_USDC_FEED_ID: "a".repeat(64),
    PAYOPS_PYTH_USDT_FEED_ID: "b".repeat(64),
    PAYOPS_ECB_ENDPOINT: "https://upstreams/fx",
    PAYOPS_AUTH_EMAIL_ENDPOINT: "https://upstreams/email",
    PAYOPS_AUTH_EMAIL_TOKEN: randomBytes(32).toString("hex"),
    PAYOPS_EVIDENCE_SIGNING_KEY_ID: "smoke-evidence-v1",
    PAYOPS_EVIDENCE_SIGNING_PRIVATE_KEY_B64:
      Buffer.from(evidenceKey).toString("base64"),
    PAYOPS_PARSER_VERSION: "0.2.0",
    PAYOPS_BUILD_REVISION: "smoke",
    PAYOPS_WORKER_INTERVAL_MS: "250",
    PAYOPS_WORKER_BATCH_SIZE: "10",
    PAYOPS_WORKER_CONCURRENCY: "2",
    PAYOPS_WORKER_LEASE_MS: "5000",
  };
}

function roleAssertionArguments(project, values) {
  const names = [
    "PAYOPS_RUNTIME_DATABASE_URL",
    "PAYOPS_CONTROL_DATABASE_URL",
    "PAYOPS_READINESS_VERIFIER_DATABASE_URL",
    "PAYOPS_SHADOW_PROJECTOR_DATABASE_URL",
  ];
  return [
    "run",
    "--rm",
    "--network",
    `${project}_payops`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${join(repository, "deploy/smoke")}:/smoke:ro`,
    ...names.flatMap((name) => ["--env", `${name}=${values[name]}`]),
    "--entrypoint",
    "node",
    "payops-migrate:local",
    "/smoke/assert-role-separation.mjs",
  ];
}

async function assertRuntimeEnvironment(compose) {
  for (const service of ["api", "worker"]) {
    const id = (await compose("ps", "--quiet", service)).trim();
    const environment = await run("docker", [
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      id,
    ]);
    if (
      /PAYOPS_DATABASE_ADMIN_URL|PAYOPS_MIGRATOR_DATABASE_URL/u.test(
        environment,
      )
    ) {
      throw new Error("runtime_received_elevated_database_url");
    }
  }
}

async function createCertificate(directory) {
  const configuration = `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3_req\n[dn]\nCN=upstreams\n[v3_req]\nsubjectAltName=@alt\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n[alt]\nDNS.1=upstreams\n`;
  await writeFile(join(directory, "openssl.cnf"), configuration, {
    mode: 0o600,
  });
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(directory, "tls.key"),
    "-out",
    join(directory, "tls.crt"),
    "-config",
    join(directory, "openssl.cnf"),
    "-extensions",
    "v3_req",
  ]);
  await writeFile(
    join(directory, "ca.crt"),
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(directory, "tls.crt")),
    ),
    { mode: 0o600 },
  );
}

async function waitFor(url, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2_000)]),
      });
      if (response.status === expectedStatus) return;
    } catch (error) {
      if (shutdown.signal.aborted) throw error;
      // Retry within the bounded deadline.
    }
    await delay(500, undefined, { signal: shutdown.signal });
  }
  throw new Error(`health_deadline_exceeded:${new URL(url).pathname}`);
}

async function waitForConsecutiveStatuses(
  url,
  expectedStatus,
  requiredCount,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(2_000)]),
      });
      observed = response.status === expectedStatus ? observed + 1 : 0;
      if (observed >= requiredCount) return;
    } catch (error) {
      if (shutdown.signal.aborted) throw error;
      observed = 0;
    }
    await delay(500, undefined, { signal: shutdown.signal });
  }
  throw new Error(
    `consecutive_health_deadline_exceeded:${new URL(url).pathname}:${expectedStatus}`,
  );
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port < 1) throw new Error("port_allocation_failed");
  return port;
}

async function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = Object.hasOwn(options, "signal")
      ? options.signal
      : shutdown.signal;
    const child = spawn(command, arguments_, {
      cwd: repository,
      env: process.env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(shutdown.signal.aborted ? new Error("smoke_interrupted") : error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout.toString("utf8"));
      else
        reject(
          new Error(
            `${command}_failed_${code}:${stderr.subarray(-2_000).toString("utf8")}`,
          ),
        );
    });
  });
}

async function runToFile(command, arguments_, path) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repository,
      env: process.env,
      signal: shutdown.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = createWriteStream(path, { mode: 0o600 });
    let stderr = Buffer.alloc(0);
    let settled = false;
    let childCode;
    let outputClosed = false;
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(shutdown.signal.aborted ? new Error("smoke_interrupted") : error);
    };
    const finish = () => {
      if (settled || childCode === undefined || !outputClosed) return;
      if (childCode !== 0) {
        fail(
          new Error(
            `${command}_failed_${childCode}:${stderr.subarray(-2_000).toString("utf8")}`,
          ),
        );
        return;
      }
      settled = true;
      resolve();
    };
    child.once("error", fail);
    output.once("error", fail);
    output.once("close", () => {
      outputClosed = true;
      finish();
    });
    child.once("close", (code) => {
      childCode = code;
      finish();
    });
  });
}

async function runFromFile(command, arguments_, path) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repository,
      env: process.env,
      signal: shutdown.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const input = createReadStream(path);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    input.pipe(child.stdin);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      reject(shutdown.signal.aborted ? new Error("smoke_interrupted") : error);
    };
    input.once("error", fail);
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      input.destroy();
      if (code === 0) resolve(stdout.toString("utf8"));
      else
        reject(
          new Error(
            `${command}_failed_${code}:${stderr.subarray(-2_000).toString("utf8")}`,
          ),
        );
    });
  });
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return Buffer.concat([
    current,
    bytes.subarray(0, MAX_OUTPUT_BYTES - current.length),
  ]);
}

function safeMessage(error) {
  return error instanceof Error
    ? error.message
        .replaceAll(/postgresql:\/\/[^\s@]+@/gu, "postgresql://[redacted]@")
        .slice(0, 2_000)
    : "unknown";
}
