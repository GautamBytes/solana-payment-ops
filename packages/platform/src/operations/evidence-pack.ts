import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { createLifecycleEvent, enqueueLifecycleEvent } from "@payops/webhooks";
import { appendAuditEvent } from "../audit/audit-store.js";
import type { OrganizationDatabase } from "../db/organization-transaction.js";
import { canonicalJson } from "../idempotency/idempotency-store.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const maximumEvidenceBytes = 10_485_760;
const maximumEvidenceRows = 10_000;

export interface PaymentEvidencePack {
  readonly id: string;
  readonly invoiceId: string;
  readonly schemaVersion: "0.1";
  readonly manifestBytes: Uint8Array;
  readonly pdfBytes: Uint8Array;
  readonly manifestDigest: string;
  readonly signature: Uint8Array;
  readonly signingKeyId: string;
  readonly publicKeyPem: string;
  readonly generatedAt: string;
}

export class EvidencePackError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Evidence pack operation failed",
      cause === undefined ? {} : { cause },
    );
    this.name = "EvidencePackError";
    this.code = code;
  }
}

export class EvidencePackService {
  readonly #database: OrganizationDatabase;
  readonly #signingKeyId: string;
  readonly #privateKey: KeyObject;
  readonly #publicKeyPem: string;

  public constructor(
    database: OrganizationDatabase,
    options: { readonly signingKeyId: string; readonly privateKeyPem: string },
  ) {
    this.#database = database;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.signingKeyId)) {
      throw new EvidencePackError("invalid_evidence_signing_key_id");
    }
    try {
      const key = createPrivateKey(options.privateKeyPem);
      if (key.asymmetricKeyType !== "ed25519")
        throw new Error("wrong key type");
      this.#privateKey = key;
      this.#publicKeyPem = createPublicKey(key)
        .export({ type: "spki", format: "pem" })
        .toString();
    } catch (error) {
      throw new EvidencePackError("invalid_evidence_signing_key", error);
    }
    this.#signingKeyId = options.signingKeyId;
  }

  public async generate(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key" | "system";
    readonly actorId: string;
    readonly invoiceId: string;
    readonly now: Date;
    readonly auditRequestId?: string;
    readonly idempotency?: {
      readonly committer: IdempotencyResponseCommitter;
      readonly status: number;
      readonly responseBody: (pack: PaymentEvidencePack) => unknown;
    };
  }): Promise<PaymentEvidencePack> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.invoiceId) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new EvidencePackError("invalid_evidence_request");
    }
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (sql) => {
          const invoices = await sql<InvoiceEvidenceRow[]>`
            SELECT invoice.id::text, invoice.public_reference,
              invoice.external_id, invoice.currency,
              invoice.total_minor_units::text, invoice.status,
              invoice.due_at, invoice.issued_at, invoice.version,
              customer.id::text AS customer_id,
              customer.display_name AS customer_name,
              wallet.address AS settlement_wallet,
              wallet.verified_at AS wallet_verified_at,
              snapshot.canonical_payload AS invoice_snapshot,
              snapshot.payload_digest AS invoice_snapshot_digest
            FROM merchant_invoices AS invoice
            JOIN customers AS customer
              ON customer.organization_id = invoice.organization_id
              AND customer.id = invoice.customer_id
            JOIN merchant_wallets AS wallet
              ON wallet.organization_id = invoice.organization_id
              AND wallet.id = invoice.settlement_wallet_id
            LEFT JOIN merchant_invoice_issued_snapshots AS snapshot
              ON snapshot.organization_id = invoice.organization_id
              AND snapshot.invoice_id = invoice.id
            WHERE invoice.organization_id = ${input.organizationId}::uuid
              AND invoice.id = ${input.invoiceId}::uuid
          `;
          const invoice = invoices[0];
          if (invoice === undefined)
            throw new EvidencePackError("invoice_not_found");
          const volume = await sql<{ row_count: string }[]>`
            SELECT (
              (SELECT count(*) FROM payment_attempts
                WHERE organization_id = ${input.organizationId}::uuid
                  AND invoice_id = ${input.invoiceId}::uuid)
              + (SELECT count(*) FROM hosted_payment_allocations
                WHERE organization_id = ${input.organizationId}::uuid
                  AND invoice_id = ${input.invoiceId}::uuid)
              + (SELECT count(*) FROM hosted_payment_exceptions
                WHERE organization_id = ${input.organizationId}::uuid
                  AND invoice_id = ${input.invoiceId}::uuid)
              + (SELECT count(*) FROM payment_status_history AS history
                  JOIN payment_attempts AS attempt
                    ON attempt.organization_id = history.organization_id
                    AND attempt.id = history.attempt_id
                WHERE history.organization_id = ${input.organizationId}::uuid
                  AND attempt.invoice_id = ${input.invoiceId}::uuid)
              + (SELECT count(*) FROM journal_lines AS line
                  JOIN journal_entries AS entry
                    ON entry.organization_id = line.organization_id
                    AND entry.id = line.journal_entry_id
                WHERE entry.organization_id = ${input.organizationId}::uuid
                  AND (entry.source_id = ${input.invoiceId} OR entry.source_id IN (
                    SELECT event_id FROM hosted_payment_allocations
                    WHERE organization_id = ${input.organizationId}::uuid
                      AND invoice_id = ${input.invoiceId}::uuid
                    UNION SELECT event_id FROM hosted_payment_exceptions
                    WHERE organization_id = ${input.organizationId}::uuid
                      AND invoice_id = ${input.invoiceId}::uuid
                  )))
              + (SELECT count(*) FROM exception_case_events AS history
                  JOIN hosted_payment_exceptions AS exception
                    ON exception.organization_id = history.organization_id
                    AND exception.id = history.exception_id
                WHERE history.organization_id = ${input.organizationId}::uuid
                  AND exception.invoice_id = ${input.invoiceId}::uuid)
              + (SELECT count(*) FROM webhook_events AS event
                WHERE event.payload::jsonb->'data'->>'invoiceId' = ${input.invoiceId})
            )::text AS row_count
          `;
          if (BigInt(volume[0]!.row_count) > BigInt(maximumEvidenceRows)) {
            throw new EvidencePackError("evidence_pack_too_large");
          }
          const attempts = await sql<AttemptEvidenceRow[]>`
            SELECT attempt.id::text, attempt.public_attempt_id::text,
              attempt.asset_symbol, attempt.reference_address,
              attempt.recipient_address, attempt.recipient_token_account,
              attempt.mint, attempt.state, attempt.version,
              quote.formula_version, quote.invoice_currency,
              quote.invoice_minor_units::text, quote.stablecoin_usd_price,
              quote.token_amount, quote.amount_base_units::text,
              quote.amount_tokens, quote.input_digest, quote.issued_at,
              quote.expires_at, quote.issuance_slot::text,
              stable.source AS stablecoin_source,
              stable.publish_time AS stablecoin_publish_time,
              stable.confidence AS stablecoin_confidence,
              fiat.source AS fiat_source, fiat.usage AS fiat_usage,
              fiat.published_at AS fiat_published_at
            FROM payment_attempts AS attempt
            JOIN payment_quotes AS quote
              ON quote.organization_id = attempt.organization_id
              AND quote.attempt_id = attempt.id
            JOIN quote_rate_observations AS stable
              ON stable.organization_id = quote.organization_id
              AND stable.id = quote.stablecoin_observation_id
            LEFT JOIN quote_rate_observations AS fiat
              ON fiat.organization_id = quote.organization_id
              AND fiat.id = quote.fiat_observation_id
            WHERE attempt.organization_id = ${input.organizationId}::uuid
              AND attempt.invoice_id = ${input.invoiceId}::uuid
            ORDER BY quote.issued_at, attempt.id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const allocations = await sql<AllocationEvidenceRow[]>`
            SELECT allocation.id::text, allocation.event_id,
              allocation.signature, allocation.outer_instruction_index,
              allocation.inner_instruction_index, allocation.mint,
              allocation.amount_base_units::text, allocation.rule_code,
              allocation.rule_version, allocation.created_at,
              event.current_state, transfer.program_id AS token_program,
              transfer.source_token_account,
              transfer.destination_token_account, transfer.authority,
              transfer.decimals
            FROM hosted_payment_allocations AS allocation
            JOIN chain_events AS event ON event.id = allocation.chain_event_id
            JOIN normalized_transfers AS transfer
              ON transfer.chain_event_id = allocation.chain_event_id
              AND transfer.parser_version = allocation.parser_version
            WHERE allocation.organization_id = ${input.organizationId}::uuid
              AND allocation.invoice_id = ${input.invoiceId}::uuid
            ORDER BY allocation.created_at, allocation.id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const exceptions = await sql<ExceptionEvidenceRow[]>`
            SELECT id::text, event_id, signature, outer_instruction_index,
              inner_instruction_index, amount_base_units::text, rule_code,
              rule_version, review_state, assigned_to, resolution_code,
              resolution_note, resolved_by, resolved_at, version, created_at
            FROM hosted_payment_exceptions
            WHERE organization_id = ${input.organizationId}::uuid
              AND invoice_id = ${input.invoiceId}::uuid
            ORDER BY created_at, id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const chainEvents = await sql<ChainEventEvidenceRow[]>`
            WITH evidence_sources AS (
              SELECT allocation.chain_event_id, allocation.parser_version,
                allocation.attempt_id
              FROM hosted_payment_allocations AS allocation
              WHERE allocation.organization_id = ${input.organizationId}::uuid
                AND allocation.invoice_id = ${input.invoiceId}::uuid
              UNION
              SELECT exception.chain_event_id, exception.parser_version,
                exception.attempt_id
              FROM hosted_payment_exceptions AS exception
              WHERE exception.organization_id = ${input.organizationId}::uuid
                AND exception.invoice_id = ${input.invoiceId}::uuid
            )
            SELECT event.event_id, event.cluster, event.signature,
              event.outer_instruction_index, event.inner_instruction_index,
              event.current_state, transfer.parser_version,
              transfer.program_id AS token_program,
              transfer.source_token_account,
              transfer.destination_token_account, transfer.authority,
              transfer.mint, transfer.amount_base_units::text,
              transfer.decimals, raw.provider_id,
              raw.commitment AS captured_commitment,
              raw.digest AS raw_transaction_digest,
              raw.byte_length AS raw_transaction_byte_length,
              raw.retrieved_at AS raw_transaction_retrieved_at,
              observation.slot::text, observation.block_time::text,
              observation.confirmation_status,
              observation.finality_state AS observed_finality_state,
              observation.observed_at,
              projection.detected_at, projection.confirmed_at,
              projection.finalized_at
            FROM evidence_sources AS source
            JOIN chain_events AS event ON event.id = source.chain_event_id
            JOIN normalized_transfers AS transfer
              ON transfer.chain_event_id = source.chain_event_id
              AND transfer.parser_version = source.parser_version
            JOIN raw_transactions AS raw ON raw.id = event.raw_transaction_id
            LEFT JOIN payment_projections AS projection
              ON projection.organization_id = ${input.organizationId}::uuid
              AND projection.attempt_id = source.attempt_id
            LEFT JOIN LATERAL (
              SELECT discovered.slot, discovered.block_time,
                discovered.confirmation_status, discovered.finality_state,
                discovered.observed_at
              FROM discovered_signatures AS discovered
              WHERE discovered.signature = event.signature
                AND discovered.provider_id = raw.provider_id
                AND discovered.raw_transaction_id = raw.id
              ORDER BY discovered.observed_at, discovered.watch_target_id
              LIMIT 1
            ) AS observation ON true
            ORDER BY event.cluster, event.signature,
              event.outer_instruction_index, event.inner_instruction_index,
              transfer.parser_version
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const exceptionEvents = await sql<ExceptionCaseEvidenceRow[]>`
            SELECT event.exception_id::text, event.sequence, event.event_type,
              event.from_state, event.to_state, event.actor_id,
              event.reason_code, event.note, event.occurred_at
            FROM exception_case_events AS event
            JOIN hosted_payment_exceptions AS exception
              ON exception.organization_id = event.organization_id
              AND exception.id = event.exception_id
            WHERE event.organization_id = ${input.organizationId}::uuid
              AND exception.invoice_id = ${input.invoiceId}::uuid
            ORDER BY event.exception_id, event.sequence
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const journals = await sql<JournalEvidenceRow[]>`
            SELECT entry.id::text, entry.source_type, entry.source_id,
              entry.source_version, entry.functional_currency,
              entry.description, entry.occurred_at, entry.posted_by,
              entry.payload_digest,
              json_agg(json_build_object(
                'lineNumber', line.line_number, 'accountCode', account.code,
                'debitMinorUnits', line.debit_minor_units::text,
                'creditMinorUnits', line.credit_minor_units::text,
                'tokenMint', line.token_mint,
                'tokenBaseUnits', line.token_base_units::text,
                'walletId', line.wallet_id::text,
                'chainSlot', line.chain_slot::text,
                'memo', line.memo
              ) ORDER BY line.line_number) AS lines
            FROM journal_entries AS entry
            JOIN journal_lines AS line
              ON line.organization_id = entry.organization_id
              AND line.journal_entry_id = entry.id
            JOIN ledger_accounts AS account
              ON account.organization_id = line.organization_id
              AND account.id = line.account_id
            WHERE entry.organization_id = ${input.organizationId}::uuid
              AND (entry.source_id = ${input.invoiceId} OR entry.source_id IN (
                SELECT event_id FROM hosted_payment_allocations
                WHERE organization_id = ${input.organizationId}::uuid
                  AND invoice_id = ${input.invoiceId}::uuid
                UNION
                SELECT event_id FROM hosted_payment_exceptions
                WHERE organization_id = ${input.organizationId}::uuid
                  AND invoice_id = ${input.invoiceId}::uuid
              ))
            GROUP BY entry.id
            ORDER BY entry.occurred_at, entry.id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const histories = await sql<StatusEvidenceRow[]>`
            SELECT history.source_version, history.from_status,
              history.to_status, history.reason_code, history.event_id,
              history.occurred_at
            FROM payment_status_history AS history
            JOIN payment_attempts AS attempt
              ON attempt.organization_id = history.organization_id
              AND attempt.id = history.attempt_id
            WHERE history.organization_id = ${input.organizationId}::uuid
              AND attempt.invoice_id = ${input.invoiceId}::uuid
            ORDER BY history.occurred_at, history.source_version
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const webhookRows = await sql<WebhookEvidenceRow[]>`
            SELECT event.id::text, event.event_type, event.source_type,
              event.source_id, event.source_version, event.payload_digest,
              event.occurred_at,
              count(delivery.id)::integer AS delivery_count,
              count(delivery.id) FILTER (
                WHERE delivery.state = 'succeeded'
              )::integer AS succeeded_count,
              count(delivery.id) FILTER (
                WHERE delivery.state = 'dead'
              )::integer AS dead_count,
              COALESCE(sum(delivery.attempt_count), 0)::integer AS attempt_count
            FROM webhook_events AS event
            LEFT JOIN webhook_deliveries AS delivery ON delivery.event_id = event.id
            WHERE event.payload::jsonb->'data'->>'invoiceId' = ${input.invoiceId}
            GROUP BY event.id
            ORDER BY event.occurred_at, event.id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          const audits = await sql<AuditEvidenceRow[]>`
            SELECT audit.id::text, audit.actor_kind, audit.actor_id,
              audit.action, audit.object_kind, audit.object_id,
              audit.request_id::text, audit.outcome, audit.reason_code,
              audit.occurred_at
            FROM audit_events AS audit
            WHERE audit.organization_id = ${input.organizationId}::uuid
              AND (
                (audit.object_kind = 'invoice'
                  AND audit.object_id = ${input.invoiceId})
                OR (
                  audit.object_kind = 'payment_exception'
                  AND audit.object_id IN (
                    SELECT id::text FROM hosted_payment_exceptions
                    WHERE organization_id = ${input.organizationId}::uuid
                      AND invoice_id = ${input.invoiceId}::uuid
                  )
                )
              )
            ORDER BY audit.occurred_at, audit.id
            LIMIT ${maximumEvidenceRows + 1}
          `;
          assertEvidenceRows([
            attempts,
            allocations,
            exceptions,
            chainEvents,
            exceptionEvents,
            journals,
            histories,
            webhookRows,
            audits,
          ]);
          const pdfBytes = renderEvidencePdf({
            invoiceReference: invoice.public_reference,
            invoiceStatus: invoice.status,
            currency: invoice.currency,
            totalMinorUnits: invoice.total_minor_units,
            allocationCount: allocations.length,
            exceptionCount: exceptions.length,
            journalCount: journals.length,
            signingKeyId: this.#signingKeyId,
            generatedAt: input.now.toISOString(),
          });
          if (pdfBytes.byteLength > maximumEvidenceBytes) {
            throw new EvidencePackError("evidence_pack_too_large");
          }
          const pdfDigest = createHash("sha256").update(pdfBytes).digest("hex");
          const manifest = Object.freeze({
            schemaVersion: "0.1",
            generatedAt: input.now.toISOString(),
            signingKeyId: this.#signingKeyId,
            notice:
              "Operational evidence only; not a legal opinion, tax certificate, or independent timestamp.",
            verification: {
              algorithm: "Ed25519",
              digestAlgorithm: "SHA-256",
              signingKeyId: this.#signingKeyId,
              command:
                "payops-platform verify-evidence --manifest <manifest.json> --pdf <evidence.pdf> --signature <base64url> --public-key <public-key.pem>",
            },
            artifacts: {
              pdf: {
                digestAlgorithm: "SHA-256",
                sha256: pdfDigest,
                byteLength: pdfBytes.byteLength,
              },
            },
            invoice: mapInvoice(invoice),
            paymentAttempts: attempts.map(mapAttempt),
            chainEvents: chainEvents.map(mapChainEvent),
            allocations: allocations.map(mapAllocation),
            exceptions: exceptions.map(mapException),
            exceptionCaseHistory: exceptionEvents.map(mapExceptionCaseEvent),
            paymentStatusHistory: histories.map(mapStatus),
            journals: journals.map(mapJournal),
            auditTrail: audits.map(mapAudit),
            webhooks: {
              events: webhookRows.map(mapWebhook),
              eventCount: webhookRows.length,
              deliveryCount: webhookRows.reduce(
                (total, row) => total + row.delivery_count,
                0,
              ),
              attemptCount: webhookRows.reduce(
                (total, row) => total + row.attempt_count,
                0,
              ),
            },
          });
          const manifestBytes = new TextEncoder().encode(
            canonicalJson(manifest),
          );
          if (manifestBytes.byteLength > maximumEvidenceBytes) {
            throw new EvidencePackError("evidence_pack_too_large");
          }
          const manifestDigest = createHash("sha256")
            .update(manifestBytes)
            .digest("hex");
          const signature = sign(null, manifestBytes, this.#privateKey);
          const id = randomUUID();
          await sql`
            INSERT INTO evidence_packs (
              id, organization_id, invoice_id, schema_version, manifest_bytes,
              pdf_bytes, manifest_digest, signature, signing_key_id,
              public_key_pem,
              generated_by, generated_at, created_at
            ) VALUES (
              ${id}::uuid, ${input.organizationId}::uuid,
              ${input.invoiceId}::uuid, '0.1', ${manifestBytes}, ${pdfBytes},
              ${manifestDigest}, ${signature}, ${this.#signingKeyId},
              ${this.#publicKeyPem},
              ${input.actorId}, ${input.now.toISOString()}, ${input.now.toISOString()}
            )
          `;
          await enqueueLifecycleEvent(
            sql,
            createLifecycleEvent(
              {
                type: "evidence.ready",
                statusAtOccurrence: "ready",
                object: { type: "evidence_pack", id, version: 1 },
                data: {
                  evidencePackId: id,
                  invoiceId: input.invoiceId,
                  manifestDigest,
                  signingKeyId: this.#signingKeyId,
                  resourceId: id,
                },
              },
              randomUUID(),
              input.now,
            ),
            input.now,
          );
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(sql, {
              organizationId: input.organizationId,
              actorKind: input.actorKind,
              actorId: input.actorId,
              action: "evidence.generate",
              objectKind: "evidence_pack",
              objectId: id,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "generated",
              occurredAt: input.now,
            });
          }
          const pack = freezePack({
            id,
            invoiceId: input.invoiceId,
            schemaVersion: "0.1",
            manifestBytes,
            pdfBytes,
            manifestDigest,
            signature,
            signingKeyId: this.#signingKeyId,
            publicKeyPem: this.#publicKeyPem,
            generatedAt: input.now.toISOString(),
          });
          if (input.idempotency !== undefined) {
            await input.idempotency.committer.complete(
              sql,
              input.idempotency.status,
              input.idempotency.responseBody(pack),
            );
          }
          return pack;
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      if (error instanceof EvidencePackError) throw error;
      throw new EvidencePackError("evidence_store_unavailable", error);
    }
  }

  public async get(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly evidencePackId: string;
  }): Promise<PaymentEvidencePack | null> {
    if (!uuidPattern.test(input.evidencePackId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (sql) => {
        const rows = await sql<EvidencePackRow[]>`
          SELECT id::text, invoice_id::text, schema_version, manifest_bytes,
            pdf_bytes, manifest_digest, signature, signing_key_id,
            public_key_pem, generated_at
          FROM evidence_packs
          WHERE organization_id = ${input.organizationId}::uuid
            AND id = ${input.evidencePackId}::uuid
        `;
        const row = rows[0];
        return row === undefined
          ? null
          : freezePack({
              id: row.id,
              invoiceId: row.invoice_id,
              schemaVersion: "0.1",
              manifestBytes: row.manifest_bytes,
              pdfBytes: row.pdf_bytes,
              manifestDigest: row.manifest_digest,
              signature: row.signature,
              signingKeyId: row.signing_key_id,
              publicKeyPem: row.public_key_pem,
              generatedAt: row.generated_at.toISOString(),
            });
      },
    );
  }
}

