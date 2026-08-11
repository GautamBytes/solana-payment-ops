import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixtureManifestSchema,
  PaymentFixtureSchema,
  parseTransferCheckedEvents,
} from "@payops/core";
import { describe, expect, it } from "vitest";
import {
  reconcileEvent,
  type FinalizedPaymentEvent,
  type InvoiceRecord,
} from "../src/index.js";

const manifestPath = fileURLToPath(
  new URL("../../../fixtures/v0.1/manifest.json", import.meta.url),
);

describe("fixture corpus reconciliation expectations", () => {
  it("produces every declared reconciliation exception code", async () => {
    const manifest = FixtureManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    const applicable = manifest.cases.filter(
      ({ expected }) => expected.exceptionCode !== null,
    );

    expect(applicable).toHaveLength(10);
    for (const item of applicable) {
      if (item.expected.outcome === "parse_failure") {
        throw new Error(`${item.id} cannot reconcile a parse failure`);
      }
      const fixture = PaymentFixtureSchema.parse(
        JSON.parse(
          await readFile(resolve(dirname(manifestPath), item.file), "utf8"),
        ),
      );
      const transfer = parseTransferCheckedEvents(fixture)[0];
      if (transfer === undefined) throw new Error(`${item.id} has no transfer`);
      const invoice = invoiceFor(fixture);
      const invoices =
        item.expected.exceptionCode === "ambiguous_reference"
          ? [
              invoice,
              {
                ...invoice,
                invoiceId: "invoice-002",
                referenceAddress:
                  transfer.references.find(
                    (reference) => reference !== invoice.referenceAddress,
                  ) ?? "missing-second-reference",
              },
            ]
          : [
              item.expected.exceptionCode === "duplicate_payment"
                ? { ...invoice, status: "matched" as const }
                : invoice,
            ];

      expect(
        reconcileEvent(eventFor(fixture, transfer), invoices),
        item.id,
      ).toMatchObject({
        kind: "exception",
        code: item.expected.exceptionCode,
      });
    }
  });
});

function invoiceFor(
  fixture: ReturnType<typeof PaymentFixtureSchema.parse>,
): InvoiceRecord {
  return {
    invoiceId: "invoice-001",
    customerId: "customer-001",
    expectedMint: fixture.expectation.mint,
    destinationTokenAccount: fixture.expectation.destinationTokenAccount,
    amountBaseUnits: BigInt(fixture.expectation.amountBaseUnits),
    referenceAddress: fixture.expectation.reference,
    issuedAt: new Date("2026-08-01T00:00:00.000Z"),
    dueAt: new Date("2026-08-31T00:00:00.000Z"),
    status: "open",
  };
}

function eventFor(
  fixture: ReturnType<typeof PaymentFixtureSchema.parse>,
  transfer: ReturnType<typeof parseTransferCheckedEvents>[number],
): FinalizedPaymentEvent {
  return {
    chainEventId: transfer.eventId,
    eventId: transfer.eventId,
    cluster: "mainnet-beta",
    signature: transfer.signature,
    outerInstructionIndex: transfer.outerInstructionIndex,
    innerInstructionIndex: transfer.innerInstructionIndex,
    mint: transfer.mint,
    destinationTokenAccount: transfer.destinationTokenAccount,
    amountBaseUnits: BigInt(transfer.amountBaseUnits),
    decimals: transfer.decimals,
    references: transfer.references,
    blockTime:
      fixture.rpcTransaction.blockTime === null
        ? null
        : new Date(fixture.rpcTransaction.blockTime * 1_000),
  };
}
