import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../audit/audit-store.js";
import type { OrganizationDatabase } from "../db/organization-transaction.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeCodePattern = /^[a-z][a-z0-9_]{0,63}$/;

export const EXCEPTION_REVIEW_STATES = [
  "open",
  "assigned",
  "investigating",
  "escalated",
  "resolved",
  "ignored",
] as const;
export type ExceptionReviewState = (typeof EXCEPTION_REVIEW_STATES)[number];

export const NON_FINANCIAL_RESOLUTION_CODES = [
  "leave_unapplied",
  "reject_payment",
  "mark_duplicate",
  "ignore",
] as const;
export type NonFinancialResolutionCode =
  (typeof NON_FINANCIAL_RESOLUTION_CODES)[number];

export interface PaymentExceptionRecord {
  readonly id: string;
  readonly invoiceId: string | null;
  readonly attemptId: string;
  readonly eventId: string;
  readonly signature: string;
  readonly amountBaseUnits: string;
  readonly assetSymbol: "USDC" | "USDT" | null;
  readonly mint: string;
  readonly decimals: number;
  readonly ruleCode: string;
  readonly ruleVersion: string;
  readonly reviewState: ExceptionReviewState;
  readonly assignedTo: string | null;
  readonly resolutionCode: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface ExceptionCaseEvent {
  readonly id: string;
  readonly sequence: number;
  readonly eventType:
    | "assigned"
    | "investigation_started"
    | "escalated"
    | "resolved"
    | "ignored"
    | "reopened";
  readonly fromState: ExceptionReviewState;
  readonly toState: ExceptionReviewState;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly occurredAt: string;
}

export class ExceptionStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super("Exception operation failed", cause === undefined ? {} : { cause });
    this.name = "ExceptionStoreError";
    this.code = code;
  }
}