export function verifyEvidencePack(
  pack: Pick<
    PaymentEvidencePack,
    "manifestBytes" | "pdfBytes" | "manifestDigest" | "signature"
  >,
  publicKeyPem: string,
): boolean {
  try {
    if (
      !(pack.manifestBytes instanceof Uint8Array) ||
      !(pack.pdfBytes instanceof Uint8Array) ||
      !(pack.signature instanceof Uint8Array) ||
      pack.signature.byteLength !== 64 ||
      !digestPattern.test(pack.manifestDigest)
    ) {
      return false;
    }
    const digest = createHash("sha256")
      .update(pack.manifestBytes)
      .digest("hex");
    if (digest !== pack.manifestDigest) return false;
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(pack.manifestBytes),
    ) as unknown;
    if (!validPdfArtifact(manifest, pack.pdfBytes)) return false;
    const key = createPublicKey(publicKeyPem);
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(null, pack.manifestBytes, key, pack.signature)
    );
  } catch {
    return false;
  }
}

interface InvoiceEvidenceRow {
  readonly id: string;
  readonly public_reference: string;
  readonly external_id: string | null;
  readonly currency: string;
  readonly total_minor_units: string;
  readonly status: string;
  readonly due_at: Date;
  readonly issued_at: Date | null;
  readonly version: number;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly settlement_wallet: string;
  readonly wallet_verified_at: Date;
  readonly invoice_snapshot: string | null;
  readonly invoice_snapshot_digest: string | null;
}

