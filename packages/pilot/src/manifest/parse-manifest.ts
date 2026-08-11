import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stringifyCanonical } from "@payops/core";
import { address } from "@solana/kit";
import { z } from "zod";
import {
  PilotError,
  type ParsedPilotManifest,
  type PilotManifest,
} from "../domain/types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_U64 = 18_446_744_073_709_551_615n;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const slotPattern = /^(0|[1-9][0-9]{0,19})$/;
const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

const environmentNameSchema = z.string().regex(environmentNamePattern);
const identifierSchema = z.string().regex(identifierPattern);
const slotSchema = z
  .string()
  .regex(slotPattern)
  .refine((value) => slotWithin(value, 0n));
const addressSchema = z.string().refine((value) => {
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
});

const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal("0.1"),
    pilotId: z.string().uuid(),
    provider: z.strictObject({
      id: identifierSchema,
      cluster: z.literal("mainnet-beta"),
      endpointEnv: environmentNameSchema,
      endpointLabel: z.string().min(1).max(128),
    }),
    watches: z
      .array(
        z.strictObject({
          id: identifierSchema,
          tokenAccount: addressSchema,
          cutoverSlot: slotSchema,
          cutoverSignature: z.string().regex(signaturePattern).nullable(),
          overlapSlots: slotSchema.refine((value) => slotWithin(value, 32n)),
        }),
      )
      .min(1)
      .max(64),
    invoices: z.strictObject({
      csvPath: z.string().min(1).max(1024),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    finality: z.strictObject({
      batchSize: z.number().int().min(1).max(256),
      maxPasses: z.number().int().min(1).max(100),
    }),
    reporting: z.strictObject({
      pseudonymizationSecretEnv: environmentNameSchema,
    }),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>([manifest.provider.id]);
    const tokenAccounts = new Set<string>();
    for (const [index, watch] of manifest.watches.entries()) {
      if (ids.has(watch.id)) {
        context.addIssue({
          code: "custom",
          path: ["watches", index, "id"],
          message: "Duplicate manifest identity",
        });
      }
      if (tokenAccounts.has(watch.tokenAccount)) {
        context.addIssue({
          code: "custom",
          path: ["watches", index, "tokenAccount"],
          message: "Duplicate token account",
        });
      }
      ids.add(watch.id);
      tokenAccounts.add(watch.tokenAccount);
    }
  });

export { PilotError } from "../domain/types.js";

export async function parsePilotManifest(
  raw: string,
  baseDirectory: string,
): Promise<ParsedPilotManifest> {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw invalidManifest();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidManifest();
  }

  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw invalidManifest();
  const manifest: PilotManifest = parsed.data;

  const invoiceCsvPath = await resolveInvoicePath(
    baseDirectory,
    manifest.invoices.csvPath,
  );
  let bytes: Buffer;
  try {
    const metadata = await stat(invoiceCsvPath);
    if (!metadata.isFile()) throw new Error("not a regular file");
    bytes = await readFile(invoiceCsvPath);
  } catch {
    throw unsafeManifestPath();
  }

  const actualDigest = createHash("sha256").update(bytes).digest();
  const expectedDigest = Buffer.from(manifest.invoices.expectedSha256, "hex");
  if (!timingSafeEqual(actualDigest, expectedDigest)) {
    throw new PilotError(
      "invoice_digest_mismatch",
      "Invoice CSV digest does not match the manifest",
    );
  }

  const canonicalJson = stringifyCanonical(manifest);
  return {
    manifest,
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    invoiceCsvPath,
  };
}

async function resolveInvoicePath(
  baseDirectory: string,
  configuredPath: string,
): Promise<string> {
  if (isAbsolute(configuredPath)) throw unsafeManifestPath();
  let base: string;
  let candidate: string;
  try {
    base = await realpath(baseDirectory);
    candidate = await realpath(resolve(base, configuredPath));
  } catch {
    throw unsafeManifestPath();
  }
  const pathFromBase = relative(base, candidate);
  if (
    pathFromBase.length === 0 ||
    pathFromBase === ".." ||
    pathFromBase.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBase)
  ) {
    throw unsafeManifestPath();
  }
  return candidate;
}

function invalidManifest(): PilotError {
  return new PilotError("invalid_manifest", "Pilot manifest is invalid");
}

function unsafeManifestPath(): PilotError {
  return new PilotError(
    "unsafe_manifest_path",
    "Pilot manifest references an unsafe path",
  );
}

function slotWithin(value: string, minimum: bigint): boolean {
  if (!slotPattern.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= minimum && parsed <= MAX_U64;
}