export class ExceptionStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async list(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly limit: number;
    readonly state?: ExceptionReviewState;
    readonly after?: { readonly createdAt: string; readonly id: string };
  }): Promise<readonly PaymentExceptionRecord[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101 ||
      (input.state !== undefined &&
        !EXCEPTION_REVIEW_STATES.includes(input.state)) ||
      (input.after !== undefined &&
        (!uuidPattern.test(input.after.id) ||
          !Number.isFinite(new Date(input.after.createdAt).getTime())))
    ) {
      throw new ExceptionStoreError("invalid_exception_list");
    }
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<ExceptionRow[]>`
          SELECT id::text, invoice_id::text, attempt_id::text, event_id,
            signature, amount_base_units::text, asset_symbol, mint, decimals,
            rule_code, rule_version,
            review_state, assigned_to, resolution_code, resolution_note,
            resolved_by, resolved_at, version, created_at
          FROM hosted_payment_exceptions
          WHERE organization_id = ${input.organizationId}::uuid
            AND (${input.state ?? null}::text IS NULL OR review_state = ${input.state ?? null})
            AND (
              ${input.after?.createdAt ?? null}::timestamptz IS NULL
              OR (created_at, id) < (
                ${input.after?.createdAt ?? null}::timestamptz,
                ${input.after?.id ?? null}::uuid
              )
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit}
        `;
        return rows.map(toRecord);
      },
    );
  }

  public async history(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly exceptionId: string;
  }): Promise<readonly ExceptionCaseEvent[] | null> {
    if (!uuidPattern.test(input.exceptionId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const parents = await sql<{ present: boolean }[]>`
          SELECT EXISTS(
            SELECT 1 FROM hosted_payment_exceptions
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.exceptionId}::uuid
          ) AS present
        `;
        if (parents[0]?.present !== true) return null;
        const rows = await sql<ExceptionEventRow[]>`
          SELECT id::text, sequence, event_type, from_state, to_state,
            actor_id, reason_code, note, occurred_at
          FROM exception_case_events
          WHERE organization_id = ${input.organizationId}::uuid
            AND exception_id = ${input.exceptionId}::uuid
          ORDER BY sequence
        `;
        return rows.map(toEvent);
      },
    );
  }

  public async startInvestigation(
    input: TransitionContext,
  ): Promise<PaymentExceptionRecord> {
    return this.#transition(input, {
      allowedFrom: ["open", "assigned"],
      toState: "investigating",
      eventType: "investigation_started",
    });
  }

  public async escalate(
    input: TransitionContext,
  ): Promise<PaymentExceptionRecord> {
    return this.#transition(input, {
      allowedFrom: ["open", "assigned", "investigating"],
      toState: "escalated",
      eventType: "escalated",
    });
  }

  public async reopen(
    input: TransitionContext,
  ): Promise<PaymentExceptionRecord> {
    return this.#transition(input, {
      allowedFrom: ["resolved", "ignored"],
      toState: "open",
      eventType: "reopened",
    });
  }

  public async assign(
    input: MutationContext & {
      readonly assignee: string;
      readonly expectedVersion: number;
      readonly note?: string;
    },
  ): Promise<PaymentExceptionRecord> {
    const assignee = boundedText(input.assignee, 128, "invalid_assignee");
    const note = optionalText(input.note, 2000, "invalid_exception_note");
    return this.#mutate(input, async (row, sql) => {
      if (row.review_state === "resolved" || row.review_state === "ignored") {
        throw new ExceptionStoreError("exception_closed");
      }
      const nextVersion = row.version + 1;
      const nextState =
        row.review_state === "open" ? "assigned" : row.review_state;
      const rows = await sql<ExceptionRow[]>`
        UPDATE hosted_payment_exceptions
        SET review_state = ${nextState}, assigned_to = ${assignee},
          version = ${nextVersion}
        WHERE organization_id = ${input.organizationId}::uuid
          AND id = ${input.exceptionId}::uuid AND version = ${row.version}
        RETURNING id::text, invoice_id::text, attempt_id::text, event_id,
          signature, amount_base_units::text, asset_symbol, mint, decimals,
          rule_code, rule_version,
          review_state, assigned_to, resolution_code, resolution_note,
          resolved_by, resolved_at, version, created_at
      `;
      await insertEvent(sql, input, {
        sequence: nextVersion - 1,
        eventType: "assigned",
        fromState: row.review_state,
        toState: nextState,
        reasonCode: "assigned",
        note,
      });
      return rows[0]!;
    });
  }

  public async resolve(
    input: MutationContext & {
      readonly resolutionCode: NonFinancialResolutionCode;
      readonly note: string;
      readonly expectedVersion: number;
    },
  ): Promise<PaymentExceptionRecord> {
    if (!NON_FINANCIAL_RESOLUTION_CODES.includes(input.resolutionCode)) {
      throw new ExceptionStoreError("invalid_resolution_code");
    }
    const note = boundedText(input.note, 2000, "invalid_exception_note");
    return this.#mutate(input, async (row, sql) => {
      if (row.review_state === "resolved" || row.review_state === "ignored") {
        throw new ExceptionStoreError("exception_closed");
      }
      const nextState =
        input.resolutionCode === "ignore" ? "ignored" : "resolved";
      const nextVersion = row.version + 1;
      const rows = await sql<ExceptionRow[]>`
        UPDATE hosted_payment_exceptions
        SET review_state = ${nextState}, resolution_code = ${input.resolutionCode},
          resolution_note = ${note}, resolved_by = ${input.actorId},
          resolved_at = ${input.now.toISOString()}, version = ${nextVersion}
        WHERE organization_id = ${input.organizationId}::uuid
          AND id = ${input.exceptionId}::uuid AND version = ${row.version}
        RETURNING id::text, invoice_id::text, attempt_id::text, event_id,
          signature, amount_base_units::text, asset_symbol, mint, decimals,
          rule_code, rule_version,
          review_state, assigned_to, resolution_code, resolution_note,
          resolved_by, resolved_at, version, created_at
      `;
      await insertEvent(sql, input, {
        sequence: nextVersion - 1,
        eventType: nextState === "ignored" ? "ignored" : "resolved",
        fromState: row.review_state,
        toState: nextState,
        reasonCode: input.resolutionCode,
        note,
      });
      return rows[0]!;
    });
  }

  async #transition(
    input: TransitionContext,
    transition: {
      readonly allowedFrom: readonly ExceptionReviewState[];
      readonly toState: ExceptionReviewState;
      readonly eventType: ExceptionCaseEvent["eventType"];
    },
  ): Promise<PaymentExceptionRecord> {
    const reasonCode = boundedCode(input.reasonCode);
    const note = optionalText(input.note, 2000, "invalid_exception_note");
    return this.#mutate(input, async (row, sql) => {
      if (!transition.allowedFrom.includes(row.review_state)) {
        throw new ExceptionStoreError("invalid_exception_transition");
      }
      const nextVersion = row.version + 1;
      const reopening = transition.eventType === "reopened";
      const rows = await sql<ExceptionRow[]>`
        UPDATE hosted_payment_exceptions
        SET review_state = ${transition.toState}, version = ${nextVersion},
          assigned_to = CASE WHEN ${reopening} THEN NULL ELSE assigned_to END,
          resolution_code = CASE WHEN ${reopening} THEN NULL ELSE resolution_code END,
          resolution_note = CASE WHEN ${reopening} THEN NULL ELSE resolution_note END,
          resolved_by = CASE WHEN ${reopening} THEN NULL ELSE resolved_by END,
          resolved_at = CASE WHEN ${reopening} THEN NULL ELSE resolved_at END
        WHERE organization_id = ${input.organizationId}::uuid
          AND id = ${input.exceptionId}::uuid AND version = ${row.version}
        RETURNING id::text, invoice_id::text, attempt_id::text, event_id,
          signature, amount_base_units::text, asset_symbol, mint, decimals,
          rule_code, rule_version,
          review_state, assigned_to, resolution_code, resolution_note,
          resolved_by, resolved_at, version, created_at
      `;
      await insertEvent(sql, input, {
        sequence: nextVersion - 1,
        eventType: transition.eventType,
        fromState: row.review_state,
        toState: transition.toState,
        reasonCode,
        note,
      });
      return rows[0]!;
    });
  }

  async #mutate(
    input: MutationContext & { readonly expectedVersion: number },
    operation: (
      row: ExceptionRow,
      sql: Parameters<Parameters<OrganizationDatabase["transaction"]>[1]>[0],
    ) => Promise<ExceptionRow>,
  ): Promise<PaymentExceptionRecord> {
    validateMutation(input);
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const rows = await sql<ExceptionRow[]>`
            SELECT id::text, invoice_id::text, attempt_id::text, event_id,
              signature, amount_base_units::text, asset_symbol, mint, decimals,
              rule_code, rule_version,
              review_state, assigned_to, resolution_code, resolution_note,
              resolved_by, resolved_at, version, created_at
            FROM hosted_payment_exceptions
            WHERE organization_id = ${input.organizationId}::uuid
              AND id = ${input.exceptionId}::uuid
            FOR UPDATE
          `;
          const row = rows[0];
          if (row === undefined)
            throw new ExceptionStoreError("exception_not_found");
          if (row.version !== input.expectedVersion) {
            throw new ExceptionStoreError("exception_version_conflict");
          }
          const updated = await operation(row, sql);
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(sql, {
              organizationId: input.organizationId,
              actorKind: input.actorKind,
              actorId: input.actorId,
              action: "exception.update",
              objectKind: "payment_exception",
              objectId: input.exceptionId,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: updated.review_state,
              occurredAt: input.now,
            });
          }
          const record = toRecord(updated);
          await input.idempotency?.complete(sql, 200, record);
          return record;
        },
      );
    } catch (error) {
      if (error instanceof ExceptionStoreError) throw error;
      throw new ExceptionStoreError("exception_store_unavailable", error);
    }
  }
}

