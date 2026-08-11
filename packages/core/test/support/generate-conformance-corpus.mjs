import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { format } from "prettier";
import {
  evaluateFixture,
  PaymentFixtureSchema,
  UnsupportedTransferEvidenceError,
} from "../../dist/index.js";

const directory = fileURLToPath(
  new URL("../../../../fixtures/v0.1/", import.meta.url),
);
const caseDirectory = join(directory, "cases");
const canonical = JSON.parse(
  await readFile(
    join(directory, "usdc-transfer-checked-finalized.json"),
    "utf8",
  ),
);

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const REFERENCE = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";
const OTHER_REFERENCE = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";

function signature(number) {
  return bs58.encode(
    Uint8Array.from({ length: 64 }, (_, index) => (number * 17 + index) % 256),
  );
}

function instructionData(kind, amount, decimals = 6) {
  const size = kind === "transferChecked" ? 10 : 9;
  const bytes = new Uint8Array(size);
  bytes[0] = kind === "transferChecked" ? 12 : 3;
  let remaining = BigInt(amount);
  for (let index = 1; index <= 8; index += 1) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  if (kind === "transferChecked") bytes[9] = decimals;
  return bs58.encode(bytes);
}

function fixture(id, index) {
  const value = structuredClone(canonical);
  const nextSignature = signature(index);
  value.name = `synthetic ${id}`;
  value.rpcTransaction.signature = nextSignature;
  value.rpcTransaction.transaction.signatures = [nextSignature];
  value.rpcTransaction.slot = 345_678_900 + index;
  value.rpcTransaction.blockTime = 1_786_000_000 + index;
  return value;
}

function setAsset(value, mint) {
  value.expectation.mint = mint;
  value.rpcTransaction.transaction.message.accountKeys[3] = mint;
  for (const balance of [
    ...value.rpcTransaction.meta.preTokenBalances,
    ...value.rpcTransaction.meta.postTokenBalances,
  ]) {
    balance.mint = mint;
  }
}

function makeLegacy(value) {
  value.rpcTransaction.version = "legacy";
  value.rpcTransaction.transaction.message.addressTableLookups = [];
  value.rpcTransaction.meta.loadedAddresses = { writable: [], readonly: [] };
  value.rpcTransaction.transaction.message.accountKeys.push(REFERENCE);
  value.rpcTransaction.transaction.message.header.numReadonlyUnsignedAccounts = 3;
}

function addSecondLoadedReference(value) {
  value.rpcTransaction.meta.loadedAddresses.readonly.push(OTHER_REFERENCE);
  value.rpcTransaction.transaction.message.addressTableLookups[0].readonlyIndexes =
    [0, 1];
}

function transferInstruction(value) {
  const instruction = value.rpcTransaction.transaction.message.instructions[0];
  if (instruction === undefined)
    throw new Error("Canonical instruction missing");
  return instruction;
}

function setAmount(value, amount) {
  transferInstruction(value).data = instructionData("transferChecked", amount);
  value.rpcTransaction.meta.postTokenBalances[0].uiTokenAmount.amount = String(
    20_000_000n - BigInt(amount),
  );
  value.rpcTransaction.meta.postTokenBalances[1].uiTokenAmount.amount =
    String(amount);
}

function setDestinationDelta(value, amount) {
  value.rpcTransaction.meta.postTokenBalances[1].uiTokenAmount.amount =
    String(amount);
}

function makeInner(value) {
  const transfer = structuredClone(transferInstruction(value));
  value.rpcTransaction.transaction.message.instructions = [
    { programIdIndex: 0, accounts: [], data: "1" },
  ];
  value.rpcTransaction.meta.innerInstructions = [
    { index: 0, instructions: [transfer] },
  ];
}

