"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  acknowledgeOperationalIncident,
  assignPaymentException,
  createAccountingExport,
  createEvidencePack,
  OperationsApiError,
  promoteProductionLive,
  resolveOperationalIncident,
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

export async function acknowledgeIncidentAction(
  formData: FormData,
): Promise<void> {
  await operationalMutation(async () =>
    acknowledgeOperationalIncident(await authCookie(), {
      incidentId: field(formData, "incidentId", 36),
      expectedVersion: version(formData),
      idempotencyKey: idempotencyKey(formData),
    }),
  );
  redirect("/operations?notice=incident_acknowledged");
}

export async function resolveIncidentAction(formData: FormData): Promise<void> {
  await operationalMutation(async () =>
    resolveOperationalIncident(await authCookie(), {
      incidentId: field(formData, "incidentId", 36),
      expectedVersion: version(formData),
      idempotencyKey: idempotencyKey(formData),
    }),
  );
  redirect("/operations?notice=incident_resolved");
}

export async function promoteProductionAction(
  formData: FormData,
): Promise<void> {
  if (field(formData, "confirmed", 4) !== "true") {
    throw new Error("promotion_confirmation_required");
  }
  await operationalMutation(async () =>
    promoteProductionLive(await authCookie(), {
      confirmed: true,
      expectedVersion: version(formData),
      idempotencyKey: idempotencyKey(formData),
    }),
  );
  redirect("/operations?notice=production_live");
}

async function operationalMutation(operation: () => Promise<unknown>) {
  try {
    await operation();
    revalidatePath("/operations");
  } catch (error) {
    if (error instanceof OperationsApiError) {
      if (
        [
          "incident_version_conflict",
          "production_control_version_conflict",
          "idempotency_conflict",
        ].includes(error.code)
      ) {
        redirect("/operations?notice=mutation_conflict");
      }
      if (error.code === "promotion_blocked") {
        redirect("/operations?notice=promotion_blocked");
      }
      if (
        [
          "authentication_required",
          "forbidden",
          "owner_session_required",
          "fresh_owner_session_required",
        ].includes(error.code)
      ) {
        redirect("/operations?notice=authorization_required");
      }
    }
    throw error;
  }
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
