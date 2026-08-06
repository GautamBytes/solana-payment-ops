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
        transaction: z
          .object({
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
                instructions: z.array(compiledInstructionSchema),
              })
              .passthrough(),
          })
          .passthrough(),
        meta: z
          .object({
            err: z.union([z.null(), z.record(z.string(), z.unknown())]),
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
  .strict();

export type PaymentFixture = z.infer<typeof PaymentFixtureSchema>;
export type CompiledInstruction =
  PaymentFixture["rpcTransaction"]["transaction"]["message"]["instructions"][number];