interface AttemptEvidenceRow {
  readonly id: string;
  readonly public_attempt_id: string;
  readonly asset_symbol: string;
  readonly reference_address: string;
  readonly recipient_address: string;
  readonly recipient_token_account: string;
  readonly mint: string;
  readonly state: string;
  readonly version: number;
  readonly formula_version: string;
  readonly invoice_currency: string;
  readonly invoice_minor_units: string;
  readonly stablecoin_usd_price: string;
  readonly token_amount: string;
  readonly amount_base_units: string;
  readonly amount_tokens: string;
  readonly input_digest: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly issuance_slot: string;
  readonly stablecoin_source: string;
  readonly stablecoin_publish_time: Date | null;
  readonly stablecoin_confidence: string | null;
  readonly fiat_source: string | null;
  readonly fiat_usage: string | null;
  readonly fiat_published_at: Date | null;
}

interface AllocationEvidenceRow {
  readonly id: string;
  readonly event_id: string;
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number | null;
  readonly mint: string;
  readonly amount_base_units: string;
  readonly rule_code: string;
  readonly rule_version: string;
  readonly created_at: Date;
  readonly current_state: string;
  readonly token_program: string;
  readonly source_token_account: string;
  readonly destination_token_account: string;
  readonly authority: string;
  readonly decimals: number;
}

