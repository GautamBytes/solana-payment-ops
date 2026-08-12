import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedFile } from "../src/operations/read-bounded-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readBoundedFile", () => {
  it("reads exactly the byte ceiling without allocating beyond it", async () => {
    const path = await fixture("1234");
    await expect(readBoundedFile(path, 4)).resolves.toEqual(
      new TextEncoder().encode("1234"),
    );
  });

  it("fails closed when the file grows after its initial stat", async () => {
    const path = await fixture("1234");
    await expect(
      readBoundedFile(path, 4, async () => appendFile(path, "5")),
    ).rejects.toMatchObject({ code: "evidence_file_too_large" });
  });

  it("fails closed when the file grows and returns to its original size", async () => {
    const path = await fixture("1234");
    await expect(
      readBoundedFile(path, 4, async () => {
        await appendFile(path, "5");
        await truncate(path, 4);
      }),
    ).rejects.toMatchObject({ code: "evidence_file_too_large" });
  });
});

async function fixture(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "payops-bounded-file-"));
  directories.push(directory);
  const path = join(directory, "evidence.bin");
  await writeFile(path, contents);
  return path;
}
