import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const productionDirectories = ["app", "components", "lib"];
const sourceExtensions = new Set([".ts", ".tsx"]);
const emDash = String.fromCodePoint(0x2014);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

describe("website copy style", () => {
  it("does not use em dashes in production website source", () => {
    const filesWithEmDashes = productionDirectories
      .flatMap((directory) => sourceFiles(join(websiteRoot, directory)))
      .filter((path) => readFileSync(path, "utf8").includes(emDash))
      .map((path) => path.slice(websiteRoot.length + 1));

    expect(filesWithEmDashes).toEqual([]);
  });
});
