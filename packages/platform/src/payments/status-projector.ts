import { randomUUID } from "node:crypto";
import type { LifecycleEvent } from "@payops/contracts";
import {
  reconcileEvent,
  type FinalizedPaymentEvent,
  type InvoiceRecord as ReconciliationInvoice,
  type ReconciliationDecision,
} from "@payops/reconciliation";
import { createLifecycleEvent, enqueueLifecycleEvent } from "@payops/webhooks";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import {
  ensureDefaultLedgerAccounts,
  postJournalEntry,
  type FunctionalCurrency,
} from "../operations/ledger-store.js";
import { ASSET_SYMBOLS, assetBySymbol } from "../wallets/asset-registry.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ChainState =
  | "detected"
  | "confirmed"
  | "finalized"
  | "failed"
  | "reverted"
  | "quarantined";
type PublicStatus =
  | "awaiting_payment"
  | "detected"
  | "confirmed"
  | "finalized"
  | "paid"
  | "expired"
  | "confirmation_revoked"
  | "exception";

export interface ProjectionBatchResult {
  readonly examined: number;
  readonly changed: number;
}

export type ProjectionResult =
  | { readonly outcome: "not_found" | "unchanged" }
  | {
      readonly outcome: "changed";
      readonly publicStatus: PublicStatus;
      readonly version: number;
    };

export class PaymentStatusProjector {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async projectAvailable(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly now: Date;
    readonly limit?: number;
  }): Promise<ProjectionBatchResult> {
    validateInput(input.organizationId, input.now);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Invalid projection batch limit");
    }
    const candidates = await this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) =>
        sql<{ event_id: string }[]>`
          SELECT DISTINCT event.event_id
          FROM hosted_payment_expectations AS expectation
          JOIN payment_projections AS projection
            ON projection.organization_id = expectation.organization_id
              AND projection.attempt_id = expectation.attempt_id
          JOIN event_references AS reference
            ON reference.reference_address = expectation.reference_address
          JOIN chain_events AS event ON event.id = reference.chain_event_id
          WHERE expectation.organization_id = ${input.organizationId}::uuid
            AND expectation.active
            AND (
              (
                event.current_state = 'detected'
                AND projection.source_state IN (
                  'awaiting_payment', 'confirmation_revoked'
                )
              ) OR (
                event.current_state = 'confirmed'
                AND projection.source_state IN (
                  'awaiting_payment', 'detected', 'confirmation_revoked'
                )
              ) OR (
                event.current_state = 'finalized'
                AND projection.public_status NOT IN ('paid', 'exception')
              ) OR (
                event.current_state IN ('failed', 'reverted', 'quarantined')
                AND projection.public_status IN ('detected', 'confirmed')
              )
            )
          ORDER BY event.event_id
          LIMIT ${limit}
        `,
    );
    let changed = 0;
    for (const candidate of candidates) {
      const result = await this.projectOne({
        ...input,
        chainEventId: candidate.event_id,
      });
      if (result.outcome === "changed") changed += 1;
    }
    return { examined: candidates.length, changed };
  }

  public async projectOne(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly chainEventId: string;
    readonly now: Date;
  }): Promise<ProjectionResult> {
    validateInput(input.organizationId, input.now);
    if (input.chainEventId.length < 1 || input.chainEventId.length > 128) {
      throw new TypeError("Invalid chain event ID");
    }
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const root = await lockProjectionRoot(
          sql,
          input.organizationId,
          input.chainEventId,
        );
        if (root === undefined) return { outcome: "not_found" };
        if (isRevokedChainState(root.current_state)) {
          return projectRevocation(sql, root, input.now);
        }
        if (!isObservedChainState(root.current_state)) {
          return { outcome: "unchanged" };
        }

        let latest = root;
        const observation = await advanceObservedState(
          sql,
          latest,
          root.current_state,
          input.now,
        );
        if (observation.changed) latest = observation.root;
        if (root.current_state !== "finalized") {
          return observation.changed
            ? changed(latest)
            : { outcome: "unchanged" };
        }
        if (
          latest.public_status === "paid" ||
          latest.public_status === "exception"
        ) {
          return observation.changed
            ? changed(latest)
            : { outcome: "unchanged" };
        }

        const decision =
          root.references.length === 1
            ? reconcileEvent(paymentEvent(root), [reconciliationInvoice(root)])
            : ambiguousReferenceDecision(root);
        return decision.kind === "allocation"
          ? projectAllocation(sql, latest, decision, input.now)
          : projectException(sql, latest, decision, input.now);
      },
    );
  }
}

