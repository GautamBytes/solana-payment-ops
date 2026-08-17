import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePilotManifest,
  PilotError,
} from "../src/manifest/parse-manifest.js";

const tokenAccount = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const csv = [
  "invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at",
  "invoice-001,customer-001,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM,12500000,Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4,2026-08-01T00:00:00Z,2026-08-15T00:00:00Z",
  "",
].join("\n");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parsePilotManifest", () => {
  it("validates the published synthetic example", async () => {
    const manifestUrl = new URL(
      "../examples/manifest.v0.1.json",
      import.meta.url,
    );
    const raw = await readFile(manifestUrl, "utf8");

    const parsed = await parsePilotManifest(
      raw,
      fileURLToPath(new URL("../examples/", import.meta.url)),
    );

    expect(parsed.manifest.schemaVersion).toBe("0.1");
    expect(parsed.manifest.provider.cluster).toBe("mainnet-beta");
    expect(parsed.invoiceCsvPath).toBe(
      fileURLToPath(new URL("../examples/invoices.csv", import.meta.url)),
    );
  });

  it("validates the exact manifest and resolves its digest-checked CSV", async () => {
    const fixture = await createFixture();

    const parsed = await parsePilotManifest(
      JSON.stringify(fixture.manifest),
      fixture.directory,
    );

    expect(parsed.manifest).toEqual(fixture.manifest);
    expect(parsed.invoiceCsvPath).toBe(await realpath(fixture.csvPath));
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(parsed.canonicalJson)).toEqual(fixture.manifest);
  });

  it("produces the same canonical digest for different object-key order", async () => {
    const fixture = await createFixture();
    const reversed = Object.fromEntries(
      Object.entries(fixture.manifest).reverse(),
    );

    const first = await parsePilotManifest(
      JSON.stringify(fixture.manifest),
      fixture.directory,
    );
    const second = await parsePilotManifest(
      JSON.stringify(reversed),
      fixture.directory,
    );

    expect(second.canonicalJson).toBe(first.canonicalJson);
    expect(second.digest).toBe(first.digest);
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
  ])("rejects %s with a bounded typed error", async (_name, raw) => {
    const fixture = await createFixture();

    await expect(parsePilotManifest(raw, fixture.directory)).rejects.toEqual(
      expect.objectContaining({
        name: "PilotError",
        code: "invalid_manifest",
        message: "Pilot manifest is invalid",
      }),
    );
  });

  it.each([
    [
      "an unknown key",
      (value: Record<string, unknown>) => ({ ...value, extra: true }),
    ],
    [
      "a missing key",
      (value: Record<string, unknown>) => {
        const { finality: _finality, ...rest } = value;
        return rest;
      },
    ],
    [
      "a non-mainnet cluster",
      (value: Record<string, any>) => ({
        ...value,
        provider: { ...value.provider, cluster: "devnet" },
      }),
    ],
    [
      "a duplicate watch ID",
      (value: Record<string, any>) => ({
        ...value,
        watches: [...value.watches, { ...value.watches[0] }],
      }),
    ],
    [
      "a duplicate token account",
      (value: Record<string, any>) => ({
        ...value,
        watches: [
          ...value.watches,
          { ...value.watches[0], id: "treasury-two" },
        ],
      }),
    ],
    [
      "an invalid token account",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], tokenAccount: "not-solana" }],
      }),
    ],
    [
      "a numeric slot",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], cutoverSlot: 9_007_199_254_740_992 }],
      }),
    ],
    [
      "a decimal slot",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], cutoverSlot: "1.5" }],
      }),
    ],
    [
      "a negative slot",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], cutoverSlot: "-1" }],
      }),
    ],
    [
      "a slot beyond uint64",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], cutoverSlot: "99999999999999999999" }],
      }),
    ],
    [
      "an over-20-digit slot",
      (value: Record<string, any>) => ({
        ...value,
        watches: [
          { ...value.watches[0], cutoverSlot: "100000000000000000000" },
        ],
      }),
    ],
    [
      "too little overlap",
      (value: Record<string, any>) => ({
        ...value,
        watches: [{ ...value.watches[0], overlapSlots: "31" }],
      }),
    ],
    [
      "a zero finality batch",
      (value: Record<string, any>) => ({
        ...value,
        finality: { ...value.finality, batchSize: 0 },
      }),
    ],
    [
      "an oversized finality batch",
      (value: Record<string, any>) => ({
        ...value,
        finality: { ...value.finality, batchSize: 257 },
      }),
    ],
    [
      "zero finality passes",
      (value: Record<string, any>) => ({
        ...value,
        finality: { ...value.finality, maxPasses: 0 },
      }),
    ],
    [
      "too many finality passes",
      (value: Record<string, any>) => ({
        ...value,
        finality: { ...value.finality, maxPasses: 101 },
      }),
    ],
    [
      "an invalid endpoint environment name",
      (value: Record<string, any>) => ({
        ...value,
        provider: { ...value.provider, endpointEnv: "RPC-SECRET" },
      }),
    ],
    [
      "an invalid pseudonym environment name",
      (value: Record<string, any>) => ({
        ...value,
        reporting: { pseudonymizationSecretEnv: "9SECRET" },
      }),
    ],
  ])("rejects %s", async (_name, mutate) => {
    const fixture = await createFixture();
    const invalid = mutate(
      fixture.manifest as unknown as Record<string, unknown>,
    );

    await expect(
      parsePilotManifest(JSON.stringify(invalid), fixture.directory),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("rejects a parent-directory CSV escape", async () => {
    const root = await makeTemporaryDirectory();
    const directory = join(root, "manifest");
    await mkdir(directory);
    const csvPath = join(root, "outside.csv");
    await writeFile(csvPath, csv, "utf8");
    const manifest = validManifest("../outside.csv", sha256(csv));

    await expect(
      parsePilotManifest(JSON.stringify(manifest), directory),
    ).rejects.toMatchObject({ code: "unsafe_manifest_path" });
  });

  it("rejects a symlink CSV escape", async () => {
    const root = await makeTemporaryDirectory();
    const directory = join(root, "manifest");
    await mkdir(directory);
    const outside = join(root, "outside.csv");
    const linked = join(directory, "invoices.csv");
    await writeFile(outside, csv, "utf8");
    await symlink(outside, linked);
    const manifest = validManifest("invoices.csv", sha256(csv));

    await expect(
      parsePilotManifest(JSON.stringify(manifest), directory),
    ).rejects.toMatchObject({ code: "unsafe_manifest_path" });
  });

  it("rejects a final CSV symlink inside the manifest directory", async () => {
    const directory = await makeTemporaryDirectory();
    const source = join(directory, "source.csv");
    const linked = join(directory, "invoices.csv");
    await writeFile(source, csv, "utf8");
    await symlink(source, linked);
    const manifest = validManifest("invoices.csv", sha256(csv));

    await expect(
      parsePilotManifest(JSON.stringify(manifest), directory),
    ).rejects.toMatchObject({ code: "unsafe_manifest_path" });
  });

  it("rejects a wrong invoice digest without leaking either path", async () => {
    const fixture = await createFixture();
    const invalid = {
      ...fixture.manifest,
      invoices: {
        ...fixture.manifest.invoices,
        expectedSha256: "0".repeat(64),
      },
    };

    const error = await parsePilotManifest(
      JSON.stringify(invalid),
      fixture.directory,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PilotError);
    expect(error).toMatchObject({
      code: "invoice_digest_mismatch",
      message: "Invoice CSV digest does not match the manifest",
    });
    expect(String(error)).not.toContain(fixture.directory);
    expect(String(error)).not.toContain(fixture.csvPath);
  });

  it("rejects manifests larger than 256 KiB before parsing", async () => {
    const fixture = await createFixture();
    const raw = `{"padding":"${"x".repeat(256 * 1024)}"}`;

    await expect(
      parsePilotManifest(raw, fixture.directory),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
  });
});

async function createFixture(): Promise<{
  readonly directory: string;
  readonly csvPath: string;
  readonly manifest: ReturnType<typeof validManifest>;
}> {
  const directory = await makeTemporaryDirectory();
  const csvPath = join(directory, "invoices.csv");
  await writeFile(csvPath, csv, "utf8");
  return {
    directory,
    csvPath,
    manifest: validManifest("invoices.csv", sha256(csv)),
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "payops-pilot-manifest-"));
  temporaryDirectories.push(path);
  return path;
}

function validManifest(csvPath: string, expectedSha256: string) {
  return {
    schemaVersion: "0.1",
    pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
    provider: {
      id: "mainnet-provider",
      cluster: "mainnet-beta",
      endpointEnv: "PAYOPS_MAINNET_RPC_URL",
      endpointLabel: "Merchant mainnet RPC",
    },
    watches: [
      {
        id: "treasury-primary",
        tokenAccount,
        cutoverSlot: "350000000",
        cutoverSignature: null,
        overlapSlots: "64",
      },
    ],
    invoices: { csvPath, expectedSha256 },
    finality: { batchSize: 64, maxPasses: 10 },
    reporting: { pseudonymizationSecretEnv: "PAYOPS_AUDIT_SECRET" },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