interface ChainEventEvidenceRow {
  readonly event_id: string;
  readonly cluster: string;
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number;
  readonly current_state: string;
  readonly parser_version: string;
  readonly token_program: string;
  readonly source_token_account: string;
  readonly destination_token_account: string;
  readonly authority: string;
  readonly mint: string;
  readonly amount_base_units: string;
  readonly decimals: number;
  readonly provider_id: string;
  readonly captured_commitment: string;
  readonly raw_transaction_digest: string;
  readonly raw_transaction_byte_length: number;
  readonly raw_transaction_retrieved_at: Date;
  readonly slot: string | null;
  readonly block_time: string | null;
  readonly confirmation_status: string | null;
  readonly observed_finality_state: string | null;
  readonly observed_at: Date | null;
  readonly detected_at: Date | null;
  readonly confirmed_at: Date | null;
  readonly finalized_at: Date | null;
}

interface ExceptionEvidenceRow {
  readonly id: string;
  readonly event_id: string;
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number | null;
  readonly amount_base_units: string;
  readonly rule_code: string;
  readonly rule_version: string;
  readonly review_state: string;
  readonly assigned_to: string | null;
  readonly resolution_code: string | null;
  readonly resolution_note: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
}

interface JournalEvidenceRow {
  readonly id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly source_version: number;
  readonly functional_currency: string;
  readonly description: string;
  readonly occurred_at: Date;
  readonly posted_by: string;
  readonly payload_digest: string;
  readonly lines: unknown;
}