interface ProjectionRootRow {
  readonly organization_id: string;
  readonly chain_event_db_id: string;
  readonly event_id: string;
  readonly cluster: "mainnet-beta";
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number;
  readonly current_state: ChainState;
  readonly parser_version: string;
  readonly mint: string;
  readonly destination_token_account: string;
  readonly amount_base_units: string;
  readonly decimals: number;
  readonly references: readonly string[];
  readonly block_time: Date | null;
  readonly attempt_id: string;
  readonly public_attempt_id: string;
  readonly invoice_id: string;
  readonly invoice_public_reference: string;
  readonly settlement_wallet_id: string;
  readonly customer_id: string;
  readonly reference_address: string;
  readonly recipient_token_account: string;
  readonly expected_mint: string;
  readonly expected_amount_base_units: string;
  readonly asset_symbol: "USDC" | "USDT";
  readonly invoice_currency: FunctionalCurrency;
  readonly invoice_minor_units: string;
  readonly invoice_issued_at: Date;
  readonly observation_slot: string | null;
  readonly quote_issued_at: Date;
  readonly latest_qualifying_at: Date;
  readonly invoice_status: "issued" | "paid";
  readonly invoice_version: number;
  readonly public_status: PublicStatus;
  readonly source_state: string;
  readonly projection_version: number;
}

async function lockProjectionRoot(
  sql: OrganizationTransaction,
  organizationId: string,
  eventId: string,
): Promise<ProjectionRootRow | undefined> {
  const rows = await sql<ProjectionRootRow[]>`
    SELECT expectation.organization_id::text AS organization_id,
      event.id::text AS chain_event_db_id, event.event_id, event.cluster,
      event.signature, event.outer_instruction_index,
      event.inner_instruction_index, event.current_state,
      transfer.parser_version, transfer.mint,
      transfer.destination_token_account, transfer.amount_base_units::text,
      transfer.decimals,
      ARRAY(
        SELECT value.reference_address FROM event_references AS value
        WHERE value.chain_event_id = event.id ORDER BY value.reference_address
      ) AS references,
      CASE WHEN raw.body->>'blockTime' ~ '^[0-9]+$'
        THEN to_timestamp((raw.body->>'blockTime')::double precision)
        ELSE NULL END AS block_time,
      attempt.id::text AS attempt_id,
      attempt.public_attempt_id::text AS public_attempt_id,
      invoice.id::text AS invoice_id,
      invoice.public_reference AS invoice_public_reference,
      invoice.settlement_wallet_id::text AS settlement_wallet_id,
      invoice.customer_id::text AS customer_id,
      expectation.reference_address,
      expectation.recipient_token_account,
      expectation.mint AS expected_mint,
      expectation.amount_base_units::text AS expected_amount_base_units,
      attempt.asset_symbol,
      quote.invoice_currency,
      quote.invoice_minor_units::text,
      invoice.issued_at AS invoice_issued_at,
      (
        SELECT max(discovered.slot)::text
        FROM discovered_signatures AS discovered
        WHERE discovered.signature = event.signature
          AND discovered.raw_transaction_id = raw.id
      ) AS observation_slot,
      quote.issued_at AS quote_issued_at,
      expectation.latest_qualifying_at,
      invoice.status AS invoice_status, invoice.version AS invoice_version,
      projection.public_status, projection.source_state,
      projection.version AS projection_version
    FROM chain_events AS event
    JOIN raw_transactions AS raw ON raw.id = event.raw_transaction_id
    JOIN LATERAL (
      SELECT normalized.* FROM normalized_transfers AS normalized
      WHERE normalized.chain_event_id = event.id
      ORDER BY payops_semver_key(normalized.parser_version) DESC,
        normalized.parser_version DESC
      LIMIT 1 FOR SHARE
    ) AS transfer ON true
    JOIN event_references AS reference ON reference.chain_event_id = event.id
    JOIN hosted_payment_expectations AS expectation
      ON expectation.organization_id = ${organizationId}::uuid
      AND expectation.reference_address = reference.reference_address
      AND expectation.active
    JOIN payment_attempts AS attempt
      ON attempt.organization_id = expectation.organization_id
      AND attempt.id = expectation.attempt_id
    JOIN payment_quotes AS quote
      ON quote.organization_id = attempt.organization_id
      AND quote.attempt_id = attempt.id
    JOIN merchant_invoices AS invoice
      ON invoice.organization_id = attempt.organization_id
      AND invoice.id = attempt.invoice_id
    JOIN payment_projections AS projection
      ON projection.organization_id = attempt.organization_id
      AND projection.attempt_id = attempt.id
    WHERE event.event_id = ${eventId} AND event.cluster = 'mainnet-beta'
    ORDER BY expectation.created_at DESC
    LIMIT 1
    FOR UPDATE OF event, expectation, attempt, invoice, projection
  `;
  return rows[0];
}

