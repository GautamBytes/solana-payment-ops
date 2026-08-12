import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const document = JSON.parse(
  await readFile(resolve(root, "openapi/payops-v1.json"), "utf8"),
);
if (document.openapi !== "3.1.0") fail("OpenAPI version must be 3.1.0");

const expectedStatuses = new Map([
  ["GET /health/live", ["200"]],
  ["GET /health/ready", ["200", "503"]],
  ["POST /v1/auth/bootstrap/accept", ["201", "400", "403"]],
  ["GET /v1/organization", ["200", "401", "429"]],
  ["GET /v1/customers", ["200", "400", "401", "403", "429"]],
  ["POST /v1/customers", ["201", "400", "401", "403", "409", "429"]],
  ["GET /v1/customers/{customerId}", ["200", "401", "403", "404", "429"]],
  ["GET /v1/invoices", ["200", "400", "401", "403", "429"]],
  ["POST /v1/invoices", ["201", "400", "401", "403", "404", "409", "429"]],
  ["GET /v1/invoices/{invoiceId}", ["200", "401", "403", "404", "429"]],
  [
    "POST /v1/invoices/{invoiceId}/issue",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/invoices/{invoiceId}/cancel",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/invoices/{invoiceId}/checkout-links",
    ["201", "400", "401", "403", "404", "429", "503"],
  ],
  [
    "POST /v1/invoices/{invoiceId}/payment-attempts",
    ["201", "400", "401", "403", "404", "409", "429", "503"],
  ],
  ["GET /pay/{checkoutToken}", ["200", "404", "429"]],
  [
    "POST /pay/{checkoutToken}/quotes",
    ["201", "400", "403", "404", "409", "429", "503"],
  ],
  ["GET /pay/{checkoutToken}/status", ["200", "304", "404", "429"]],
  ["GET /v1/merchant-wallets", ["200", "401", "403", "429"]],
  ["POST /v1/merchant-wallets", ["201", "400", "401", "403", "409", "429"]],
  ["POST /v1/merchant-wallets/challenges", ["201", "400", "401", "403", "429"]],
  [
    "POST /v1/merchant-wallets/{walletId}/replacement-challenges",
    ["201", "400", "401", "403", "404", "429"],
  ],
  [
    "POST /v1/merchant-wallets/{walletId}/replace",
    ["200", "202", "400", "401", "403", "404", "409", "429"],
  ],
  ["GET /v1/exceptions", ["200", "400", "401", "403", "429"]],
  [
    "GET /v1/exceptions/{exceptionId}/history",
    ["200", "401", "403", "404", "429"],
  ],
  [
    "POST /v1/exceptions/{exceptionId}/assign",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/exceptions/{exceptionId}/resolve",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/exceptions/{exceptionId}/investigate",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/exceptions/{exceptionId}/escalate",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/exceptions/{exceptionId}/reopen",
    ["200", "400", "401", "403", "404", "409", "429"],
  ],
  [
    "POST /v1/evidence-packs",
    ["201", "400", "401", "403", "404", "429", "503"],
  ],
  [
    "GET /v1/evidence-packs/{evidencePackId}",
    ["200", "401", "403", "404", "429"],
  ],
  [
    "GET /v1/evidence-packs/{evidencePackId}/verification",
    ["200", "401", "403", "404", "429"],
  ],
  ["POST /v1/exports", ["201", "400", "401", "403", "429"]],
  ["GET /v1/exports/{exportId}", ["200", "401", "403", "404", "429"]],
]);
const operations = new Map();
const operationIds = new Set();
for (const [path, item] of Object.entries(document.paths ?? {})) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const operation = item[method];
    if (operation === undefined) continue;
    const key = `${method.toUpperCase()} ${path}`;
    operations.set(key, operation);
    if (
      typeof operation.operationId !== "string" ||
      operationIds.has(operation.operationId)
    ) {
      fail(`Missing or duplicate operationId at ${key}`);
    }
    operationIds.add(operation.operationId);
  }
}
if (!sameSet(new Set(operations.keys()), new Set(expectedStatuses.keys()))) {
  fail("Documented route inventory does not match the merchant API inventory");
}

for (const [key, statuses] of expectedStatuses) {
  const operation = operations.get(key);
  if (
    !sameSet(new Set(Object.keys(operation.responses ?? {})), new Set(statuses))
  ) {
    fail(`${key} response status contract drift`);
  }
  for (const response of Object.values(operation.responses)) {
    const resolved = response.$ref
      ? document.components.responses[response.$ref.split("/").at(-1)]
      : response;
    if (resolved?.headers?.["X-Request-Id"] === undefined) {
      fail(`${key} response must expose X-Request-Id`);
    }
  }
}

for (const key of [
  "POST /v1/customers",
  "POST /v1/invoices",
  "POST /v1/invoices/{invoiceId}/issue",
  "POST /v1/invoices/{invoiceId}/cancel",
  "POST /v1/merchant-wallets",
  "POST /v1/merchant-wallets/{walletId}/replace",
  "POST /v1/exceptions/{exceptionId}/assign",
  "POST /v1/exceptions/{exceptionId}/resolve",
  "POST /v1/exceptions/{exceptionId}/investigate",
  "POST /v1/exceptions/{exceptionId}/escalate",
  "POST /v1/exceptions/{exceptionId}/reopen",
  "POST /v1/evidence-packs",
  "POST /v1/exports",
]) {
  const parameters = operations.get(key)?.parameters ?? [];
  if (
    !parameters.some(
      (parameter) =>
        parameter.$ref === "#/components/parameters/IdempotencyKey",
    )
  ) {
    fail(`${key} must require Idempotency-Key`);
  }
}
for (const key of [
  "GET /health/live",
  "GET /health/ready",
  "POST /v1/auth/bootstrap/accept",
  "GET /pay/{checkoutToken}",
  "POST /pay/{checkoutToken}/quotes",
  "GET /pay/{checkoutToken}/status",
]) {
  if (JSON.stringify(operations.get(key)?.security) !== "[]") {
    fail(`${key} must explicitly disable inherited authentication`);
  }
}
for (const key of [
  "GET /v1/customers",
  "GET /v1/invoices",
  "GET /v1/exceptions",
]) {
  const parameters = operations.get(key)?.parameters ?? [];
  for (const name of ["Limit", "Cursor"]) {
    if (
      !parameters.some(
        (parameter) => parameter.$ref === `#/components/parameters/${name}`,
      )
    ) {
      fail(`${key} must expose ${name}`);
    }
  }
}
for (const [schema, property] of [
  ["Customer", "externalId"],
  ["Customer", "email"],
  ["Invoice", "externalId"],
  ["Invoice", "issuedAt"],
  ["Invoice", "cancelledAt"],
  ["Invoice", "cancellationReason"],
]) {
  const value = document.components.schemas[schema].properties?.[property];
  if (!allowsNull(value)) {
    fail(`${schema}.${property} must explicitly allow null`);
  }
}

function allowsNull(schema) {
  return (
    (Array.isArray(schema?.type) && schema.type.includes("null")) ||
    schema?.anyOf?.some((entry) => entry.type === "null") === true
  );
}

function sameSet(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}
function fail(message) {
  throw new Error(message);
}
