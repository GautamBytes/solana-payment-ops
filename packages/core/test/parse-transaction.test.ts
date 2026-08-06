import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  loadPaymentFixture,
  parseTransactionTransfers,
  parseTransferCheckedEvents,
  RpcTransactionEnvelopeSchema,
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
        "mainnet-beta:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T:0:outer",
      signature:
        "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T",
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
    const wrapperInstruction = {
      programIdIndex: 3,
      accounts: [],
      data: "2",
    };
    cpiFixture.rpcTransaction.transaction.message.instructions = [
      wrapperInstruction,
      wrapperInstruction,
      wrapperInstruction,
    ];
    cpiFixture.rpcTransaction.meta.innerInstructions = [
      { index: 2, instructions: [transferInstruction] },
    ];

    const events = parseTransferCheckedEvents(cpiFixture);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe(
      "mainnet-beta:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T:2:0",
    );
    expect(events[0]?.outerInstructionIndex).toBe(2);
    expect(events[0]?.innerInstructionIndex).toBe(0);
  });
});

describe("parseTransactionTransfers", () => {
  it("parses the envelope without an invoice expectation", async () => {
    const fixture = await loadPaymentFixture(fixturePath);

    const events = parseTransactionTransfers(
      RpcTransactionEnvelopeSchema.parse(fixture.rpcTransaction),
    );

    expect(events).toEqual(parseTransferCheckedEvents(fixture));
  });

  it("derives legacy Transfer asset evidence from matching balances", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    const instruction = envelope.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected canonical transfer instruction");
    }
    instruction.accounts = [1, 2, 0, 5];
    instruction.data = "3Jw9y63HdCBH";

    const events = parseTransactionTransfers(envelope);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountBaseUnits: "12500000",
      decimals: 6,
      references: ["Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4"],
    });
  });

  it("rejects a legacy Transfer with contradictory mint evidence", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    const instruction = envelope.transaction.message.instructions[0];
    const destinationBalance = envelope.meta.postTokenBalances[1];
    if (instruction === undefined || destinationBalance === undefined) {
      throw new Error("Expected canonical transfer evidence");
    }
    instruction.accounts = [1, 2, 0, 5];
    instruction.data = "3Jw9y63HdCBH";
    destinationBalance.mint = "Es9vMFrzaCERmJfrF4H2FYD6Ew8VxRbjgVq2mL2FWV1";

    expect(() => parseTransactionTransfers(envelope)).toThrow(
      "Legacy Transfer token-balance evidence is contradictory",
    );
  });

  it("surfaces Token-2022 activity as unsupported evidence", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    envelope.transaction.message.accountKeys[4] =
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

    expect(() => parseTransactionTransfers(envelope)).toThrow(
      "Token-2022 instructions are not supported",
    );
  });

  it("rejects an unknown legacy-token effect on the watched account", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    const instruction = envelope.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected canonical transfer instruction");
    }
    instruction.data = bs58.encode(Uint8Array.of(9));

    expect(() =>
      parseTransactionTransfers(envelope, {
        watchedAddress: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      }),
    ).toThrow("Unsupported SPL Token instruction affects the watched account");
  });

  it("ignores an unknown legacy-token instruction unrelated to the watched account", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    const instruction = envelope.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected canonical transfer instruction");
    }
    instruction.accounts = [1, 3, 0];
    instruction.data = bs58.encode(Uint8Array.of(9));

    const events = parseTransactionTransfers(envelope, {
      watchedAddress: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
    });

    expect(events).toEqual([]);
  });

  it("rejects malformed supported token data on the watched account", async () => {
    const fixture = await loadPaymentFixture(fixturePath);
    const envelope = structuredClone(fixture.rpcTransaction);
    const instruction = envelope.transaction.message.instructions[0];
    if (instruction === undefined) {
      throw new Error("Expected canonical transfer instruction");
    }
    instruction.data = bs58.encode(Uint8Array.of(12, 1));

    expect(() =>
      parseTransactionTransfers(envelope, {
        watchedAddress: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      }),
    ).toThrow("Malformed SPL Token instruction affects the watched account");
  });
});