interface StatusEvidenceRow {
  readonly source_version: number;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly reason_code: string;
  readonly event_id: string | null;
  readonly occurred_at: Date;
}

interface ExceptionCaseEvidenceRow {
  readonly exception_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly actor_id: string;
  readonly reason_code: string;
  readonly note: string | null;
  readonly occurred_at: Date;
}

interface WebhookEvidenceRow {
  readonly id: string;
  readonly event_type: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly source_version: number;
  readonly payload_digest: string;
  readonly occurred_at: Date;
  readonly delivery_count: number;
  readonly succeeded_count: number;
  readonly dead_count: number;
  readonly attempt_count: number;
}

interface AuditEvidenceRow {
  readonly id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly object_kind: string;
  readonly object_id: string;
  readonly request_id: string;
  readonly outcome: string;
  readonly reason_code: string;
  readonly occurred_at: Date;
}

interface EvidencePackRow {
  readonly id: string;
  readonly invoice_id: string;
  readonly schema_version: string;
  readonly manifest_bytes: Uint8Array;
  readonly pdf_bytes: Uint8Array;
  readonly manifest_digest: string;
  readonly signature: Uint8Array;
  readonly signing_key_id: string;
  readonly public_key_pem: string;
  readonly generated_at: Date;
}

