import { cookies } from "next/headers";
import { OperationsDashboard } from "../../components/operations-dashboard";
import { listPaymentExceptions } from "../../lib/operations-api";
import { payopsCookieHeader } from "../../lib/auth-cookie";
import {
  assignExceptionAction,
  exportAccountingAction,
  generateEvidenceAction,
  resolveExceptionAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const store = await cookies();
  const cookie = payopsCookieHeader(store.getAll());
  const states = ["open", "assigned", "investigating", "escalated"] as const;
  const activePages = await Promise.all(
    states.map((state) => listPaymentExceptions(cookie, { limit: 100, state })),
  );
  const closedPages = await Promise.all(
    (["resolved", "ignored"] as const).map((state) =>
      listPaymentExceptions(cookie, { limit: 25, state }),
    ),
  );
  const exceptions = [
    ...activePages.flatMap((page) => page.data),
    ...closedPages.flatMap((page) => page.data),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <OperationsDashboard
      exceptions={exceptions}
      now={new Date()}
      actions={{
        assign: assignExceptionAction,
        resolve: resolveExceptionAction,
        evidence: generateEvidenceAction,
        export: exportAccountingAction,
      }}
    />
  );
}