interface MutationContext {
  readonly organizationId: string;
  readonly actorKind: "session" | "api_key" | "system";
  readonly actorId: string;
  readonly exceptionId: string;
  readonly now: Date;
  readonly auditRequestId?: string;
  readonly idempotency?: IdempotencyResponseCommitter;
}

interface TransitionContext extends MutationContext {
  readonly expectedVersion: number;
  readonly reasonCode: string;
  readonly note?: string;
}

interface ExceptionRow {
  readonly id: string;
  readonly invoice_id: string | null;
  readonly attempt_id: string;
  readonly event_id: string;
  readonly signature: string;
  readonly amount_base_units: string;
  readonly asset_symbol: "USDC" | "USDT" | null;
  readonly mint: string;
  readonly decimals: number;
  readonly rule_code: string;
  readonly rule_version: string;
  readonly review_state: ExceptionReviewState;
  readonly assigned_to: string | null;
  readonly resolution_code: string | null;
  readonly resolution_note: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
}

interface ExceptionEventRow {
  readonly id: string;
  readonly sequence: number;
  readonly event_type: ExceptionCaseEvent["eventType"];
  readonly from_state: ExceptionReviewState;
  readonly to_state: ExceptionReviewState;
  readonly actor_id: string;
  readonly reason_code: string;
  readonly note: string | null;
  readonly occurred_at: Date;
}