function paymentEvent(root: ProjectionRootRow): FinalizedPaymentEvent {
  return {
    chainEventId: root.chain_event_db_id,
    eventId: root.event_id,
    cluster: root.cluster,
    signature: root.signature,
    outerInstructionIndex: root.outer_instruction_index,
    innerInstructionIndex:
      root.inner_instruction_index === -1 ? null : root.inner_instruction_index,
    mint: root.mint,
    destinationTokenAccount: root.destination_token_account,
    amountBaseUnits: BigInt(root.amount_base_units),
    decimals: root.decimals,
    references: root.references,
    blockTime: root.block_time,
  };
}

function reconciliationInvoice(root: ProjectionRootRow): ReconciliationInvoice {
  return {
    invoiceId: root.invoice_id,
    customerId: root.customer_id,
    expectedMint: root.expected_mint,
    destinationTokenAccount: root.recipient_token_account,
    amountBaseUnits: BigInt(root.expected_amount_base_units),
    referenceAddress: root.reference_address,
    issuedAt: root.quote_issued_at,
    dueAt: root.latest_qualifying_at,
    status: root.invoice_status === "paid" ? "matched" : "open",
  };
}

async function advanceObservedState(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  target: "detected" | "confirmed" | "finalized",
  occurredAt: Date,
): Promise<{ readonly changed: boolean; readonly root: ProjectionRootRow }> {
  if (!canAdvance(root.public_status, target)) {
    return { changed: false, root };
  }
  const next = await advanceProjection(
    sql,
    root,
    target,
    target,
    target,
    occurredAt,
  );
  const event: LifecycleEvent = {
    type: `payment.${target}`,
    statusAtOccurrence: target,
    object: {
      type: "payment",
      id: root.public_attempt_id,
      version: next.projection_version,
    },
    data: {
      paymentAttemptId: root.public_attempt_id,
      invoiceId: root.invoice_id,
      eventId: root.event_id,
      signature: root.signature,
      outerInstructionIndex: root.outer_instruction_index,
      innerInstructionIndex:
        root.inner_instruction_index === -1
          ? null
          : root.inner_instruction_index,
      mint: root.mint,
      amountBaseUnits: root.amount_base_units,
      commitment: target,
    },
  } as LifecycleEvent;
  await enqueueLifecycleEvent(
    sql,
    createLifecycleEvent(event, randomUUID(), occurredAt),
    occurredAt,
  );
  return { changed: true, root: next };
}

async function projectRevocation(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  occurredAt: Date,
): Promise<ProjectionResult> {
  if (!isRevokedChainState(root.current_state)) {
    throw new Error("Invalid payment revocation state");
  }
  const currentState = root.current_state;
  if (root.public_status !== "detected" && root.public_status !== "confirmed") {
    return { outcome: "unchanged" };
  }
  const previousState = root.public_status;
  const next = await advanceProjection(
    sql,
    root,
    "confirmation_revoked",
    "confirmation_revoked",
    `chain_${currentState}`,
    occurredAt,
  );
  await enqueueLifecycleEvent(
    sql,
    createLifecycleEvent(
      {
        type: "payment.confirmation_revoked",
        statusAtOccurrence: "confirmation_revoked",
        object: {
          type: "payment",
          id: root.public_attempt_id,
          version: next.projection_version,
        },
        data: {
          paymentAttemptId: root.public_attempt_id,
          invoiceId: root.invoice_id,
          eventId: root.event_id,
          signature: root.signature,
          previousState,
          currentState,
          code: `chain_${currentState}`,
        },
      },
      randomUUID(),
      occurredAt,
    ),
    occurredAt,
  );
  return changed(next);
}

