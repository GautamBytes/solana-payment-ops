import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const canonicalFixturePath = fileURLToPath(
  new URL(
    "../../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

export const temporaryDirectories: string[] = [];

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "payops-manifest-"));
  temporaryDirectories.push(directory);
  return directory;
}

export async function copyCanonicalFixture(
  directory: string,
  file = "canonical.json",
): Promise<{ readonly file: string; readonly sha256: string }> {
  await mkdir(directory, { recursive: true });
  const destination = join(directory, file);
  await copyFile(canonicalFixturePath, destination);
  return { file, sha256: await digestFile(destination) };
}

export function validCase(
  fixture: { readonly file: string; readonly sha256: string },
  id = "canonical-finalized-payment",
) {
  return {
    id,
    file: fixture.file,
    sha256: fixture.sha256,
    kind: "payment",
    tags: ["transfer_checked", "versioned"],
    expected: {
      outcome: "pass",
      eventCount: 1,
      verifiedCount: 1,
      eventIds: [
        "mainnet-beta:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T:0:outer",
      ],
      verificationCodes: [],
      exceptionCode: null,
    },
  } as const;
}

export async function writeManifest(
  directory: string,
  cases: readonly Record<string, unknown>[],
): Promise<string> {
  const path = join(directory, "manifest.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        schemaVersion: "0.1",
        generatedAt: "2026-08-11T00:00:00.000Z",
        cases,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return path;
}

export async function writeFixture(
  directory: string,
  file: string,
  contents: string | Buffer,
): Promise<{ readonly file: string; readonly sha256: string }> {
  const path = join(directory, file);
  await writeFile(path, contents);
  return { file, sha256: await digestFile(path) };
}

async function digestFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