async function insertEvent(
  sql: Parameters<Parameters<OrganizationDatabase["transaction"]>[1]>[0],
  input: MutationContext,
  event: {
    readonly sequence: number;
    readonly eventType: ExceptionCaseEvent["eventType"];
    readonly fromState: ExceptionReviewState;
    readonly toState: ExceptionReviewState;
    readonly reasonCode: string;
    readonly note: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO exception_case_events (
      id, organization_id, exception_id, sequence, event_type, from_state,
      to_state, actor_id, reason_code, note, occurred_at, created_at
    ) VALUES (
      ${randomUUID()}::uuid, ${input.organizationId}::uuid,
      ${input.exceptionId}::uuid, ${event.sequence}, ${event.eventType},
      ${event.fromState}, ${event.toState}, ${input.actorId},
      ${event.reasonCode}, ${event.note}, ${input.now.toISOString()},
      ${input.now.toISOString()}
    )
  `;
}

function validateMutation(
  input: MutationContext & { readonly expectedVersion: number },
): void {
  if (
    !uuidPattern.test(input.organizationId) ||
    !uuidPattern.test(input.exceptionId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !Number.isFinite(input.now.getTime()) ||
    !/^[\x21-\x7e]{1,128}$/.test(input.actorId)
  ) {
    throw new ExceptionStoreError("invalid_exception_mutation");
  }
}

function boundedText(value: string, maximum: number, code: string): string {
  const normalized = value.trim().normalize("NFC");
  if (
    [...normalized].length < 1 ||
    [...normalized].length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ExceptionStoreError(code);
  }
  return normalized;
}

function optionalText(
  value: string | undefined,
  maximum: number,
  code: string,
): string | null {
  return value === undefined ? null : boundedText(value, maximum, code);
}

function boundedCode(value: string): string {
  const normalized = value.trim();
  if (!safeCodePattern.test(normalized)) {
    throw new ExceptionStoreError("invalid_exception_reason");
  }
  return normalized;
}

function toRecord(row: ExceptionRow): PaymentExceptionRecord {
  if (
    !EXCEPTION_REVIEW_STATES.includes(row.review_state) ||
    (row.asset_symbol !== null &&
      !["USDC", "USDT"].includes(row.asset_symbol)) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(row.mint) ||
    !Number.isSafeInteger(row.decimals) ||
    row.decimals < 0 ||
    row.decimals > 18
  ) {
    throw new ExceptionStoreError("corrupt_exception");
  }
  return Object.freeze({
    id: row.id,
    invoiceId: row.invoice_id,
    attemptId: row.attempt_id,
    eventId: row.event_id,
    signature: row.signature,
    amountBaseUnits: row.amount_base_units,
    assetSymbol: row.asset_symbol,
    mint: row.mint,
    decimals: row.decimals,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    reviewState: row.review_state,
    assignedTo: row.assigned_to,
    resolutionCode: row.resolution_code,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  });
}

function toEvent(row: ExceptionEventRow): ExceptionCaseEvent {
  if (
    !EXCEPTION_REVIEW_STATES.includes(row.from_state) ||
    !EXCEPTION_REVIEW_STATES.includes(row.to_state) ||
    !safeCodePattern.test(row.reason_code)
  ) {
    throw new ExceptionStoreError("corrupt_exception_event");
  }
  return Object.freeze({
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    actorId: row.actor_id,
    reasonCode: row.reason_code,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
  });
}
