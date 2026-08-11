import type { AssetSymbol } from "../wallets/asset-registry.js";

export const INVOICE_CURRENCIES = ["USD", "EUR", "GBP", "INR"] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];
export type InvoiceStatus = "draft" | "issued" | "cancelled";

export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: string;
  readonly unitPriceMinorUnits: string;
  readonly taxLabel?: string | null;
  readonly taxMinorUnits: string;
}

export interface InvoiceLineRecord extends InvoiceLineInput {
  readonly position: number;
  readonly taxLabel: string | null;
  readonly lineSubtotalMinorUnits: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly publicReference: string;
  readonly externalId: string | null;
  readonly customerId: string;
  readonly settlementWalletId: string;
  readonly acceptedAssetSymbols: readonly AssetSymbol[];
  readonly currency: InvoiceCurrency;
  readonly status: InvoiceStatus;
  readonly subtotalMinorUnits: string;
  readonly taxMinorUnits: string;
  readonly totalMinorUnits: string;
  readonly dueAt: string;
  readonly version: number;
  readonly issuedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: InvoiceCancellationReason | null;
  readonly lines: readonly InvoiceLineRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InvoiceCancellationReason =
  | "customer_request"
  | "duplicate_invoice"
  | "commercial_terms_changed"
  | "merchant_error"
  | "other_reviewed";

export interface InvoiceIssuedSnapshot {
  readonly schemaVersion: "0.1";
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly publicReference: string;
  readonly externalId: string | null;
  readonly customer: { readonly id: string; readonly displayName: string };
  readonly currency: InvoiceCurrency;
  readonly lines: readonly InvoiceLineInput[];
  readonly subtotalMinorUnits: string;
  readonly taxMinorUnits: string;
  readonly totalMinorUnits: string;
  readonly dueAt: string;
  readonly acceptedAssetSymbols: readonly AssetSymbol[];
  readonly settlementWalletId: string;
  readonly issuedAt: string;
}

export class InvoiceError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Invoice operation failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "InvoiceError";
    this.code = code;
  }
}
