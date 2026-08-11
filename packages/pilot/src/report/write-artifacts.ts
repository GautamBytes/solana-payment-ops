import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PilotError, type AuditArtifact } from "../domain/types.js";

export async function writeAuditArtifact(
  path: string,
  audience: AuditArtifact["audience"],
  format: AuditArtifact["format"],
  content: string,
): Promise<AuditArtifact> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.payops-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const directoryMetadata = await lstat(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw artifactError();
    }
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw artifactError();
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        // A missing target is the normal first-write case.
      } else {
        throw error;
      }
    }

    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return {
      audience,
      format,
      path,
      contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(content, "utf8"),
    };
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw artifactError();
  }
}

function isMissingPathError(error: unknown): boolean {
  try {
    const descriptor =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    return descriptor !== undefined && descriptor.value === "ENOENT";
  } catch {
    return false;
  }
}

function artifactError(): PilotError {
  return new PilotError(
    "artifact_write_failed",
    "Audit artifact could not be written safely",
  );
}