async function projectAllocation(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  decision: Extract<ReconciliationDecision, { kind: "allocation" }>,
  occurredAt: Date,
): Promise<ProjectionResult> {
  const allocationId = randomUUID();
  await sql`
    INSERT INTO hosted_payment_allocations (
      id, organization_id, invoice_id, attempt_id, chain_event_id, event_id,
      parser_version, signature, outer_instruction_index,
      inner_instruction_index, mint,
      amount_base_units, rule_code, rule_version, active, created_at
  ) VALUES (
      ${allocationId}::uuid, ${root.organization_id}::uuid,
      ${root.invoice_id}::uuid, ${root.attempt_id}::uuid,
      ${root.chain_event_db_id}::bigint, ${decision.eventId},
      ${root.parser_version},
      ${decision.signature}, ${decision.outerInstructionIndex},
      ${decision.innerInstructionIndex}, ${root.mint},
      ${decision.amountBaseUnits.toString()}, ${decision.code},
      ${decision.ruleVersion}, true, ${occurredAt.toISOString()}
    )
  `;
  await ensureInvoiceIssuedJournal(sql, root);
  await postReceiptJournal(sql, root, "payment_received", occurredAt);
  const invoiceRows = await sql<{ version: number }[]>`
    UPDATE merchant_invoices SET status = 'paid', version = version + 1,
      updated_at = ${occurredAt.toISOString()}
    WHERE organization_id = ${root.organization_id}::uuid
      AND id = ${root.invoice_id}::uuid AND status = 'issued'
    RETURNING version
  `;
  const invoice = invoiceRows[0];
  if (invoice === undefined) {
    throw new Error("Hosted invoice allocation state conflict");
  }
  const next = await advanceProjection(
    sql,
    root,
    "paid",
    "allocated",
    decision.code,
    occurredAt,
  );
  await sql`
    UPDATE hosted_payment_expectations SET active = false,
      deactivated_at = ${occurredAt.toISOString()}
    WHERE organization_id = ${root.organization_id}::uuid
      AND attempt_id = ${root.attempt_id}::uuid AND active
  `;
  await sql`
    UPDATE watch_targets SET active = false
    WHERE organization_id = ${root.organization_id}::uuid
      AND address = ${root.reference_address} AND active
  `;
  await enqueueLifecycleEvent(
    sql,
    createLifecycleEvent(
      {
        type: "invoice.paid",
        statusAtOccurrence: "paid",
        object: {
          type: "invoice",
          id: root.invoice_id,
          version: invoice.version,
        },
        data: {
          invoiceId: root.invoice_id,
          customerId: root.customer_id,
          eventId: decision.eventId,
          signature: decision.signature,
          outerInstructionIndex: decision.outerInstructionIndex,
          innerInstructionIndex: decision.innerInstructionIndex,
          mint: root.mint,
          amountBaseUnits: decision.amountBaseUnits.toString(),
          ruleCode: decision.code,
          ruleVersion: decision.ruleVersion,
        },
      },
      randomUUID(),
      occurredAt,
    ),
    occurredAt,
  );
  return changed(next);
}