const definitions = [
  payment(
    "usdc-transfer-checked-v0-finalized",
    ["transfer_checked", "versioned"],
    (value) => {
      Object.assign(value, structuredClone(canonical));
    },
  ),
  payment(
    "usdt-transfer-checked-legacy-finalized",
    ["transfer_checked", "legacy"],
    (value) => {
      setAsset(value, USDT);
      makeLegacy(value);
    },
  ),
  payment(
    "usdc-transfer-balance-proven-legacy",
    ["transfer", "legacy"],
    (value) => {
      makeLegacy(value);
      const instruction = transferInstruction(value);
      instruction.accounts = [1, 2, 0, 5];
      instruction.data = instructionData("transfer", 12_500_000n);
    },
  ),
  payment(
    "usdc-transfer-checked-inner-cpi",
    ["transfer_checked", "inner_instruction", "versioned"],
    makeInner,
  ),
  payment(
    "usdt-transfer-inner-cpi",
    ["transfer", "inner_instruction", "legacy"],
    (value) => {
      setAsset(value, USDT);
      makeLegacy(value);
      const instruction = transferInstruction(value);
      instruction.accounts = [1, 2, 0, 5];
      instruction.data = instructionData("transfer", 12_500_000n);
      makeInner(value);
    },
  ),
  payment(
    "versioned-address-lookup-table",
    ["transfer_checked", "versioned", "address_lookup_table"],
    () => {},
  ),
  payment(
    "two-distinct-transfer-instructions",
    ["transfer_checked", "multi_transfer", "versioned"],
    (value) => {
      const instruction = transferInstruction(value);
      value.rpcTransaction.transaction.message.instructions = [
        instruction,
        {
          ...structuredClone(instruction),
          data: instructionData("transferChecked", 12_500_000n),
        },
      ];
      setDestinationDelta(value, 25_000_000n);
    },
    "duplicate_payment",
  ),
  payment(
    "two-credits-same-destination-balanced",
    ["transfer_checked", "multi_transfer", "versioned"],
    (value) => {
      const instruction = transferInstruction(value);
      value.rpcTransaction.transaction.message.instructions = [
        instruction,
        {
          ...structuredClone(instruction),
          data: instructionData("transferChecked", 1_000_000n),
        },
      ];
      setDestinationDelta(value, 13_500_000n);
    },
  ),
  payment(
    "multiple-readonly-references",
    ["transfer_checked", "multi_transfer", "multi_reference", "versioned"],
    (value) => {
      addSecondLoadedReference(value);
      const instruction = transferInstruction(value);
      value.rpcTransaction.transaction.message.instructions = [
        instruction,
        {
          ...structuredClone(instruction),
          accounts: [1, 3, 2, 0, 6],
          data: instructionData("transferChecked", 1_000_000n),
        },
      ];
      setDestinationDelta(value, 13_500_000n);
    },
  ),
  payment(
    "missing-reference",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      transferInstruction(value).accounts = [1, 3, 2, 0];
    },
    "missing_reference",
  ),
  payment(
    "unknown-reference",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      addSecondLoadedReference(value);
      transferInstruction(value).accounts = [1, 3, 2, 0, 6];
    },
    "unknown_reference",
  ),
  payment(
    "ambiguous-reference-expectations",
    ["transfer_checked", "multi_reference", "negative", "versioned"],
    (value) => {
      addSecondLoadedReference(value);
      transferInstruction(value).accounts = [1, 3, 2, 0, 5, 6];
    },
    "ambiguous_reference",
  ),
  payment(
    "lookalike-wrong-mint",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.transaction.message.accountKeys[3] = USDT;
      for (const balance of [
        ...value.rpcTransaction.meta.preTokenBalances,
        ...value.rpcTransaction.meta.postTokenBalances,
      ])
        balance.mint = USDT;
    },
    "wrong_asset",
  ),
  rejection(
    "unsupported-token-2022-program",
    ["token_2022", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.transaction.message.accountKeys[4] = TOKEN_2022;
    },
    "unsupported_transfer_evidence",
  ),
  payment(
    "wrong-destination-token-account",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.transaction.message.accountKeys[2] = OTHER_REFERENCE;
    },
    "wrong_destination",
  ),
  payment(
    "destination-owner-mismatch",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.meta.postTokenBalances[1].owner =
        value.rpcTransaction.transaction.message.accountKeys[0];
    },
  ),
  payment(
    "partial-base-unit-amount",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      setAmount(value, 12_499_999n);
    },
    "partial_payment",
  ),
  payment(
    "excess-base-unit-amount",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      setAmount(value, 12_500_001n);
    },
    "excess_payment",
  ),
  payment(
    "failed-transaction",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.meta.err = { InstructionError: [0, "Custom"] };
    },
  ),
  payment(
    "null-block-time",
    ["transfer_checked", "negative", "versioned"],
    (value) => {
      value.rpcTransaction.blockTime = null;
    },
    "missing_block_time",
  ),
  payment(
    "confirmed-provisional-payment",
    ["transfer_checked", "provisional", "versioned"],
    (value) => {
      value.rpcTransaction.commitment = "confirmed";
    },
  ),
  scenario(
    "confirmed-then-reverted-scenario",
    ["transfer_checked", "provisional", "reversion", "versioned"],
    (value) => {
      value.rpcTransaction.meta.err = "TransactionReverted";
      value.rpcTransaction.observations = [
        {
          commitment: "confirmed",
          transactionError: null,
          paymentState: "provisional",
        },
        {
          commitment: "finalized",
          transactionError: "TransactionReverted",
          paymentState: "reverted",
        },
      ];
      value.rpcTransaction.expectedPaidAllocations = 0;
    },
  ),
  payment(
    "duplicate-looking-distinct-instruction",
    ["transfer_checked", "multi_transfer", "negative", "versioned"],
    (value) => {
      const instruction = transferInstruction(value);
      value.rpcTransaction.transaction.message.instructions = [
        instruction,
        structuredClone(instruction),
      ];
      setDestinationDelta(value, 25_000_000n);
    },
    "duplicate_payment",
  ),
  rawRejection(
    "truncated-rpc-envelope-rejection",
    ["malformed", "negative"],
    '{"fixtureVersion":"0.1","name":"truncated"',
    "invalid_fixture",
  ),
  payment(
    "unicode-identifier-boundaries",
    ["transfer_checked", "unicode", "versioned"],
    (value) => {
      value.name = "🦀".repeat(128);
    },
  ),
];