function mapInvoice(row: InvoiceEvidenceRow) {
  return {
    id: row.id,
    publicReference: row.public_reference,
    externalId: row.external_id,
    currency: row.currency,
    totalMinorUnits: row.total_minor_units,
    status: row.status,
    dueAt: row.due_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    version: row.version,
    customer: { id: row.customer_id, displayName: row.customer_name },
    settlementWallet: {
      address: row.settlement_wallet,
      verifiedAt: row.wallet_verified_at.toISOString(),
    },
    issuedSnapshot: row.invoice_snapshot,
    issuedSnapshotDigest: row.invoice_snapshot_digest,
  };
}

function mapAttempt(row: AttemptEvidenceRow) {
  return {
    id: row.id,
    publicAttemptId: row.public_attempt_id,
    assetSymbol: row.asset_symbol,
    referenceAddress: row.reference_address,
    recipientAddress: row.recipient_address,
    recipientTokenAccount: row.recipient_token_account,
    mint: row.mint,
    state: row.state,
    version: row.version,
    quote: {
      formulaVersion: row.formula_version,
      invoiceCurrency: row.invoice_currency,
      invoiceMinorUnits: row.invoice_minor_units,
      stablecoinUsdPrice: row.stablecoin_usd_price,
      tokenAmount: row.token_amount,
      amountBaseUnits: row.amount_base_units,
      amountTokens: row.amount_tokens,
      inputDigest: row.input_digest,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      issuanceSlot: row.issuance_slot,
      stablecoinSource: row.stablecoin_source,
      stablecoinPublishTime: row.stablecoin_publish_time?.toISOString() ?? null,
      stablecoinConfidence: row.stablecoin_confidence,
      fiatSource: row.fiat_source,
      fiatUsage: row.fiat_usage,
      fiatPublishedAt: row.fiat_published_at?.toISOString() ?? null,
    },
  };
}

