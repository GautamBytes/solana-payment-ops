import type { Sql } from "postgres";
import { createParsingDigest } from "../archive/canonical-snapshot.js";
import type {
  RecordRepresentationInput,
  RecordRepresentationResult,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

interface RawRow {
  readonly id: string;
  readonly digest: string;
}

interface DiscoveredRow {
  readonly slot: string;
}

interface EventRow {
  readonly id: string;
}

interface EventEvidenceRow extends EventRow {
  readonly event_id: string;
  readonly cluster: string;
  readonly signature: string;
  readonly outer_instruction_index: number;
  readonly inner_instruction_index: number;
  readonly parser_version: string | null;
  readonly program_id: string | null;
  readonly source_token_account: string | null;
  readonly source_account_index: number | null;
  readonly mint: string | null;
  readonly destination_token_account: string | null;
  readonly destination_account_index: number | null;
  readonly authority: string | null;
  readonly amount_base_units: string | null;
  readonly decimals: number | null;
  readonly unsupported_extra_accounts: unknown;
  readonly references: string[];
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export async function persistRepresentation(
  sql: Sql,
  input: RecordRepresentationInput,
): Promise<RecordRepresentationResult> {
  return sql.begin(async (transaction) => {
    const representationKey = `${input.providerId}:${input.discovered.signature}`;
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${representationKey}, 0))
    `;
    if (input.transaction !== null) {
      const eventKey = `${input.transaction.cluster}:${input.discovered.signature}`;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${eventKey}, 1))
      `;
    }
    const existing = await transaction<DiscoveredRow[]>`
      SELECT slot FROM discovered_signatures
      WHERE watch_target_id = ${input.watchTargetId}
        AND signature = ${input.discovered.signature}
      FOR UPDATE
    `;
    const signatureInserted = existing.length === 0;
    let classification = input.classification;
    let quarantineCode = input.quarantineCode;
    let quarantineMessage = input.quarantineMessage;
    if (
      existing[0] !== undefined &&
      BigInt(existing[0].slot) !== input.discovered.slot
    ) {
      classification = "quarantined";
      quarantineCode = "event_identity_conflict";
      quarantineMessage = "Signature was observed at a conflicting slot";
    }

    let rawTransactionId: string | null = null;
    if (input.snapshot !== null && input.transaction !== null) {
      const sameCommitment = await transaction<RawRow[]>`
        SELECT id::text, digest FROM raw_transactions
        WHERE provider_id = ${input.providerId}
          AND signature = ${input.discovered.signature}
          AND commitment = ${input.transaction.commitment}
        ORDER BY id LIMIT 1
      `;
      if (
        sameCommitment[0] !== undefined &&
        sameCommitment[0].digest !== input.snapshot.digest
      ) {
        classification = "quarantined";
        quarantineCode = "raw_digest_conflict";
        quarantineMessage = "Raw transaction changed at the same commitment";
      }
      await transaction`
        INSERT INTO raw_transactions (
          provider_id, signature, commitment, digest, canonical_body, body,
          byte_length, retrieved_at
        ) VALUES (
          ${input.providerId}, ${input.discovered.signature},
          ${input.transaction.commitment}, ${input.snapshot.digest},
          ${input.snapshot.canonicalJson},
          ${input.snapshot.canonicalJson}::jsonb,
          ${input.snapshot.byteLength}, ${input.observedAt.toISOString()}
        )
        ON CONFLICT (provider_id, signature, commitment, digest) DO NOTHING
      `;
      const rawRows = await transaction<RawRow[]>`
        SELECT id::text, digest FROM raw_transactions
        WHERE provider_id = ${input.providerId}
          AND signature = ${input.discovered.signature}
          AND commitment = ${input.transaction.commitment}
          AND digest = ${input.snapshot.digest}
        LIMIT 1
      `;
      rawTransactionId = rawRows[0]?.id ?? null;
    }

    if (classification === "parsed" && input.transaction !== null) {
      for (const transfer of input.transfers) {
        const eventRows = await transaction<EventEvidenceRow[]>`
          SELECT
            event.id::text,
            event.event_id,
            event.cluster,
            event.signature,
            event.outer_instruction_index,
            event.inner_instruction_index,
            normalized.parser_version,
            normalized.program_id,
            normalized.source_token_account,
            normalized.source_account_index,
            normalized.mint,
            normalized.destination_token_account,
            normalized.destination_account_index,
            normalized.authority,
            normalized.amount_base_units,
            normalized.decimals,
            normalized.unsupported_extra_accounts,
            ARRAY(
              SELECT reference.reference_address
              FROM event_references AS reference
              WHERE reference.chain_event_id = event.id
              ORDER BY reference.reference_address
            ) AS references
          FROM chain_events AS event
          LEFT JOIN normalized_transfers AS normalized
            ON normalized.chain_event_id = event.id
            AND normalized.parser_version = ${input.parserVersion}
          WHERE event.event_id = ${transfer.eventId}
            OR (
              event.cluster = ${input.transaction.cluster}
              AND event.signature = ${transfer.signature}
              AND event.outer_instruction_index = ${transfer.outerInstructionIndex}
              AND event.inner_instruction_index = ${transfer.innerInstructionIndex ?? -1}
            )
          LIMIT 1
        `;
        const event = eventRows[0];
        const normalizedConflict =
          event?.parser_version !== null &&
          event?.parser_version !== undefined &&
          (event.program_id !== transfer.programId ||
            event.source_token_account !== transfer.sourceTokenAccount ||
            event.source_account_index !== transfer.sourceAccountIndex ||
            event.mint !== transfer.mint ||
            event.destination_token_account !==
              transfer.destinationTokenAccount ||
            event.destination_account_index !==
              transfer.destinationAccountIndex ||
            event.authority !== transfer.authority ||
            event.amount_base_units !== transfer.amountBaseUnits ||
            event.decimals !== transfer.decimals ||
            JSON.stringify(event.unsupported_extra_accounts) !==
              JSON.stringify(transfer.unsupportedExtraAccounts));
        const eventConflict =
          event !== undefined &&
          (event.event_id !== transfer.eventId ||
            event.cluster !== input.transaction.cluster ||
            event.signature !== transfer.signature ||
            event.outer_instruction_index !== transfer.outerInstructionIndex ||
            event.inner_instruction_index !==
              (transfer.innerInstructionIndex ?? -1) ||
            normalizedConflict ||
            !sameStrings(event.references, transfer.references));
        if (eventConflict) {
          classification = "quarantined";
          quarantineCode = "event_identity_conflict";
          quarantineMessage =
            "Normalized event changed for an existing event identity";
          break;
        }
      }
    }

    const finalityState =
      classification === "pending"
        ? "detected"
        : classification === "failed_transaction"
          ? "failed"
          : classification === "quarantined"
            ? "quarantined"
            : "confirmed";
    await transaction`
      INSERT INTO discovered_signatures (
        watch_target_id, provider_id, signature, slot, block_time, rpc_error,
        confirmation_status, representation_class, raw_transaction_id,
        parse_digest, finality_state, observed_at
      ) VALUES (
        ${input.watchTargetId}, ${input.providerId}, ${input.discovered.signature},
        ${input.discovered.slot.toString()},
        ${input.discovered.blockTime?.toString() ?? null},
        ${
          input.discovered.err === null
            ? null
            : JSON.stringify(input.discovered.err ?? null)
        }::jsonb,
        ${input.discovered.confirmationStatus}, ${classification},
        ${rawTransactionId},
        ${input.transaction === null ? null : createParsingDigest(input.transaction)},
        ${finalityState}, ${input.observedAt.toISOString()}
      )
      ON CONFLICT (watch_target_id, signature) DO UPDATE SET
        representation_class = CASE
          WHEN discovered_signatures.finality_state IN ('finalized', 'failed', 'reverted', 'quarantined')
            THEN discovered_signatures.representation_class
          WHEN EXCLUDED.representation_class = 'pending'
            AND discovered_signatures.representation_class <> 'pending'
            THEN discovered_signatures.representation_class
          ELSE EXCLUDED.representation_class
        END,
        raw_transaction_id = COALESCE(discovered_signatures.raw_transaction_id, EXCLUDED.raw_transaction_id),
        parse_digest = COALESCE(discovered_signatures.parse_digest, EXCLUDED.parse_digest),
        finality_state = CASE
          WHEN discovered_signatures.finality_state IN ('finalized', 'failed', 'reverted', 'quarantined')
            THEN discovered_signatures.finality_state
          ELSE EXCLUDED.finality_state
        END
    `;

    if (classification === "quarantined" && input.transaction !== null) {
      await transaction`
        UPDATE chain_events SET current_state = 'quarantined'
        WHERE cluster = ${input.transaction.cluster}
          AND signature = ${input.discovered.signature}
      `;
    }

    let eventsInserted = 0;
    if (rawTransactionId !== null && classification === "parsed") {
      for (const transfer of input.transfers) {
        const inserted = await transaction<EventRow[]>`
          INSERT INTO chain_events (
            event_id, cluster, signature, outer_instruction_index,
            inner_instruction_index, raw_transaction_id, current_state
          ) VALUES (
            ${transfer.eventId}, ${input.transaction?.cluster ?? "mainnet-beta"},
            ${transfer.signature}, ${transfer.outerInstructionIndex},
            ${transfer.innerInstructionIndex ?? -1}, ${rawTransactionId}, 'confirmed'
          )
          ON CONFLICT (event_id) DO NOTHING
          RETURNING id::text
        `;
        eventsInserted += inserted.length;
        const eventRows =
          inserted.length > 0
            ? inserted
            : await transaction<EventRow[]>`
                SELECT id::text FROM chain_events WHERE event_id = ${transfer.eventId}
              `;
        const eventId = eventRows[0]?.id;
        if (eventId === undefined) {
          throw new IngestionError(
            "event_identity_conflict",
            "Chain event could not be stored",
            { retryable: false },
          );
        }
        await transaction`
          INSERT INTO normalized_transfers (
            chain_event_id, parser_version, program_id, source_token_account,
            source_account_index, mint, destination_token_account,
            destination_account_index, authority, amount_base_units, decimals,
            unsupported_extra_accounts
          ) VALUES (
            ${eventId}, ${input.parserVersion}, ${transfer.programId},
            ${transfer.sourceTokenAccount}, ${transfer.sourceAccountIndex},
            ${transfer.mint}, ${transfer.destinationTokenAccount},
            ${transfer.destinationAccountIndex}, ${transfer.authority},
            ${transfer.amountBaseUnits}, ${transfer.decimals},
            ${JSON.stringify(transfer.unsupportedExtraAccounts)}::jsonb
          )
          ON CONFLICT (chain_event_id, parser_version) DO NOTHING
        `;
        for (const reference of transfer.references) {
          await transaction`
            INSERT INTO event_references (chain_event_id, reference_address)
            VALUES (${eventId}, ${reference})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    let quarantineInserted = false;
    if (classification === "quarantined") {
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO ingestion_quarantines (
          run_id, provider_id, watch_target_id, signature, raw_transaction_id,
          code, safe_message, created_at
        )
        SELECT
          ${input.runId}, ${input.providerId}, ${input.watchTargetId},
          ${input.discovered.signature}, ${rawTransactionId},
          ${quarantineCode ?? "rpc_transaction_schema_invalid"},
          ${quarantineMessage ?? "Transaction requires manual review"},
          ${input.observedAt.toISOString()}
        WHERE NOT EXISTS (
          SELECT 1 FROM ingestion_quarantines
          WHERE provider_id = ${input.providerId}
            AND watch_target_id = ${input.watchTargetId}
            AND signature = ${input.discovered.signature}
            AND code = ${quarantineCode ?? "rpc_transaction_schema_invalid"}
            AND review_state = 'open'
        )
        RETURNING id::text
      `;
      quarantineInserted = inserted.length === 1;
    }
    if (classification !== "pending") {
      await transaction`
        UPDATE ingestion_retries
        SET resolved_at = ${input.observedAt.toISOString()}
        WHERE provider_id = ${input.providerId}
          AND watch_target_id = ${input.watchTargetId}
          AND signature = ${input.discovered.signature}
          AND operation IN ('transaction', 'storage')
          AND resolved_at IS NULL
      `;
    }
    return { signatureInserted, eventsInserted, quarantineInserted };
  });
}
