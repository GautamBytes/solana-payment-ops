import type { Sql } from "postgres";
import type { InspectSignatureOptions } from "../domain/types.js";

export async function readSignatureInspection(
  sql: Sql,
  signature: string,
  options: InspectSignatureOptions = {},
): Promise<unknown | null> {
  const rows = await sql<{ inspection: unknown }[]>`
    SELECT jsonb_build_object(
      'discovery', jsonb_build_object(
        'watchTargetId', discovered.watch_target_id,
        'providerId', discovered.provider_id,
        'signature', discovered.signature,
        'slot', discovered.slot::text,
        'blockTime', discovered.block_time::text,
        'rpcError', discovered.rpc_error,
        'confirmationStatus', discovered.confirmation_status,
        'representationClass', discovered.representation_class,
        'parseDigest', discovered.parse_digest,
        'finalityState', discovered.finality_state,
        'observedAt', discovered.observed_at
      ),
      'rawTransactions', COALESCE((
        SELECT jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'id', raw.id::text,
            'commitment', raw.commitment,
            'digest', raw.digest,
            'byteLength', raw.byte_length,
            'retrievedAt', raw.retrieved_at,
            'canonicalBody', CASE WHEN ${options.includeRaw === true}
              THEN raw.canonical_body ELSE NULL END,
            'body', CASE WHEN ${options.includeRaw === true}
              THEN raw.body ELSE NULL END
          )) ORDER BY raw.id
        )
        FROM raw_transactions AS raw
        WHERE raw.provider_id = discovered.provider_id
          AND raw.signature = discovered.signature
      ), '[]'::jsonb),
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'eventId', event.event_id,
          'cluster', event.cluster,
          'signature', event.signature,
          'outerInstructionIndex', event.outer_instruction_index,
          'innerInstructionIndex', CASE
            WHEN event.inner_instruction_index = -1 THEN NULL
            ELSE event.inner_instruction_index
          END,
          'state', event.current_state,
          'references', COALESCE((
            SELECT jsonb_agg(reference.reference_address ORDER BY reference.reference_address)
            FROM event_references AS reference
            WHERE reference.chain_event_id = event.id
          ), '[]'::jsonb),
          'transfers', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'parserVersion', normalized.parser_version,
              'programId', normalized.program_id,
              'sourceTokenAccount', normalized.source_token_account,
              'sourceAccountIndex', normalized.source_account_index,
              'mint', normalized.mint,
              'destinationTokenAccount', normalized.destination_token_account,
              'destinationAccountIndex', normalized.destination_account_index,
              'authority', normalized.authority,
              'amountBaseUnits', normalized.amount_base_units::text,
              'decimals', normalized.decimals,
              'unsupportedExtraAccounts', normalized.unsupported_extra_accounts
            ) ORDER BY normalized.parser_version)
            FROM normalized_transfers AS normalized
            WHERE normalized.chain_event_id = event.id
          ), '[]'::jsonb)
        ) ORDER BY event.outer_instruction_index, event.inner_instruction_index)
        FROM chain_events AS event
        WHERE event.signature = discovered.signature
          AND event.cluster = target.cluster
      ), '[]'::jsonb),
      'retries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', retry.id::text,
          'operation', retry.operation,
          'code', retry.code,
          'safeMessage', retry.safe_message,
          'attemptCount', retry.attempt_count,
          'firstFailedAt', retry.first_failed_at,
          'lastFailedAt', retry.last_failed_at,
          'nextAttemptAt', retry.next_attempt_at,
          'resolvedAt', retry.resolved_at
        ) ORDER BY retry.id)
        FROM ingestion_retries AS retry
        WHERE retry.provider_id = discovered.provider_id
          AND retry.watch_target_id = discovered.watch_target_id
          AND retry.signature = discovered.signature
      ), '[]'::jsonb),
      'quarantines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', quarantine.id::text,
          'code', quarantine.code,
          'safeMessage', quarantine.safe_message,
          'reviewState', quarantine.review_state,
          'createdAt', quarantine.created_at
        ) ORDER BY quarantine.id)
        FROM ingestion_quarantines AS quarantine
        WHERE quarantine.provider_id = discovered.provider_id
          AND quarantine.watch_target_id = discovered.watch_target_id
          AND quarantine.signature = discovered.signature
      ), '[]'::jsonb),
      'finalityObservations', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', observation.id::text,
          'observedStatus', observation.observed_status,
          'observedState', observation.observed_state,
          'contextSlot', observation.context_slot::text,
          'responseDigest', observation.response_digest,
          'code', observation.code,
          'observedAt', observation.observed_at
        ) ORDER BY observation.id)
        FROM finality_observations AS observation
        WHERE observation.provider_id = discovered.provider_id
          AND observation.signature = discovered.signature
      ), '[]'::jsonb)
    ) AS inspection
    FROM discovered_signatures AS discovered
    JOIN watch_targets AS target ON target.id = discovered.watch_target_id
    WHERE discovered.signature = ${signature}
    ORDER BY discovered.watch_target_id
    LIMIT 1
  `;
  return rows[0]?.inspection ?? null;
}
