import { createRequire } from "node:module";

const require = createRequire(
  "file:///workspace/packages/platform/package.json",
);
const postgres = require("postgres");

const checks = [
  [
    "PAYOPS_RUNTIME_DATABASE_URL",
    "CREATE TABLE forbidden_runtime_ddl (id integer)",
  ],
  ["PAYOPS_CONTROL_DATABASE_URL", "SELECT * FROM merchant_invoices LIMIT 1"],
  [
    "PAYOPS_READINESS_VERIFIER_DATABASE_URL",
    "UPDATE organization SET name = name",
  ],
  [
    "PAYOPS_SHADOW_PROJECTOR_DATABASE_URL",
    "INSERT INTO merchant_invoices DEFAULT VALUES",
  ],
];

for (const [name, statement] of checks) {
  const sql = postgres(required(name), { max: 1, onnotice: () => undefined });
  try {
    await expectPermissionDenied(sql, statement, name);
  } finally {
    await sql.end();
  }
}
process.stdout.write('{"status":"ok","roleSeparation":true}\n');

async function expectPermissionDenied(sql, statement, name) {
  try {
    await sql.unsafe(statement);
  } catch (error) {
    if (safeCode(error) === "42501") return;
    throw new Error(`unexpected_role_boundary_result:${name}`);
  }
  throw new Error(`role_boundary_not_enforced:${name}`);
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("missing_configuration");
  return value;
}

function safeCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : "unknown";
  } catch {
    return "unknown";
  }
}
