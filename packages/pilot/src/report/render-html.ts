import type { AuditReportV01 } from "../domain/types.js";

export function renderAuditHtml(
  report: AuditReportV01,
  canonicalJsonDigest: string,
): string {
  const warnings =
    report.warnings.length === 0
      ? "<li>None</li>"
      : report.warnings
          .map((warning) => `<li>${escapeHtml(warning)}</li>`)
          .join("");
  const rows = report.rows
    .map(
      (row) => `<tr>
<td>${escapeHtml(row.invoiceId ?? "")}</td>
<td>${escapeHtml(row.status)}</td>
<td>${escapeHtml(row.expectedMint)}</td>
<td>${escapeHtml(row.amountBaseUnits)}</td>
<td>${escapeHtml(row.ruleCode ?? "")}</td>
</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grant-safe merchant shadow audit</title>
<style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3dd;padding:.5rem;text-align:left}code{overflow-wrap:anywhere}</style>
</head>
<body>
<h1>Grant-safe merchant shadow audit</h1>
<p>Run <code>${escapeHtml(report.runId)}</code>, generated ${escapeHtml(report.generatedAt)}.</p>
<h2>Totals</h2>
<ul>
<li>Invoices: ${report.totals.invoices}</li>
<li>Finalized events: ${report.totals.finalizedEvents}</li>
<li>Exact matches: ${report.totals.exactMatches}</li>
<li>Exceptions: ${report.totals.exceptions}</li>
<li>Unapplied: ${report.totals.unapplied}</li>
</ul>
<h2>Warnings</h2><ul>${warnings}</ul>
<h2>Review rows</h2>
<table><thead><tr><th>Invoice</th><th>Status</th><th>Mint</th><th>Base units</th><th>Rule</th></tr></thead><tbody>${rows}</tbody></table>
<footer><p>Canonical redacted JSON SHA-256: <code>${escapeHtml(canonicalJsonDigest)}</code></p></footer>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