function mapChainEvent(row: ChainEventEvidenceRow) {
  return {
    eventId: row.event_id,
    cluster: row.cluster,
    signature: row.signature,
    outerInstructionIndex: row.outer_instruction_index,
    innerInstructionIndex:
      row.inner_instruction_index === -1 ? null : row.inner_instruction_index,
    currentState: row.current_state,
    parserVersion: row.parser_version,
    tokenProgram: row.token_program,
    mint: row.mint,
    sourceTokenAccount: row.source_token_account,
    destinationTokenAccount: row.destination_token_account,
    authority: row.authority,
    amountBaseUnits: row.amount_base_units,
    decimals: row.decimals,
    transaction: {
      providerId: row.provider_id,
      capturedCommitment: row.captured_commitment,
      digest: row.raw_transaction_digest,
      byteLength: row.raw_transaction_byte_length,
      retrievedAt: row.raw_transaction_retrieved_at.toISOString(),
      rawBodyIncluded: false,
    },
    observation: {
      slot: row.slot,
      blockTime: row.block_time,
      confirmationStatus: row.confirmation_status,
      finalityState: row.observed_finality_state,
      observedAt: row.observed_at?.toISOString() ?? null,
    },
    lifecycle: {
      detectedAt: row.detected_at?.toISOString() ?? null,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
      finalizedAt: row.finalized_at?.toISOString() ?? null,
    },
    verificationChecks: [
      { check: "transaction_body_digest_recorded", passed: true },
      { check: "normalized_transfer_recorded", passed: true },
      {
        check: "event_finalized",
        passed: row.current_state === "finalized",
      },
    ],
  };
}

function mapAllocation(row: AllocationEvidenceRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    amountBaseUnits: row.amount_base_units,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    createdAt: row.created_at.toISOString(),
  };
}

function mapException(row: ExceptionEvidenceRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    signature: row.signature,
    outerInstructionIndex: row.outer_instruction_index,
    innerInstructionIndex: row.inner_instruction_index,
    amountBaseUnits: row.amount_base_units,
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
  };
}

