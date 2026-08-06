import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PaymentFixtureSchema } from "@payops/core";
import { describe, expect, it } from "vitest";
import { createCanonicalSnapshot, createParsingDigest } from "../src/index.js";

describe("createCanonicalSnapshot", () => {
  it("hashes objects independently of key insertion order", () => {
    const first = createCanonicalSnapshot({ b: 2, a: 1 });
    const second = createCanonicalSnapshot({ a: 1, b: 2 });

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.byteLength).toBe(
      Buffer.byteLength(first.canonicalJson, "utf8"),
    );
  });

  it("rejects values that JSON cannot preserve", () => {
    expect(() => createCanonicalSnapshot({ amount: 1n })).toThrow(
      "Snapshot is not JSON-compatible",
    );
  });

  it("hashes only fields that affect parsing", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
        import.meta.url,
      ),
    );
    const original = PaymentFixtureSchema.parse(
      JSON.parse(await readFile(fixturePath, "utf8")),
    ).rpcTransaction;
    const metadataOnly = structuredClone(original);
    metadataOnly.blockTime = (metadataOnly.blockTime ?? 0) + 1;
    Object.assign(metadataOnly.meta, { logMessages: ["provider-added"] });
    const changedInstruction = structuredClone(original);
    const instruction = changedInstruction.transaction.message.instructions[0];
    if (instruction === undefined) throw new Error("Expected instruction");
    instruction.data = "gX7kDtBjAyK58";

    expect(createParsingDigest(metadataOnly)).toBe(
      createParsingDigest(original),
    );
    expect(createParsingDigest(changedInstruction)).not.toBe(
      createParsingDigest(original),
    );
  });

  it("normalizes optional empty addresses and parser-irrelevant balance order", async () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
        import.meta.url,
      ),
    );
    const original = PaymentFixtureSchema.parse(
      JSON.parse(await readFile(fixturePath, "utf8")),
    ).rpcTransaction;
    const withoutLoadedAddresses = structuredClone(original);
    withoutLoadedAddresses.transaction.message.addressTableLookups = [];
    delete withoutLoadedAddresses.meta.loadedAddresses;
    const explicitEmptyAddresses = structuredClone(withoutLoadedAddresses);
    explicitEmptyAddresses.meta.loadedAddresses = {
      writable: [],
      readonly: [],
    };
    const reorderedBalances = structuredClone(original);
    reorderedBalances.meta.preTokenBalances.reverse();
    reorderedBalances.meta.postTokenBalances.reverse();

    expect(createParsingDigest(withoutLoadedAddresses)).toBe(
      createParsingDigest(explicitEmptyAddresses),
    );
    expect(createParsingDigest(reorderedBalances)).toBe(
      createParsingDigest(original),
    );
  });
});
