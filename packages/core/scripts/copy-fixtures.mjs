import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../../../fixtures/v0.1/", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../dist/fixtures/v0.1/", import.meta.url),
);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
