import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 65_536;
const repository = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = join(repository, "deploy/compose.yaml");
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
  const workerId = (await compose("ps", "--quiet", "worker")).trim();
  if (!/^[0-9a-f]{64}$/u.test(workerId))
    throw new Error("worker_container_missing");
  await compose("stop", "--timeout", "15", "worker");
  const exitCode = (
    await run("docker", [
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      workerId,
    ])
  ).trim();
  if (exitCode !== "0") throw new Error("worker_shutdown_failed");
  process.stdout.write(
    '{"status":"ok","images":4,"roleSeparation":true,"gracefulShutdown":true}\n',
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
