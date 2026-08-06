import { address } from "@solana/kit";
import bs58 from "bs58";
import { z } from "zod";

const solanaAddressSchema = z.string().refine(
  (value) => {
    try {
      address(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid Solana address" },
);

const signatureSchema = z.string().refine(
  (value) => {
    try {
      return bs58.decode(value).length === 64;
    } catch {
      return false;
    }
  },
  { message: "Invalid Solana transaction signature" },
);

const baseUnitStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const commitmentSchema = z.enum(["confirmed", "finalized"]);
const transactionErrorSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
]);

const compiledInstructionSchema = z
  .object({
    programIdIndex: z.number().int().nonnegative(),
    accounts: z.array(z.number().int().nonnegative()),
    data: z.string().min(1),
    stackHeight: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const tokenBalanceSchema = z
  .object({
    accountIndex: z.number().int().nonnegative(),
    mint: solanaAddressSchema,
    owner: solanaAddressSchema.optional(),
    programId: solanaAddressSchema.optional(),
    uiTokenAmount: z
      .object({
        amount: baseUnitStringSchema,
        decimals: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

const addressTableLookupSchema = z
  .object({
    accountKey: solanaAddressSchema,
    writableIndexes: z.array(z.number().int().min(0).max(255)),
    readonlyIndexes: z.array(z.number().int().min(0).max(255)),
  })
  .strict();

export const PaymentFixtureSchema = z
  .object({
    fixtureVersion: z.literal("0.1"),
    name: z.string().min(1),
    expectation: z
      .object({
        cluster: z.literal("mainnet-beta"),
        recipientOwner: solanaAddressSchema,
        destinationTokenAccount: solanaAddressSchema,
        mint: solanaAddressSchema,
        tokenProgram: solanaAddressSchema,
        amountBaseUnits: baseUnitStringSchema,
        decimals: z.number().int().nonnegative(),
        reference: solanaAddressSchema,
        requiredCommitment: commitmentSchema,
      })
      .strict(),
    rpcTransaction: z
      .object({
        cluster: z.literal("mainnet-beta"),
        commitment: commitmentSchema,
        signature: signatureSchema,
        slot: z.number().int().nonnegative(),
        blockTime: z.number().int().nullable(),
        version: z.union([z.literal("legacy"), z.literal(0)]),
        transaction: z
          .object({
            signatures: z.array(signatureSchema).min(1),
            message: z
              .object({
                header: z
                  .object({
                    numRequiredSignatures: z.number().int().nonnegative(),
                    numReadonlySignedAccounts: z.number().int().nonnegative(),
                    numReadonlyUnsignedAccounts: z.number().int().nonnegative(),
                  })
                  .strict(),
                accountKeys: z.array(solanaAddressSchema),
                addressTableLookups: z.array(addressTableLookupSchema),
                instructions: z.array(compiledInstructionSchema),
                recentBlockhash: solanaAddressSchema,
              })
              .passthrough(),
          })
          .passthrough(),
        meta: z
          .object({
            err: z.union([z.null(), transactionErrorSchema]),
            loadedAddresses: z
              .object({
                writable: z.array(solanaAddressSchema),
                readonly: z.array(solanaAddressSchema),
              })
              .optional(),
            innerInstructions: z
              .array(
                z
                  .object({
                    index: z.number().int().nonnegative(),
                    instructions: z.array(compiledInstructionSchema),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
            preTokenBalances: z.array(tokenBalanceSchema),
            postTokenBalances: z.array(tokenBalanceSchema),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict()
  .superRefine((fixture, context) => {
    const { rpcTransaction } = fixture;
    const { transaction, meta } = rpcTransaction;
    const { message, signatures } = transaction;
    const { header, addressTableLookups } = message;
    const loadedWritable = meta.loadedAddresses?.writable ?? [];
    const loadedReadonly = meta.loadedAddresses?.readonly ?? [];

    const issue = (path: readonly (string | number)[], message: string) => {
      context.addIssue({ code: "custom", path: [...path], message });
    };

    if (signatures[0] !== rpcTransaction.signature) {
      issue(
        ["rpcTransaction", "signature"],
        "Envelope signature must equal the transaction's first signature",
      );
    }
    if (signatures.length !== header.numRequiredSignatures) {
      issue(
        ["rpcTransaction", "transaction", "signatures"],
        "Signature count must match numRequiredSignatures",
      );
    }
    if (header.numRequiredSignatures > message.accountKeys.length) {
      issue(
        ["rpcTransaction", "transaction", "message", "header"],
        "Required signers must be static account keys",
      );
    }
    if (
      header.numReadonlySignedAccounts >= header.numRequiredSignatures ||
      header.numReadonlyUnsignedAccounts >
        message.accountKeys.length - header.numRequiredSignatures
    ) {
      issue(
        ["rpcTransaction", "transaction", "message", "header"],
        "Readonly account counts exceed the static account-key partitions",
      );
    }

    const lookupWritableCount = addressTableLookups.reduce(
      (count, lookup) => count + lookup.writableIndexes.length,
      0,
    );
    const lookupReadonlyCount = addressTableLookups.reduce(
      (count, lookup) => count + lookup.readonlyIndexes.length,
      0,
    );
    if (
      lookupWritableCount !== loadedWritable.length ||
      lookupReadonlyCount !== loadedReadonly.length
    ) {
      issue(
        ["rpcTransaction", "meta", "loadedAddresses"],
        "Loaded-address counts must match message address-table lookups",
      );
    }
    if (
      rpcTransaction.version === "legacy" &&
      (addressTableLookups.length > 0 ||
        loadedWritable.length > 0 ||
        loadedReadonly.length > 0)
    ) {
      issue(
        ["rpcTransaction", "version"],
        "Legacy transactions cannot declare loaded addresses",
      );
    }

    const resolvedAccountCount =
      message.accountKeys.length +
      loadedWritable.length +
      loadedReadonly.length;
    const validateInstruction = (
      instruction: z.infer<typeof compiledInstructionSchema>,
      path: readonly (string | number)[],
    ) => {
      if (instruction.programIdIndex >= resolvedAccountCount) {
        issue([...path, "programIdIndex"], "Program index is out of range");
      }
      instruction.accounts.forEach((accountIndex, accountPosition) => {
        if (accountIndex >= resolvedAccountCount) {
          issue(
            [...path, "accounts", accountPosition],
            "Instruction account index is out of range",
          );
        }
      });
    };

    message.instructions.forEach((instruction, instructionIndex) => {
      validateInstruction(instruction, [
        "rpcTransaction",
        "transaction",
        "message",
        "instructions",
        instructionIndex,
      ]);
    });
    const innerInstructionParents = new Set<number>();
    for (const [groupIndex, group] of (
      meta.innerInstructions ?? []
    ).entries()) {
      if (innerInstructionParents.has(group.index)) {
        issue(
          ["rpcTransaction", "meta", "innerInstructions", groupIndex, "index"],
          "Inner-instruction parent indexes must be unique",
        );
      }
      innerInstructionParents.add(group.index);
      if (group.index >= message.instructions.length) {
        issue(
          ["rpcTransaction", "meta", "innerInstructions", groupIndex, "index"],
          "Inner-instruction group must reference an outer instruction",
        );
      }
      group.instructions.forEach((instruction, instructionIndex) => {
        validateInstruction(instruction, [
          "rpcTransaction",
          "meta",
          "innerInstructions",
          groupIndex,
          "instructions",
          instructionIndex,
        ]);
      });
    }

    for (const [balanceKind, balances] of [
      ["preTokenBalances", meta.preTokenBalances],
      ["postTokenBalances", meta.postTokenBalances],
    ] as const) {
      balances.forEach((balance, balanceIndex) => {
        if (balance.accountIndex >= resolvedAccountCount) {
          issue(
            [
              "rpcTransaction",
              "meta",
              balanceKind,
              balanceIndex,
              "accountIndex",
            ],
            "Token-balance account index is out of range",
          );
        }
      });
    }
  });

export type PaymentFixture = z.infer<typeof PaymentFixtureSchema>;
export type CompiledInstruction =
  PaymentFixture["rpcTransaction"]["transaction"]["message"]["instructions"][number];
