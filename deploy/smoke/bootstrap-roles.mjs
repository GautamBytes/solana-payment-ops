import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  "file:///workspace/packages/platform/package.json",
);
const postgres = require("postgres");
const { bootstrapProductionDatabaseRoles } =
  await import("file:///workspace/packages/platform/dist/index.js");

const roles = {
  migrator: required("PAYOPS_MIGRATOR_ROLE"),
  runtime: required("PAYOPS_RUNTIME_ROLE"),
  control: required("PAYOPS_CONTROL_ROLE"),
  readinessVerifier: required("PAYOPS_READINESS_VERIFIER_ROLE"),
  shadowProjector: required("PAYOPS_SHADOW_PROJECTOR_ROLE"),
};
const substitutions = {
  __ADMIN_ROLE__: required("PAYOPS_DATABASE_ADMIN_ROLE"),
  __MIGRATOR_ROLE__: roles.migrator,
  __MIGRATOR_PASSWORD__: password("PAYOPS_MIGRATOR_PASSWORD"),
  __RUNTIME_ROLE__: roles.runtime,
  __RUNTIME_PASSWORD__: password("PAYOPS_RUNTIME_PASSWORD"),
  __CONTROL_ROLE__: roles.control,
  __CONTROL_PASSWORD__: password("PAYOPS_CONTROL_PASSWORD"),
  __VERIFIER_ROLE__: roles.readinessVerifier,
  __VERIFIER_PASSWORD__: password("PAYOPS_READINESS_VERIFIER_PASSWORD"),
  __PROJECTOR_ROLE__: roles.shadowProjector,
  __PROJECTOR_PASSWORD__: password("PAYOPS_SHADOW_PROJECTOR_PASSWORD"),
};
let source = await readFile("/smoke/create-principals.sql", "utf8");
for (const [placeholder, value] of Object.entries(substitutions)) {
  source = source.replaceAll(placeholder, value);
}
if (/__[A-Z_]+__/u.test(source))
  throw new Error("principal_template_incomplete");
const adminUrl = requiredValue("PAYOPS_DATABASE_ADMIN_URL");
const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
try {
  await sql.unsafe(source);
} finally {
  await sql.end();
}
const result = await bootstrapProductionDatabaseRoles(adminUrl, roles);
process.stdout.write(`${JSON.stringify({ status: "ok", roles: result })}\n`);

function required(name) {
  const value = Object.hasOwn(process.env, name)
    ? process.env[name]
    : undefined;
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("invalid_smoke_role_configuration");
  }
  return value;
}

function password(name) {
  const value = Object.hasOwn(process.env, name)
    ? process.env[name]
    : undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("invalid_smoke_password_configuration");
  }
  return value;
}

function requiredValue(name) {
  const value = Object.hasOwn(process.env, name)
    ? process.env[name]
    : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing_smoke_configuration");
  }
  return value;
}