async function projectException(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  decision: Extract<ReconciliationDecision, { kind: "exception" }>,
  occurredAt: Date,
): Promise<ProjectionResult> {
  const exceptionId = randomUUID();
  await sql`
    INSERT INTO hosted_payment_exceptions (
      id, organization_id, invoice_id, attempt_id, chain_event_id, event_id,
      parser_version, signature, outer_instruction_index,
      inner_instruction_index,
      amount_base_units, rule_code, rule_version, review_state,
      asset_symbol, mint, decimals, created_at
    ) VALUES (
      ${exceptionId}::uuid, ${root.organization_id}::uuid,
      ${decision.invoiceId}::uuid, ${root.attempt_id}::uuid,
      ${root.chain_event_db_id}::bigint, ${decision.eventId},
      ${root.parser_version},
      ${decision.signature}, ${decision.outerInstructionIndex},
      ${decision.innerInstructionIndex}, ${decision.amountBaseUnits.toString()},
      ${decision.code}, ${decision.ruleVersion}, 'open',
      ${symbolForMint(root.mint)}, ${root.mint}, ${root.decimals},
      ${occurredAt.toISOString()}
    )
  `;
  await ensureInvoiceIssuedJournal(sql, root);
  if (
    root.mint === root.expected_mint &&
    root.destination_token_account === root.recipient_token_account
  ) {
    await postReceiptJournal(sql, root, "unapplied_receipt", occurredAt);
  }
  const next = await advanceProjection(
    sql,
    root,
    "exception",
    "exception",
    decision.code,
    occurredAt,
  );
  await sql`
    UPDATE hosted_payment_expectations SET active = false,
      deactivated_at = ${occurredAt.toISOString()}
    WHERE organization_id = ${root.organization_id}::uuid
      AND attempt_id = ${root.attempt_id}::uuid AND active
  `;
  await sql`
    UPDATE watch_targets SET active = false
    WHERE organization_id = ${root.organization_id}::uuid
      AND address = ${root.reference_address} AND active
  `;
  await enqueueLifecycleEvent(
    sql,
    createLifecycleEvent(
      {
        type: "payment.exception_created",
        statusAtOccurrence: "open",
        object: { type: "payment_exception", id: exceptionId, version: 1 },
        data: {
          exceptionId,
          invoiceId: decision.invoiceId,
          eventId: decision.eventId,
          signature: decision.signature,
          outerInstructionIndex: decision.outerInstructionIndex,
          innerInstructionIndex: decision.innerInstructionIndex,
          amountBaseUnits: decision.amountBaseUnits.toString(),
          code: decision.code,
          ruleVersion: decision.ruleVersion,
          reviewState: "open",
        },
      },
      randomUUID(),
      occurredAt,
    ),
    occurredAt,
  );
  return changed(next);
}

function symbolForMint(mint: string): "USDC" | "USDT" | null {
  return (
    ASSET_SYMBOLS.find((symbol) => assetBySymbol(symbol).mint === mint) ?? null
  );
}

async function postReceiptJournal(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  sourceType: "payment_received" | "unapplied_receipt",
  occurredAt: Date,
): Promise<void> {
  if (root.observation_slot === null) {
    throw new Error("Finalized payment is missing its observed slot");
  }
  await ensureDefaultLedgerAccounts(sql, {
    organizationId: root.organization_id,
    actorId: "payment-projector",
    now: occurredAt,
  });
  const expected = BigInt(root.expected_amount_base_units);
  const received = BigInt(root.amount_base_units);
  const invoiceMinor = BigInt(root.invoice_minor_units);
  const valuedMinor = (invoiceMinor * received + expected / 2n) / expected;
  if (valuedMinor < 1n) {
    throw new Error("Payment receipt valuation rounded below one minor unit");
  }
  await postJournalEntry(sql, {
    organizationId: root.organization_id,
    actorKind: "system",
    actorId: "payment-projector",
    sourceType,
    sourceId: root.event_id,
    sourceVersion: 1,
    functionalCurrency: root.invoice_currency,
    description:
      sourceType === "payment_received"
        ? `Finalized ${root.asset_symbol} invoice payment`
        : `Finalized ${root.asset_symbol} receipt awaiting allocation`,
    occurredAt,
    lines: [
      {
        accountCode: `CASH_${root.asset_symbol}`,
        debitMinorUnits: valuedMinor.toString(),
        creditMinorUnits: "0",
        tokenMint: root.mint,
        tokenBaseUnits: received.toString(),
        walletId: root.settlement_wallet_id,
        chainSlot: root.observation_slot,
      },
      {
        accountCode:
          sourceType === "payment_received"
            ? "ACCOUNTS_RECEIVABLE"
            : "UNAPPLIED_CASH",
        debitMinorUnits: "0",
        creditMinorUnits: valuedMinor.toString(),
      },
    ],
  });
}

async function ensureInvoiceIssuedJournal(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
): Promise<void> {
  await ensureDefaultLedgerAccounts(sql, {
    organizationId: root.organization_id,
    actorId: "payment-projector",
    now: root.invoice_issued_at,
  });
  await postJournalEntry(sql, {
    organizationId: root.organization_id,
    actorKind: "system",
    actorId: "payment-projector",
    sourceType: "invoice_issued",
    sourceId: root.invoice_id,
    sourceVersion: root.invoice_version,
    functionalCurrency: root.invoice_currency,
    description: `Issued invoice ${root.invoice_public_reference}`,
    occurredAt: root.invoice_issued_at,
    lines: [
      {
        accountCode: "ACCOUNTS_RECEIVABLE",
        debitMinorUnits: root.invoice_minor_units,
        creditMinorUnits: "0",
      },
      {
        accountCode: "INVOICE_CLEARING",
        debitMinorUnits: "0",
        creditMinorUnits: root.invoice_minor_units,
      },
    ],
  });
}

