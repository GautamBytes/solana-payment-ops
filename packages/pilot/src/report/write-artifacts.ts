import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
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
  let directoryHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryMetadata = await directoryHandle.stat();
    if (!directoryMetadata.isDirectory()) throw artifactError();

    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
    return {
      audience,
      format,
      path,
      contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(content, "utf8"),
    };
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (directoryHandle !== null)
      await directoryHandle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw artifactError();
  }
}

function artifactError(): PilotError {
  return new PilotError(
    "artifact_write_failed",
    "Audit artifact could not be written safely",
  );
}
