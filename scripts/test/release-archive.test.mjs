import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { buildDeterministicTarGzip } from "../release-archive.mjs";

const BLOCK_SIZE = 512;

describe("release evidence archive", () => {
  it("produces deterministic sorted USTAR entries with normalized metadata", () => {
    const epoch = 1_700_000_000;
    const entries = [
      { name: "schemas/z.json", bytes: Buffer.from("z\n") },
      { name: "schemas/a.json", bytes: Buffer.from("a\n") },
    ];

    const first = buildDeterministicTarGzip(entries, epoch);
    const second = buildDeterministicTarGzip(entries.toReversed(), epoch);

    assert.deepEqual(first, second);
    assert.deepEqual([...first.subarray(4, 8)], [0, 0, 0, 0]);

    const archive = gunzipSync(first);
    const parsed = parseTar(archive);
    assert.deepEqual(
      parsed.map(({ name, bytes }) => [name, bytes.toString("utf8")]),
      [
        ["schemas/a.json", "a\n"],
        ["schemas/z.json", "z\n"],
      ],
    );
    for (const entry of parsed) {
      assert.equal(entry.mode, 0o644);
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
      assert.equal(entry.mtime, epoch);
      assert.equal(entry.uname, "root");
      assert.equal(entry.gname, "root");
      assert.equal(entry.magic, "ustar");
      assert.equal(entry.checksumValid, true);
    }
    assert.equal(archive.length % BLOCK_SIZE, 0);
    assert.deepEqual(
      archive.subarray(-BLOCK_SIZE * 2),
      Buffer.alloc(BLOCK_SIZE * 2),
    );
  });

  it("rejects unsafe names, duplicates, and invalid timestamps", () => {
    const valid = { name: "schemas/a.json", bytes: Buffer.from("{}") };

    assert.throws(
      () => buildDeterministicTarGzip([{ ...valid, name: "../a" }], 1),
      /safe relative path/i,
    );
    assert.throws(
      () => buildDeterministicTarGzip([valid, valid], 1),
      /duplicate/i,
    );
    assert.throws(
      () => buildDeterministicTarGzip([valid], Number.NaN),
      /epoch/i,
    );
  });
});

function parseTar(archive) {
  const entries = [];
  let offset = 0;
  while (
    !archive
      .subarray(offset, offset + BLOCK_SIZE)
      .equals(Buffer.alloc(BLOCK_SIZE))
  ) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    const size = readOctal(header, 124, 12);
    const contentStart = offset + BLOCK_SIZE;
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    entries.push({
      name: readString(header, 0, 100),
      mode: readOctal(header, 100, 8),
      uid: readOctal(header, 108, 8),
      gid: readOctal(header, 116, 8),
      mtime: readOctal(header, 136, 12),
      uname: readString(header, 265, 32),
      gname: readString(header, 297, 32),
      magic: readString(header, 257, 6),
      checksumValid:
        readOctal(header, 148, 8) ===
        checksumHeader.reduce((sum, byte) => sum + byte, 0),
      bytes: archive.subarray(contentStart, contentStart + size),
    });
    offset = contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

function readString(buffer, offset, length) {
  return buffer
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function readOctal(buffer, offset, length) {
  return Number.parseInt(readString(buffer, offset, length).trim(), 8);
}
