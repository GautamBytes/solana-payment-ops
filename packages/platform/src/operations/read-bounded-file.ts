import { open } from "node:fs/promises";

export async function readBoundedFile(
  path: string,
  maximumBytes: number,
  afterInitialStat: () => Promise<void> = async () => undefined,
): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw boundedFileError();
    }
    await afterInitialStat();
    const buffer = new Uint8Array(maximumBytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.size !== BigInt(offset) ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw boundedFileError();
    }
    return buffer.slice(0, offset);
  } finally {
    await handle.close();
  }
}

function boundedFileError(): Error & { readonly code: string } {
  return Object.assign(new Error("evidence_file_too_large"), {
    code: "evidence_file_too_large",
  });
}
