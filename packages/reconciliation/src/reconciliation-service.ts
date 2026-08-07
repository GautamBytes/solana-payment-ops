import { reconcileBatch } from "./engine/reconcile-batch.js";
import type { ReconciliationStore } from "./storage/types.js";

export interface ReconciliationRunResult {
  readonly candidates: number;
  readonly allocations: number;
  readonly exceptions: number;
  readonly applied: number;
}

export async function runReconciliation(
  store: ReconciliationStore,
  decidedAt: Date,
): Promise<ReconciliationRunResult> {
  const runId = await store.startRun(decidedAt);
  const empty = { candidates: 0, allocations: 0, exceptions: 0, applied: 0 };
  try {
    const [invoices, events] = await Promise.all([
      store.listInvoices(),
      store.listFinalizedCandidates(),
    ]);
    const decisions = reconcileBatch(events, invoices);
    let applied = 0;
    for (const decision of decisions) {
      if (await store.recordDecision(decision, decidedAt)) applied += 1;
    }
    const result = {
      candidates: decisions.length,
      allocations: decisions.filter(
        (decision) => decision.kind === "allocation",
      ).length,
      exceptions: decisions.filter((decision) => decision.kind === "exception")
        .length,
      applied,
    };
    await store.completeRun(runId, "complete", result, decidedAt);
    return result;
  } catch (error) {
    await store.completeRun(runId, "failed", empty, decidedAt);
    throw error;
  }
}
