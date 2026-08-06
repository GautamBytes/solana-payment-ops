import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PaymentFixtureSchema } from "@payops/core";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import { FakeRpc } from "./support/fake-rpc.js";
import { MemoryStore } from "./support/memory-store.js";

function setup() {
  const lines: string[] = [];
  const store = new MemoryStore();
  const rpc = new FakeRpc();
  let migrations = 0;
  const dependencies: CliDependencies = {
    env: {
      DATABASE_URL: "postgres://not-used",
      SOLANA_RPC_URL: "https://rpc.example/?token=super-secret",
    },
    write: (line) => lines.push(line),
    createStore: () => store,
    createRpc: () => rpc,
    migrate: async () => {
      migrations += 1;
    },
    now: () => new Date("2026-08-06T00:00:00Z"),
    createId: () => "watch-created",
  };
  return { dependencies, lines, store, rpc, migrations: () => migrations };
}

describe("runCli", () => {
  it("runs migrations with canonical JSON output", async () => {
    const context = setup();

    const code = await runCli(["migrate"], context.dependencies);

    expect(code).toBe(0);
    expect(context.migrations()).toBe(1);
    expect(JSON.parse(context.lines[0] ?? "{}")).toEqual({ migrated: true });
  });

  it("stores only an endpoint environment name and redacted label", async () => {
    const context = setup();

    const code = await runCli(
      [
        "provider",
        "add",
        "--id",
        "primary",
        "--cluster",
        "mainnet-beta",
        "--url-env",
        "SOLANA_RPC_URL",
      ],
      context.dependencies,
    );

    expect(code).toBe(0);
    expect(context.store.provider).toMatchObject({
      endpointEnv: "SOLANA_RPC_URL",
      endpointLabel: "rpc.example",
    });
    expect(context.lines.join("\n")).not.toContain("super-secret");
  });

  it("returns exit one when sync leaves blocking work", async () => {
    const context = setup();
    context.rpc.head = {
      signature:
        "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T",
      slot: 12n,
      blockTime: null,
      err: null,
      confirmationStatus: "confirmed",
    };
    context.rpc.pages.set(context.rpc.head.signature, []);
    context.rpc.transactions.set(context.rpc.head.signature, null);

    const code = await runCli(
      ["sync", "--provider", "primary", "--watch", "watch-1"],
      context.dependencies,
    );

    expect(code).toBe(1);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      result: "incomplete",
      cursorAdvanced: false,
    });
  });

  it("returns exit two for invalid arguments", async () => {
    const context = setup();

    const code = await runCli(["watch", "add"], context.dependencies);

    expect(code).toBe(2);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      error: { code: "invalid_configuration" },
    });
  });

  it("rejects a non-numeric finality limit before making RPC calls", async () => {
    const context = setup();

    const code = await runCli(
      ["finality", "refresh", "--provider", "primary", "--limit", "abc"],
      context.dependencies,
    );

    expect(code).toBe(2);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      error: { code: "invalid_configuration" },
    });
  });

  it("returns exit one when finality creates blocking retry work", async () => {
    const context = setup();
    context.store.finalityCandidates = [
      {
        providerId: "primary",
        watchTargetId: "watch-1",
        cluster: "mainnet-beta",
        signature: "signature",
        slot: 100n,
        state: "confirmed",
        confirmedDigest: "digest",
        missingObservationCount: 0,
        firstMissingFinalizedSlot: null,
        claimToken: "claim-token",
        hasFinalizedSnapshot: false,
      },
    ];
    context.rpc.statuses = [
      {
        signature: "signature",
        slot: 100n,
        confirmationStatus: "finalized",
        err: null,
      },
    ];
    context.rpc.transactions.set("signature", null);

    const code = await runCli(
      ["finality", "refresh", "--provider", "primary", "--limit", "1"],
      context.dependencies,
    );

    expect(code).toBe(1);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      deferred: 1,
      retriesCreated: 1,
    });
  });

  it("serializes inspected watch slots as decimal strings", async () => {
    const context = setup();

    const code = await runCli(
      ["inspect", "watch", "--watch", "watch-1"],
      context.dependencies,
    );

    expect(code).toBe(0);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      cutoverSlot: "1",
      overlapSlots: "150",
      committedHeadSlot: null,
    });
  });

  it("serializes inspection timestamps and bigint values losslessly", async () => {
    const context = setup();
    context.store.signatureInspection = {
      signature: "signature",
      slot: 345678901n,
      observedAt: new Date("2026-08-06T00:00:00Z"),
    };

    const code = await runCli(
      ["inspect", "signature", "--signature", "signature"],
      context.dependencies,
    );

    expect(code).toBe(0);
    expect(JSON.parse(context.lines[0] ?? "{}")).toEqual({
      observedAt: "2026-08-06T00:00:00.000Z",
      signature: "signature",
      slot: "345678901",
    });
  });

  it("passes the explicit raw-body flag only when requested", async () => {
    const context = setup();
    context.store.signatureInspection = { signature: "signature" };

    const code = await runCli(
      ["inspect", "signature", "--signature", "signature", "--include-raw"],
      context.dependencies,
    );

    expect(code).toBe(0);
    expect(context.store.lastInspectionOptions).toEqual({ includeRaw: true });
  });

  it("fetches one head transaction during RPC smoke without printing raw data", async () => {
    const context = setup();
    const fixturePath = fileURLToPath(
      new URL(
        "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
        import.meta.url,
      ),
    );
    const transaction = PaymentFixtureSchema.parse(
      JSON.parse(await readFile(fixturePath, "utf8")),
    ).rpcTransaction;
    context.rpc.head = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed",
    };
    context.rpc.transactions.set(transaction.signature, transaction);

    const code = await runCli(
      [
        "rpc-smoke",
        "--provider",
        "primary",
        "--address",
        "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      ],
      context.dependencies,
    );

    expect(code).toBe(0);
    expect(context.rpc.transactionRequests).toEqual([transaction.signature]);
    const output = JSON.parse(context.lines[0] ?? "{}");
    expect(output).toMatchObject({
      headSignature: transaction.signature,
      transactionAvailable: true,
      transactionSlot: String(transaction.slot),
    });
    expect(output.transactionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(context.lines[0]).not.toContain("super-secret");
    expect(context.lines[0]).not.toContain("preTokenBalances");
  });

  it("returns incomplete smoke status when the head transaction is unavailable", async () => {
    const context = setup();
    context.rpc.head = {
      signature: "signature",
      slot: 12n,
      blockTime: null,
      err: null,
      confirmationStatus: "confirmed",
    };
    context.rpc.transactions.set("signature", null);

    const code = await runCli(
      [
        "rpc-smoke",
        "--provider",
        "primary",
        "--address",
        "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      ],
      context.dependencies,
    );

    expect(code).toBe(1);
    expect(JSON.parse(context.lines[0] ?? "{}")).toMatchObject({
      transactionAvailable: false,
      transactionDigest: null,
    });
  });
});
