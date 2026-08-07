import { describe, expect, it } from "vitest";
import { parseInvoiceCsv, ReconciliationError } from "../src/index.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const DESTINATION = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";
const REFERENCE = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";
const REFERENCE_2 = "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";
const HEADER =
  "invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at";

function row(overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    invoice_id: "inv-001",
    customer_id: "customer-001",
    expected_mint: USDC,
    destination_token_account: DESTINATION,
    amount_base_units: "12500000",
    reference_address: REFERENCE,
    issued_at: "2026-08-01T00:00:00.000Z",
    due_at: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
  return [
    values.invoice_id,
    values.customer_id,
    values.expected_mint,
    values.destination_token_account,
    values.amount_base_units,
    values.reference_address,
    values.issued_at,
    values.due_at,
  ].join(",");
}

describe("parseInvoiceCsv", () => {
  it("parses the exact invoice contract with BOM, CRLF, and quoted fields", () => {
    const csv = `\uFEFF${HEADER}\r\n${row({ customer_id: '"Acme, India"' })}\r\n`;

    expect(parseInvoiceCsv(csv)).toEqual([
      {
        invoiceId: "inv-001",
        customerId: "Acme, India",
        expectedMint: USDC,
        destinationTokenAccount: DESTINATION,
        amountBaseUnits: 12_500_000n,
        referenceAddress: REFERENCE,
        issuedAt: new Date("2026-08-01T00:00:00.000Z"),
        dueAt: new Date("2026-08-15T00:00:00.000Z"),
      },
    ]);
  });

  it("accepts canonical mainnet USDT", () => {
    expect(
      parseInvoiceCsv(`${HEADER}\n${row({ expected_mint: USDT })}`)[0],
    ).toMatchObject({ expectedMint: USDT });
  });

  it.each([
    ["unexpected header", `invoice_id,customer_id\ninv-001,customer-001`],
    ["unsupported mint", `${HEADER}\n${row({ expected_mint: DESTINATION })}`],
    [
      "invalid destination",
      `${HEADER}\n${row({ destination_token_account: "invalid" })}`,
    ],
    [
      "invalid reference",
      `${HEADER}\n${row({ reference_address: "invalid" })}`,
    ],
    ["zero amount", `${HEADER}\n${row({ amount_base_units: "0" })}`],
    ["decimal amount", `${HEADER}\n${row({ amount_base_units: "1.25" })}`],
    [
      "amount wider than numeric(78,0)",
      `${HEADER}\n${row({ amount_base_units: "1".repeat(79) })}`,
    ],
    ["invalid issue time", `${HEADER}\n${row({ issued_at: "tomorrow" })}`],
    [
      "date without an explicit time zone",
      `${HEADER}\n${row({ issued_at: "2026-08-01" })}`,
    ],
    [
      "due time before issue time",
      `${HEADER}\n${row({ due_at: "2026-07-31T00:00:00.000Z" })}`,
    ],
    [
      "duplicate invoice id",
      `${HEADER}\n${row()}\n${row({ reference_address: REFERENCE_2 })}`,
    ],
    [
      "duplicate reference",
      `${HEADER}\n${row()}\n${row({ invoice_id: "inv-002" })}`,
    ],
  ])("rejects %s", (_name, csv) => {
    expect(() => parseInvoiceCsv(csv)).toThrow(ReconciliationError);
  });
});