async function advanceProjection(
  sql: OrganizationTransaction,
  root: ProjectionRootRow,
  publicStatus: PublicStatus,
  attemptState: string,
  reasonCode: string,
  occurredAt: Date,
): Promise<ProjectionRootRow> {
  const version = root.projection_version + 1;
  await sql`
    UPDATE payment_projections SET public_status = ${publicStatus},
      source_state = ${attemptState}, version = ${version},
      detected_at = CASE WHEN ${publicStatus} = 'detected' THEN ${occurredAt.toISOString()} ELSE detected_at END,
      confirmed_at = CASE WHEN ${publicStatus} = 'confirmed' THEN ${occurredAt.toISOString()} ELSE confirmed_at END,
      finalized_at = CASE WHEN ${publicStatus} = 'finalized' THEN ${occurredAt.toISOString()} ELSE finalized_at END,
      paid_at = CASE WHEN ${publicStatus} = 'paid' THEN ${occurredAt.toISOString()} ELSE paid_at END,
      exception_at = CASE WHEN ${publicStatus} = 'exception' THEN ${occurredAt.toISOString()} ELSE exception_at END,
      updated_at = ${occurredAt.toISOString()}
    WHERE organization_id = ${root.organization_id}::uuid
      AND attempt_id = ${root.attempt_id}::uuid
      AND version = ${root.projection_version}
  `;
  await sql`
    UPDATE payment_attempts SET state = ${attemptState},
      version = version + 1, updated_at = ${occurredAt.toISOString()}
    WHERE organization_id = ${root.organization_id}::uuid
      AND id = ${root.attempt_id}::uuid
  `;
  await sql`
    INSERT INTO payment_status_history (
      id, organization_id, attempt_id, source_version, from_status, to_status,
      reason_code, chain_event_id, event_id, occurred_at, created_at
    ) VALUES (
      ${randomUUID()}::uuid, ${root.organization_id}::uuid,
      ${root.attempt_id}::uuid, ${version}, ${root.public_status},
      ${publicStatus}, ${reasonCode}, ${root.chain_event_db_id}::bigint,
      ${root.event_id}, ${occurredAt.toISOString()}, ${occurredAt.toISOString()}
    )
  `;
  return {
    ...root,
    public_status: publicStatus,
    source_state: attemptState,
    projection_version: version,
  };
}

function canAdvance(current: PublicStatus, target: PublicStatus): boolean {
  if (current === "confirmation_revoked") {
    return (
      target === "detected" || target === "confirmed" || target === "finalized"
    );
  }
  const rank: Partial<Record<PublicStatus, number>> = {
    awaiting_payment: 0,
    detected: 1,
    confirmed: 2,
    finalized: 3,
    paid: 4,
  };
  return (rank[target] ?? -1) > (rank[current] ?? Number.MAX_SAFE_INTEGER);
}

function ambiguousReferenceDecision(
  root: ProjectionRootRow,
): Extract<ReconciliationDecision, { kind: "exception" }> {
  return {
    kind: "exception",
    code: "ambiguous_reference",
    ruleVersion: "0.1",
    eventId: root.event_id,
    chainEventId: root.chain_event_db_id,
    signature: root.signature,
    outerInstructionIndex: root.outer_instruction_index,
    innerInstructionIndex:
      root.inner_instruction_index === -1 ? null : root.inner_instruction_index,
    invoiceId: null,
    amountBaseUnits: BigInt(root.amount_base_units),
  };
}

function changed(root: ProjectionRootRow): ProjectionResult {
  return {
    outcome: "changed",
    publicStatus: root.public_status,
    version: root.projection_version,
  };
}

function isObservedChainState(
  value: ChainState,
): value is "detected" | "confirmed" | "finalized" {
  return value === "detected" || value === "confirmed" || value === "finalized";
}

function isRevokedChainState(
  value: ChainState,
): value is "failed" | "reverted" | "quarantined" {
  return value === "failed" || value === "reverted" || value === "quarantined";
}

function validateInput(organizationId: string, now: Date): void {
  if (!uuidPattern.test(organizationId) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid payment projection input");
  }
}