function mapJournal(row: JournalEvidenceRow) {
  if (!Array.isArray(row.lines))
    throw new EvidencePackError("corrupt_journal_evidence");
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    functionalCurrency: row.functional_currency,
    description: row.description,
    occurredAt: row.occurred_at.toISOString(),
    postedBy: row.posted_by,
    payloadDigest: row.payload_digest,
    lines: row.lines,
  };
}

function mapStatus(row: StatusEvidenceRow) {
  return {
    sourceVersion: row.source_version,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reasonCode: row.reason_code,
    eventId: row.event_id,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function mapExceptionCaseEvent(row: ExceptionCaseEvidenceRow) {
  return {
    exceptionId: row.exception_id,
    sequence: row.sequence,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    actorId: row.actor_id,
    reasonCode: row.reason_code,
    note: row.note,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function mapWebhook(row: WebhookEvidenceRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    payloadDigest: row.payload_digest,
    occurredAt: row.occurred_at.toISOString(),
    deliveryCount: row.delivery_count,
    succeededCount: row.succeeded_count,
    deadCount: row.dead_count,
    attemptCount: row.attempt_count,
  };
}

function mapAudit(row: AuditEvidenceRow) {
  return {
    id: row.id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    action: row.action,
    objectKind: row.object_kind,
    objectId: row.object_id,
    requestId: row.request_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    occurredAt: row.occurred_at.toISOString(),
  };
}

function freezePack(pack: PaymentEvidencePack): PaymentEvidencePack {
  return Object.freeze({
    ...pack,
    manifestBytes: new Uint8Array(pack.manifestBytes),
    pdfBytes: new Uint8Array(pack.pdfBytes),
    signature: new Uint8Array(pack.signature),
  });
}

function assertEvidenceRows(groups: readonly (readonly unknown[])[]): void {
  if (groups.some((rows) => rows.length > maximumEvidenceRows)) {
    throw new EvidencePackError("evidence_pack_too_large");
  }
}

function validPdfArtifact(manifest: unknown, pdfBytes: Uint8Array): boolean {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    return false;
  const artifacts = Object.getOwnPropertyDescriptor(manifest, "artifacts");
  if (artifacts === undefined || !("value" in artifacts)) return false;
  const value = artifacts.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const pdf = Object.getOwnPropertyDescriptor(value, "pdf");
  if (pdf === undefined || !("value" in pdf)) return false;
  const record = pdf.value;
  if (record === null || typeof record !== "object" || Array.isArray(record))
    return false;
  const sha256 = Object.getOwnPropertyDescriptor(record, "sha256");
  const byteLength = Object.getOwnPropertyDescriptor(record, "byteLength");
  if (
    sha256 === undefined ||
    !("value" in sha256) ||
    typeof sha256.value !== "string" ||
    !digestPattern.test(sha256.value) ||
    byteLength === undefined ||
    !("value" in byteLength) ||
    byteLength.value !== pdfBytes.byteLength
  )
    return false;
  return createHash("sha256").update(pdfBytes).digest("hex") === sha256.value;
}

function renderEvidencePdf(input: {
  readonly invoiceReference: string;
  readonly invoiceStatus: string;
  readonly currency: string;
  readonly totalMinorUnits: string;
  readonly allocationCount: number;
  readonly exceptionCount: number;
  readonly journalCount: number;
  readonly signingKeyId: string;
  readonly generatedAt: string;
}): Uint8Array {
  const lines = [
    "PayOps Payment Evidence Pack",
    `Invoice: ${input.invoiceReference}`,
    `Status: ${input.invoiceStatus}`,
    `Amount: ${input.totalMinorUnits} minor units ${input.currency}`,
    `Allocations: ${input.allocationCount}`,
    `Exceptions: ${input.exceptionCount}`,
    `Journal entries: ${input.journalCount}`,
    `Generated: ${input.generatedAt}`,
    `Signing key: ${input.signingKeyId}`,
    "Integrity: PDF SHA-256 is recorded in the signed JSON manifest.",
    "Operational evidence only; verify JSON, PDF, and Ed25519 signature.",
  ].map(asciiPdfText);
  const commands = ["BT", "/F1 11 Tf", "50 760 Td"];
  for (const [index, line] of lines.entries()) {
    if (index > 0) commands.push("0 -24 Td");
    commands.push(`(${escapePdfString(line)}) Tj`);
  }
  commands.push("ET");
  const stream = `${commands.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let document = "%PDF-1.4\n%PayOps\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, "ascii"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "ascii");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(document, "ascii"));
}

function asciiPdfText(value: string): string {
  return [...value]
    .map((character) => (/^[\x20-\x7e]$/.test(character) ? character : "?"))
    .join("");
}

function escapePdfString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}