function payment(id, tags, mutate, exceptionCode = null) {
  return { id, kind: "payment", tags, mutate, exceptionCode };
}

function scenario(id, tags, mutate) {
  return { id, kind: "finality_scenario", tags, mutate, exceptionCode: null };
}

function rejection(id, tags, mutate, parseFailureCode) {
  return {
    id,
    kind: "schema_rejection",
    tags,
    mutate,
    parseFailureCode,
    exceptionCode: null,
  };
}

function rawRejection(id, tags, raw, parseFailureCode) {
  return {
    id,
    kind: "schema_rejection",
    tags,
    raw,
    parseFailureCode,
    exceptionCode: null,
  };
}

await mkdir(caseDirectory, { recursive: true });
const cases = [];
for (const [index, definition] of definitions.entries()) {
  const value = fixture(definition.id, index + 1);
  definition.mutate?.(value);
  const raw =
    definition.raw ?? (await format(JSON.stringify(value), { parser: "json" }));
  const file = `cases/${definition.id}.json`;
  await writeFile(join(directory, file), raw, "utf8");
  cases.push({
    id: definition.id,
    file,
    sha256: createHash("sha256").update(raw).digest("hex"),
    kind: definition.kind,
    tags: definition.tags,
    expected: expectedFor(definition, raw),
  });
}

await writeFile(
  join(directory, "manifest.json"),
  await format(
    JSON.stringify({
      schemaVersion: "0.1",
      generatedAt: "2026-08-11T00:00:00.000Z",
      cases,
    }),
    { parser: "json" },
  ),
  "utf8",
);

function expectedFor(definition, raw) {
  try {
    const fixture = PaymentFixtureSchema.parse(JSON.parse(raw));
    const report = evaluateFixture(fixture);
    return {
      outcome: report.passed ? "pass" : "verification_failure",
      eventCount: report.reports.length,
      verifiedCount: report.reports.filter(({ verified }) => verified).length,
      eventIds: report.reports.map(({ eventId }) => eventId),
      verificationCodes: [
        ...new Set(
          report.reports.flatMap(({ checks }) =>
            checks.filter(({ passed }) => !passed).map(({ code }) => code),
          ),
        ),
      ].sort(),
      exceptionCode: definition.exceptionCode,
    };
  } catch (error) {
    const parseFailureCode =
      error instanceof UnsupportedTransferEvidenceError
        ? "unsupported_transfer_evidence"
        : "invalid_fixture";
    if (parseFailureCode !== definition.parseFailureCode) {
      throw new Error(
        `${definition.id} rejected with ${parseFailureCode}, expected ${definition.parseFailureCode}`,
        { cause: error },
      );
    }
    return {
      outcome: "parse_failure",
      eventCount: 0,
      verifiedCount: 0,
      eventIds: [],
      verificationCodes: [],
      exceptionCode: null,
      parseFailureCode,
    };
  }
}
