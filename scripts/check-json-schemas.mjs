import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonSchemas } from "../packages/contracts/dist/index.js";

const files = [
  "audit-report.v0.1.schema.json",
  "lifecycle-event.v0.1.schema.json",
  "payment-fixture.v0.1.schema.json",
  "webhook-request.v0.1.schema.json",
];
const outputDirectory = await mkdtemp(join(tmpdir(), "payops-schema-check-"));

try {
  await writeJsonSchemas(outputDirectory);
  const checkedInDirectory = resolve("packages/contracts/schemas");
  const drift = [];
  for (const file of files) {
    const [generated, checkedIn] = await Promise.all([
      readFile(join(outputDirectory, file), "utf8"),
      readFile(join(checkedInDirectory, file), "utf8"),
    ]);
    if (generated !== checkedIn) drift.push(file);
  }
  if (drift.length > 0) {
    throw new Error(`JSON Schema drift: ${drift.join(", ")}`);
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
