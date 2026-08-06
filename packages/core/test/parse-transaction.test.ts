import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadPaymentFixture,
  parseTransferCheckedEvents,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);

describe("parseTransferCheckedEvents", () => {
  it("creates a stable instruction-level event with a reference", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const events = parseTransferCheckedEvents(fixture);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      eventId:
        "mainnet-beta:1111111111111111111111111111111111111111111111111111111111111111:0:outer",
      signature:
        "1111111111111111111111111111111111111111111111111111111111111111",
      slot: 345678901,
      outerInstructionIndex: 0,
      innerInstructionIndex: null,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      sourceTokenAccount: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
      sourceAccountIndex: 1,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      destinationAccountIndex: 2,
      authority: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
      amountBaseUnits: "12500000",
      decimals: 6,
      references: ["Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4"],
      unsupportedExtraAccounts: [],
    });
  });

  it("preserves CPI coordinates in the event identity", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const transferInstruction =
      fixture.rpcTransaction.transaction.message.instructions[0];
    if (transferInstruction === undefined) {
      throw new Error("Expected canonical transfer instruction");
    }

    const cpiFixture = structuredClone(fixture);
    cpiFixture.rpcTransaction.transaction.message.instructions = [];
    cpiFixture.rpcTransaction.meta.innerInstructions = [
      { index: 2, instructions: [transferInstruction] },
    ];

    const events = parseTransferCheckedEvents(cpiFixture);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe(
      "mainnet-beta:1111111111111111111111111111111111111111111111111111111111111111:2:0",
    );
    expect(events[0]?.outerInstructionIndex).toBe(2);
    expect(events[0]?.innerInstructionIndex).toBe(0);
  });
});
