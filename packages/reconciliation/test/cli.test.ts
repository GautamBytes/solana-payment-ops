import { describe, expect, it } from "vitest";
import {
  runCli,
  type CliDependencies,
  type InvoiceImport,
  type ReconciliationDecision,
  type ReconciliationReportRow,
} from "../src/index.js";

const HEADER =
  "invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at";
const CSV = `${HEADER}\ninv-001,customer-001,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM,12500000,Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4,2026-08-01T00:00:00.000Z,2026-08-15T00:00:00.000Z`;

function dependencies() {
  const output: string[] = [];
  const imported: InvoiceImport[][] = [];
  const rows: ReconciliationReportRow[] = [];
  const deps: CliDependencies = {
    env: { DATABASE_URL: "postgres://test" },
    write: (line) => output.push(line),
    readFile: async () => CSV,
    migrate: async () => undefined,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    createStore: () => ({
      startRun: async () => "run-001",
      completeRun: async () => undefined,
      importInvoices: async (invoices) => {
        imported.push([...invoices]);
        return { inserted: invoices.length, existing: 0 };
      },
      listInvoices: async () => [],
      listFinalizedCandidates: async () => [],
      recordDecision: async (_decision: ReconciliationDecision) => false,
      getReportRows: async () => rows,
      getReport: async (generatedAt) => ({
        schemaVersion: "0.1",
        generatedAt: generatedAt.toISOString(),
        summary: {
          invoices: 0,
          matched: 0,
          open: 0,
          exception: 0,
          allocations: 0,
          exceptions: 0,
          unapplied: 0,
        },
        invoices: [],
        allocations: [],
        exceptions: [],
      }),
      close: async () => undefined,
    }),
  };
  return { deps, imported, output };
}

describe("runCli", () => {
  it("imports an invoice CSV", async () => {
    const { deps, imported, output } = dependencies();
    await expect(
      runCli(["invoice", "import", "--file", "invoices.csv"], deps),
    ).resolves.toBe(0);
    expect(imported[0]).toHaveLength(1);
    expect(output[0]).toContain('"inserted": 1');
  });

  it("runs reconciliation", async () => {
    const { deps, output } = dependencies();
    await expect(runCli(["reconcile", "run"], deps)).resolves.toBe(0);
    expect(output[0]).toContain('"candidates": 0');
  });

  it("renders CSV reports", async () => {
    const { deps, output } = dependencies();
    await expect(runCli(["report", "--format", "csv"], deps)).resolves.toBe(0);
    expect(output[0]).toContain("invoice_id,customer_id,status");
  });

  it("renders structured JSON reports", async () => {
    const { deps, output } = dependencies();
    await expect(runCli(["report", "--format", "json"], deps)).resolves.toBe(0);
    expect(output[0]).toContain('"allocations": []');
    expect(output[0]).toContain('"summary"');
    expect(output[0]).not.toContain('"rows"');
  });

  it("returns usage failure without exposing configuration", async () => {
    const { deps, output } = dependencies();
    await expect(runCli(["report", "--format", "xml"], deps)).resolves.toBe(2);
    expect(output.join("\n")).not.toContain("postgres://test");
  });

  it("rejects trailing and unknown arguments", async () => {
    const { deps } = dependencies();
    await expect(
      runCli(["reconcile", "run", "--unexpected"], deps),
    ).resolves.toBe(2);
  });
});
