import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const platform = await import("@payops/platform");

if (typeof platform.runMigrationSet !== "function") {
  throw new Error("@payops/platform migration entrypoint is unavailable");
}

const directory = mkdtempSync(join(tmpdir(), "payops-evidence-smoke-"));
const manifestPath = join(directory, "manifest.json");
const publicKeyPath = join(directory, "public-key.pem");
const pdfPath = join(directory, "evidence.pdf");
const pdf = Buffer.from("%PDF-1.4\nsmoke\n", "utf8");
const manifest = Buffer.from(
  JSON.stringify({
    artifacts: {
      pdf: {
        byteLength: pdf.byteLength,
        sha256: createHash("sha256").update(pdf).digest("hex"),
      },
    },
    schemaVersion: "0.1",
  }),
  "utf8",
);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(manifestPath, manifest, { mode: 0o600 });
writeFileSync(pdfPath, pdf, { mode: 0o600 });
writeFileSync(
  publicKeyPath,
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o600 },
);
const signature = sign(null, manifest, privateKey).toString("base64url");
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
    "verify-evidence",
    "--manifest",
    manifestPath,
    "--pdf",
    pdfPath,
    "--signature",
    signature,
    "--public-key",
    publicKeyPath,
  ],
  { encoding: "utf8" },
);
if (result.status !== 0 || JSON.parse(result.stdout).valid !== true) {
  throw new Error("evidence verification command failed");
}
writeFileSync(manifestPath, Buffer.from('{"schemaVersion":"tampered"}'));
const tampered = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
    "verify-evidence",
    "--manifest",
    manifestPath,
    "--pdf",
    pdfPath,
    "--signature",
    signature,
    "--public-key",
    publicKeyPath,
  ],
  { encoding: "utf8" },
);
if (
  tampered.status !== 1 ||
  tampered.stderr.trim() !== "evidence_signature_invalid"
) {
  throw new Error("tampered evidence did not fail closed");
}
const oversizedManifestPath = join(directory, "oversized-manifest.json");
writeFileSync(oversizedManifestPath, "");
truncateSync(oversizedManifestPath, 10_485_761);
const oversized = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
    "verify-evidence",
    "--manifest",
    oversizedManifestPath,
    "--pdf",
    pdfPath,
    "--signature",
    signature,
    "--public-key",
    publicKeyPath,
  ],
  { encoding: "utf8" },
);
if (
  oversized.status !== 1 ||
  oversized.stderr.trim() !== "evidence_file_too_large"
) {
  throw new Error("oversized evidence did not fail before verification");
}
rmSync(directory, { recursive: true });
