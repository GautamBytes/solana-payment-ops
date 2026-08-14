import { gzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_OCTAL_11 = 0o77777777777;

export function buildDeterministicTarGzip(entries, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_OCTAL_11) {
    throw new Error("Archive epoch must be a supported non-negative integer");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Archive entries must be a non-empty array");
  }

  const normalized = entries
    .map(({ name, bytes }) => ({ name, bytes: Buffer.from(bytes) }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  const names = new Set();
  const blocks = [];

  for (const { name, bytes } of normalized) {
    validateName(name);
    if (names.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
    names.add(name);
    if (bytes.length > MAX_OCTAL_11) {
      throw new Error(`Archive entry is too large: ${name}`);
    }

    blocks.push(buildHeader(name, bytes.length, epoch), bytes);
    const remainder = bytes.length % BLOCK_SIZE;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK_SIZE - remainder));
  }

  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function validateName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\0") ||
    name
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    !/^[\x20-\x7e]+$/.test(name) ||
    Buffer.byteLength(name) > 100
  ) {
    throw new Error(`Archive entry must use a safe relative path: ${name}`);
  }
}

function buildHeader(name, size, epoch) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, 0, 100, name, false);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, epoch);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0", false);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00", false);
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, encodedChecksum, false);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error("USTAR numeric field overflow");
  writeString(buffer, offset, length - 1, encoded, false);
  buffer[offset + length - 1] = 0;
}

function writeString(buffer, offset, length, value, terminate = true) {
  const bytes = Buffer.from(value, "ascii");
  const limit = terminate ? length - 1 : length;
  if (bytes.length > limit) throw new Error("USTAR string field overflow");
  bytes.copy(buffer, offset);
}
