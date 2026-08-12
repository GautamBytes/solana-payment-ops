"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  assignPaymentException,
  createAccountingExport,
  createEvidencePack,
  resolvePaymentException,
  type AccountingExportFormat,
} from "../../lib/operations-api";
import { payopsCookieHeader } from "../../lib/auth-cookie";

export async function assignExceptionAction(formData: FormData): Promise<void> {
  await assignPaymentException(await authCookie(), {
    exceptionId: field(formData, "exceptionId", 36),
    assignee: field(formData, "assignee", 320),
    expectedVersion: version(formData),
    idempotencyKey: idempotencyKey(formData),
  });
  revalidatePath("/operations");
}

export async function resolveExceptionAction(
  formData: FormData,
): Promise<void> {
  const resolutionCode = field(formData, "resolutionCode", 32);
  if (!isResolutionCode(resolutionCode)) throw new Error("invalid_resolution");
  await resolvePaymentException(await authCookie(), {
    exceptionId: field(formData, "exceptionId", 36),
    resolutionCode,
    note: field(formData, "note", 1_024),
    expectedVersion: version(formData),
    idempotencyKey: idempotencyKey(formData),
  });
  revalidatePath("/operations");
}

export async function generateEvidenceAction(
  formData: FormData,
): Promise<void> {
  const result = await createEvidencePack(
    await authCookie(),
    field(formData, "invoiceId", 36),
    idempotencyKey(formData),
  );
  redirect(`/operations/evidence/${result.id}`);
}

export async function exportAccountingAction(
  formData: FormData,
): Promise<void> {
  const format = field(formData, "format", 32);
  if (!isExportFormat(format)) throw new Error("invalid_export");
  const result = await createAccountingExport(await authCookie(), {
    format,
    fromTime: field(formData, "fromTime", 64),
    throughTime: field(formData, "throughTime", 64),
    idempotencyKey: idempotencyKey(formData),
  });
  redirect(`/operations/download/export/${result.id}`);
}

async function authCookie(): Promise<string> {
  const store = await cookies();
  return payopsCookieHeader(store.getAll());
}
function field(formData: FormData, name: string, maximum: number): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error("invalid_operation_input");
  return value;
}
function version(formData: FormData): number {
  const value = Number(field(formData, "expectedVersion", 10));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid_operation_input");
  return value;
}
function idempotencyKey(formData: FormData): string {
  const value = field(formData, "idempotencyKey", 128);
  if (!/^[\x21-\x7e]{16,128}$/u.test(value))
    throw new Error("invalid_operation_input");
  return value;
}
function isResolutionCode(
  value: string,
): value is "leave_unapplied" | "reject_payment" | "mark_duplicate" | "ignore" {
  return [
    "leave_unapplied",
    "reject_payment",
    "mark_duplicate",
    "ignore",
  ].includes(value);
}
function isExportFormat(value: string): value is AccountingExportFormat {
  return [
    "payments_csv",
    "invoices_csv",
    "allocations_csv",
    "journals_csv",
    "quickbooks_csv",
  ].includes(value);
}
