import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { stringifyCanonical } from "../canonical-json.js";
import {
  FixtureManifestSchema,
  type FixtureManifest,
  type FixtureManifestCase,
} from "./manifest-schema.js";

export const MAX_FIXTURE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FIXTURE_CORPUS_BYTES = 64 * 1024 * 1024;

export type FixtureManifestErrorCode =
  | "invalid_manifest"
  | "unsafe_fixture_path"
  | "fixture_too_large"
  | "fixture_corpus_too_large"
  | "fixture_digest_mismatch";

export class FixtureManifestError extends Error {
  public readonly code: FixtureManifestErrorCode;

  public constructor(code: FixtureManifestErrorCode, message: string) {
    super(message);
    this.name = "FixtureManifestError";
    this.code = code;
  }
}

export interface LoadedFixtureCase {
  readonly definition: FixtureManifestCase;
  readonly absolutePath: string;
  readonly digest: string;
  readonly bytes: Buffer;
}

export interface LoadedFixtureManifest {
  readonly manifest: FixtureManifest;
  readonly manifestDigest: string;
  readonly canonicalJson: string;
  readonly cases: readonly LoadedFixtureCase[];
}

export async function loadFixtureManifest(
  manifestPath: string,
): Promise<LoadedFixtureManifest> {
  let bytes: Buffer;
  let manifest: FixtureManifest;
  try {
    bytes = await readBoundedFile(manifestPath, "invalid_manifest");
    manifest = FixtureManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof FixtureManifestError) throw error;
    throw new FixtureManifestError(
      "invalid_manifest",
      "Fixture manifest is invalid",
    );
  }

  const manifestDirectory = await realpath(dirname(resolve(manifestPath)));
  const cases: LoadedFixtureCase[] = [];
  const resolvedPaths = new Set<string>();
  let corpusBytes = 0;
  for (const definition of manifest.cases) {
    const loaded = await loadCase(manifestDirectory, definition);
    if (resolvedPaths.has(loaded.absolutePath)) {
      throw new FixtureManifestError(
        "invalid_manifest",
        "Fixture manifest resolves multiple cases to the same file",
      );
    }
    resolvedPaths.add(loaded.absolutePath);
    corpusBytes += loaded.bytes.byteLength;
    if (corpusBytes > MAX_FIXTURE_CORPUS_BYTES) {
      throw new FixtureManifestError(
        "fixture_corpus_too_large",
        "Fixture corpus exceeds 64 MiB",
      );
    }
    cases.push(loaded);
  }
  return {
    manifest,
    manifestDigest: digest(bytes),
    canonicalJson: stringifyCanonical(manifest),
    cases,
  };
}

async function loadCase(
  manifestDirectory: string,
  definition: FixtureManifestCase,
): Promise<LoadedFixtureCase> {
  if (!safeRelativePath(definition.file)) {
    throw unsafePath();
  }

  let absolutePath: string;
  try {
    absolutePath = await realpath(resolve(manifestDirectory, definition.file));
  } catch {
    throw unsafePath();
  }
  const relativePath = relative(manifestDirectory, absolutePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw unsafePath();
  }

  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(absolutePath, "fixture_too_large");
  } catch (error) {
    if (error instanceof FixtureManifestError) throw error;
    throw unsafePath();
  }
  const actualDigest = digest(bytes);
  if (actualDigest !== definition.sha256) {
    throw new FixtureManifestError(
      "fixture_digest_mismatch",
      "Fixture bytes do not match the manifest digest",
    );
  }
  return {
    definition,
    absolutePath,
    digest: actualDigest,
    bytes,
  };
}

async function readBoundedFile(
  path: string,
  tooLargeCode: "invalid_manifest" | "fixture_too_large",
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FixtureManifestError(tooLargeCode, "JSON input is not a file");
    }
    if (stats.size > MAX_FIXTURE_JSON_BYTES) {
      throw new FixtureManifestError(tooLargeCode, "JSON input exceeds 2 MiB");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_FIXTURE_JSON_BYTES) {
      throw new FixtureManifestError(tooLargeCode, "JSON input exceeds 2 MiB");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function safeRelativePath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path !== "." &&
    path !== ".." &&
    !path.startsWith("../") &&
    posix.normalize(path) === path
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unsafePath(): FixtureManifestError {
  return new FixtureManifestError(
    "unsafe_fixture_path",
    "Fixture path must resolve beneath the manifest directory",
  );
}
