import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type {
  AddProviderInput,
  AddWatchTargetInput,
  CompleteSyncRunInput,
  FinalityCandidate,
  IngestionAuditStore,
  IngestionStore,
  InspectSignatureOptions,
  ProviderRecord,
  RecordFinalityObservationInput,
  RecordFinalityObservationResult,
  RecordPageInput,
  RecordRepresentationInput,
  RecordRepresentationResult,
  RecordRetryInput,
  ResolveRetryInput,
  SolanaCluster,
  StartSyncRunInput,
  SyncLock,
  WatchCoverageSummary,
  WatchTarget,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";
import * as schema from "./schema.js";
import { persistRepresentation } from "./representation-store.js";
import { rpcProviders, watchTargets } from "./schema.js";
import { readSignatureInspection } from "./signature-inspection.js";

export interface PostgresIngestionStoreConfig {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
  readonly organizationId?: string;
  readonly selfHostedDefaultOrganization?: true;
}

const selfHostedOrganizationId = "00000000-0000-4000-8000-000000000001";
const organizationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function scopedDatabaseUrl(config: PostgresIngestionStoreConfig): {
  readonly databaseUrl: string;
  readonly organizationId: string;
} {
  if (
    config.organizationId !== undefined &&
    config.selfHostedDefaultOrganization
  ) {
    throw new IngestionError(
      "invalid_configuration",
      "Tenant scope is ambiguous",
      {
        retryable: false,
      },
    );
  }
  const organizationId =
    config.organizationId ??
    (config.selfHostedDefaultOrganization
      ? selfHostedOrganizationId
      : undefined);
  if (
    organizationId === undefined ||
    !organizationIdPattern.test(organizationId)
  ) {
    throw new IngestionError(
      "invalid_configuration",
      "Tenant scope is required",
      {
        retryable: false,
      },
    );
  }
  const url = new URL(config.databaseUrl);
  const options = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [options, `-cpayops.organization_id=${organizationId}`]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  return { databaseUrl: url.toString(), organizationId };
}

function parseCluster(value: string): SolanaCluster {
  if (value === "mainnet-beta" || value === "devnet" || value === "localnet") {
    return value;
  }
  throw new IngestionError(
    "database_unavailable",
    "Stored cluster is invalid",
    {
      retryable: false,
    },
  );
}

function toWatchTarget(row: typeof watchTargets.$inferSelect): WatchTarget {
  return {
    id: row.id,
    providerId: row.providerId,
    cluster: parseCluster(row.cluster),
    address: row.address,
    cutoverSlot: BigInt(row.cutoverSlot),
    cutoverSignature: row.cutoverSignature,
    overlapSlots: BigInt(row.overlapSlots),
    committedHeadSlot:
      row.committedHeadSlot === null ? null : BigInt(row.committedHeadSlot),
    committedHeadSignature: row.committedHeadSignature,
    coverage: row.coverage === "incomplete" ? "incomplete" : "complete",
  };
}

function nextRetryAt(now: Date, attempts: number): Date {
  const seconds = Math.min(300, 2 ** Math.min(attempts, 8) * 2);
  return new Date(now.getTime() + seconds * 1000);
}

interface RawRow {
  readonly id: string;
  readonly digest: string;
}

interface WatchCoverageRow {
  readonly watch_target_id: string;
  readonly coverage: WatchCoverageSummary["coverage"];
  readonly captured_head_slot: string | null;
  readonly committed_head_slot: string | null;
  readonly signatures: number;
  readonly finalized: number;
  readonly pending_finality: number;
  readonly retries_open: number;
  readonly quarantines_open: number;
}

const canonicalParserVersionPattern =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

function assertCanonicalParserVersion(parserVersion: string): void {
  if (canonicalParserVersionPattern.test(parserVersion)) return;
  throw new IngestionError(
    "invalid_configuration",
    "Parser version must be a numeric MAJOR.MINOR.PATCH triplet with components from 0 to 999999999 and no leading zeroes",
    { retryable: false },
  );
}

export class PostgresIngestionStore
  implements IngestionStore, IngestionAuditStore
{
  readonly #sql: Sql;
  readonly #db: PostgresJsDatabase<typeof schema>;
  readonly #organizationId: string;

  public constructor(config: PostgresIngestionStoreConfig) {
    const scope = scopedDatabaseUrl(config);
    this.#organizationId = scope.organizationId;
    this.#sql = postgres(scope.databaseUrl, {
      max: config.maxConnections ?? 10,
      onnotice: () => undefined,
      prepare: false,
    });
    this.#db = drizzle(this.#sql, { schema });
  }

  public async tryAcquireSyncLock(
    providerId: string,
    watchTargetId: string,
  ): Promise<SyncLock | null> {
    const connection = await this.#sql.reserve();
    const key = `${this.#organizationId}:${providerId}:${watchTargetId}`;
    const rows = await connection<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked
    `;
    if (rows[0]?.locked !== true) {
      connection.release();
      return null;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await connection`
            SELECT pg_advisory_unlock(hashtextextended(${key}, 0))
          `;
        } finally {
          connection.release();
        }
      },
    };
  }

  public async getProvider(providerId: string): Promise<ProviderRecord | null> {
    const rows = await this.#db
      .select()
      .from(rpcProviders)
      .where(
        and(eq(rpcProviders.id, providerId), eq(rpcProviders.active, true)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          cluster: parseCluster(row.cluster),
          endpointEnv: row.endpointEnv,
          endpointLabel: row.endpointLabel,
        };
  }

  public async addProvider(input: AddProviderInput): Promise<ProviderRecord> {
    await this.#db
      .insert(rpcProviders)
      .values({
        id: input.id,
        cluster: input.cluster,
        endpointEnv: input.endpointEnv,
        endpointLabel: input.endpointLabel,
      })
      .onConflictDoNothing({ target: rpcProviders.id });
    const provider = await this.getProvider(input.id);
    if (provider === null) {
      throw new IngestionError(
        "database_unavailable",
        "Provider could not be stored",
        { retryable: true },
      );
    }
    if (
      provider.cluster !== input.cluster ||
      provider.endpointEnv !== input.endpointEnv ||
      provider.endpointLabel !== input.endpointLabel
    ) {
      throw new IngestionError(
        "database_unavailable",
        "Provider ID already has different immutable configuration",
        { retryable: false },
      );
    }
    return provider;
  }

  public async getWatchTarget(
    watchTargetId: string,
  ): Promise<WatchTarget | null> {
    const rows = await this.#db
      .select()
      .from(watchTargets)
      .where(
        and(eq(watchTargets.id, watchTargetId), eq(watchTargets.active, true)),
      )
      .limit(1);
    return rows[0] === undefined ? null : toWatchTarget(rows[0]);
  }

  public async addWatchTarget(
    input: AddWatchTargetInput,
  ): Promise<WatchTarget> {
    try {
      await this.#db
        .insert(watchTargets)
        .values({
          id: input.id,
          providerId: input.providerId,
          cluster: input.cluster,
          address: input.address,
          cutoverSlot: input.cutoverSlot.toString(),
          cutoverSignature: input.cutoverSignature,
          overlapSlots: input.overlapSlots.toString(),
          committedHeadSlot: input.cutoverSlot.toString(),
          committedHeadSignature: input.cutoverSignature,
          coverage: "complete",
          createdAt: input.createdAt,
        })
        .onConflictDoNothing({ target: watchTargets.id });
    } catch (error) {
      const cause =
        error !== null && typeof error === "object" && "cause" in error
          ? error.cause
          : null;
      if (
        (error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505") ||
        (cause !== null &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "23505")
      ) {
        throw new IngestionError(
          "invalid_configuration",
          "An active watch already exists for this provider and address",
          { retryable: false, cause: error },
        );
      }
      throw error;
    }
    const target = await this.getWatchTarget(input.id);
    if (target === null) {
      throw new IngestionError(
        "database_unavailable",
        "Watch target could not be stored",
        { retryable: true },
      );
    }
    if (
      target.providerId !== input.providerId ||
      target.cluster !== input.cluster ||
      target.address !== input.address ||
      target.cutoverSlot !== input.cutoverSlot ||
      target.cutoverSignature !== input.cutoverSignature ||
      target.overlapSlots !== input.overlapSlots
    ) {
      throw new IngestionError(
        "invalid_configuration",
        "Watch target ID already has different immutable configuration",
        { retryable: false },
      );
    }
    return target;
  }

  public async getWatchCoverageSummaries(
    watchTargetIds: readonly string[],
  ): Promise<readonly WatchCoverageSummary[]> {
    if (
      watchTargetIds.length === 0 ||
      watchTargetIds.length > 64 ||
      new Set(watchTargetIds).size !== watchTargetIds.length
    ) {
      throw new IngestionError(
        "invalid_configuration",
        "Audit watch selection is invalid",
        { retryable: false },
      );
    }
    const rows = await this.#sql<WatchCoverageRow[]>`
      SELECT
        target.id AS watch_target_id,
        target.coverage,
        latest.captured_head_slot::text,
        target.committed_head_slot::text,
        (
          SELECT count(*)::integer
          FROM discovered_signatures AS signature
          WHERE signature.watch_target_id = target.id
        ) AS signatures,
        (
          SELECT count(*)::integer
          FROM discovered_signatures AS signature
          WHERE signature.watch_target_id = target.id
            AND signature.finality_state = 'finalized'
        ) AS finalized,
        (
          SELECT count(*)::integer
          FROM discovered_signatures AS signature
          WHERE signature.watch_target_id = target.id
            AND signature.finality_state IN ('detected', 'confirmed')
        ) AS pending_finality,
        (
          SELECT count(*)::integer
          FROM ingestion_retries AS retry
          WHERE retry.watch_target_id = target.id
            AND retry.resolved_at IS NULL
        ) AS retries_open,
        (
          SELECT count(*)::integer
          FROM ingestion_quarantines AS quarantine
          WHERE quarantine.watch_target_id = target.id
            AND quarantine.review_state = 'open'
        ) AS quarantines_open
      FROM watch_targets AS target
      LEFT JOIN LATERAL (
        SELECT run.captured_head_slot
        FROM sync_runs AS run
        WHERE run.watch_target_id = target.id
        ORDER BY run.started_at DESC, run.id DESC
        LIMIT 1
      ) AS latest ON true
      WHERE target.active = true
        AND target.id = ANY(${watchTargetIds}::text[])
    `;
    const byId = new Map(rows.map((row) => [row.watch_target_id, row]));
    if (byId.size !== watchTargetIds.length) {
      throw new IngestionError(
        "invalid_configuration",
        "Audit watch selection is invalid",
        { retryable: false },
      );
    }
    return watchTargetIds.map((watchTargetId) => {
      const row = byId.get(watchTargetId)!;
      return {
        watchTargetId,
        coverage: row.coverage,
        capturedHeadSlot: row.captured_head_slot,
        committedHeadSlot: row.committed_head_slot,
        signatures: row.signatures,
        finalized: row.finalized,
        pendingFinality: row.pending_finality,
        retriesOpen: row.retries_open,
        quarantinesOpen: row.quarantines_open,
      };
    });
  }

  public async startSyncRun(input: StartSyncRunInput): Promise<string> {
    const runId = randomUUID();
    await this.#sql`
      INSERT INTO sync_runs (
        id, provider_id, watch_target_id, starting_head_signature,
        starting_head_slot, captured_head_signature, captured_head_slot,
        started_at
      ) VALUES (
        ${runId}, ${input.providerId}, ${input.watchTargetId},
        ${input.startingHeadSignature},
        ${input.startingHeadSlot?.toString() ?? null},
        ${input.capturedHead?.signature ?? null},
        ${input.capturedHead?.slot.toString() ?? null},
        ${input.startedAt.toISOString()}
      )
    `;
    return runId;
  }

  public async recordPage(input: RecordPageInput): Promise<void> {
    const serialized = input.signatures.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot.toString(),
      blockTime: entry.blockTime?.toString() ?? null,
      err: entry.err,
      confirmationStatus: entry.confirmationStatus,
    }));
    await this.#sql`
      INSERT INTO sync_run_pages (
        run_id, page_number, before_signature, newest_slot, oldest_slot,
        signature_digest, signatures
      ) VALUES (
        ${input.runId}, ${input.pageNumber}, ${input.before},
        ${input.signatures[0]?.slot.toString() ?? null},
        ${input.signatures.at(-1)?.slot.toString() ?? null},
        ${input.digest}, ${JSON.stringify(serialized)}::jsonb
      )
      ON CONFLICT (run_id, page_number) DO NOTHING
    `;
  }

  public async recordRepresentation(
    input: RecordRepresentationInput,
  ): Promise<RecordRepresentationResult> {
    assertCanonicalParserVersion(input.parserVersion);
    return persistRepresentation(this.#sql, input);
  }

  public async recordRetry(input: RecordRetryInput): Promise<boolean> {
    return this.#sql.begin(async (transaction) => {
      if (
        input.operation === "finality" &&
        input.finalityClaimToken !== undefined &&
        input.finalityClaimState !== undefined
      ) {
        const claimed = await transaction<{ signature: string }[]>`
          SELECT signature FROM discovered_signatures
          WHERE watch_target_id = ${input.watchTargetId}
            AND provider_id = ${input.providerId}
            AND signature = ${input.signature}
            AND finality_state = ${input.finalityClaimState}
            AND finality_claim_token = ${input.finalityClaimToken}::uuid
          FOR UPDATE
        `;
        if (claimed.length === 0) return false;
      }
      const rows = await transaction<{ attempt_count: number }[]>`
        SELECT attempt_count FROM ingestion_retries
        WHERE operation = ${input.operation}
          AND provider_id = ${input.providerId}
          AND watch_target_id = ${input.watchTargetId}
          AND COALESCE(signature, '') = COALESCE(${input.signature}, '')
          AND resolved_at IS NULL
        LIMIT 1
      `;
      const attempts = (rows[0]?.attempt_count ?? 0) + 1;
      await transaction`
        INSERT INTO ingestion_retries (
          run_id, provider_id, watch_target_id, signature, operation, code,
          safe_message, attempt_count, first_failed_at, last_failed_at,
          next_attempt_at
        ) VALUES (
          ${input.runId}, ${input.providerId}, ${input.watchTargetId},
          ${input.signature}, ${input.operation}, ${input.code}, ${input.message},
          ${attempts}, ${input.now.toISOString()}, ${input.now.toISOString()},
          ${nextRetryAt(input.now, attempts).toISOString()}
        )
        ON CONFLICT (
          operation, provider_id, watch_target_id, (COALESCE(signature, ''))
        ) WHERE resolved_at IS NULL DO UPDATE SET
          run_id = EXCLUDED.run_id,
          code = EXCLUDED.code,
          safe_message = EXCLUDED.safe_message,
          attempt_count = EXCLUDED.attempt_count,
          last_failed_at = EXCLUDED.last_failed_at,
          next_attempt_at = EXCLUDED.next_attempt_at
      `;
      return true;
    });
  }

  public async resolveRetry(input: ResolveRetryInput): Promise<boolean> {
    const rows = await this.#sql<{ id: string }[]>`
      UPDATE ingestion_retries
      SET resolved_at = ${input.resolvedAt.toISOString()}
      WHERE operation = ${input.operation}
        AND provider_id = ${input.providerId}
        AND watch_target_id = ${input.watchTargetId}
        AND COALESCE(signature, '') = COALESCE(${input.signature}, '')
        AND resolved_at IS NULL
      RETURNING id::text
    `;
    return rows.length > 0;
  }

  public async completeSyncRun(input: CompleteSyncRunInput): Promise<boolean> {
    return this.#sql.begin(async (transaction) => {
      await transaction`
        UPDATE sync_runs SET
          result = ${input.result}, coverage = ${input.coverage},
          error_code = ${input.errorCode ?? null},
          pages_read = ${input.counts.pagesRead},
          signatures_discovered = ${input.counts.signaturesDiscovered},
          signatures_stored = ${input.counts.signaturesStored},
          events_stored = ${input.counts.eventsStored},
          retries_created = ${input.counts.retriesCreated},
          quarantines_created = ${input.counts.quarantinesCreated},
          completed_at = ${input.completedAt.toISOString()}
        WHERE id = ${input.runId}
      `;
      if (!input.advanceCursor || input.capturedHead === null) {
        return false;
      }
      const updated = await transaction<{ id: string }[]>`
        UPDATE watch_targets SET
          committed_head_signature = ${input.capturedHead.signature},
          committed_head_slot = ${input.capturedHead.slot.toString()},
          coverage = ${input.coverage}
        WHERE id = ${input.watchTargetId}
          AND committed_head_signature IS NOT DISTINCT FROM ${input.startingHeadSignature}
        RETURNING id
      `;
      return updated.length === 1;
    });
  }

  public async claimFinalityCandidates(
    providerId: string,
    limit: number,
    now: Date,
  ): Promise<readonly FinalityCandidate[]> {
    return this.#sql.begin(async (transaction) => {
      const rows = await transaction<
        {
          watch_target_id: string;
          cluster: string;
          signature: string;
          slot: string;
          finality_state: "detected" | "confirmed";
          parse_digest: string | null;
          missing_observation_count: number;
          first_missing_finalized_slot: string | null;
          finality_claim_token: string;
          has_finalized_snapshot: boolean;
        }[]
      >`
        WITH candidates AS (
          SELECT watch_target_id, signature
          FROM discovered_signatures
          WHERE provider_id = ${providerId}
            AND finality_state IN ('detected', 'confirmed')
            AND representation_class <> 'pending'
            AND (
              finality_claimed_until IS NULL
              OR finality_claimed_until < ${now.toISOString()}
            )
          ORDER BY slot, signature
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE discovered_signatures AS discovered SET
          finality_claimed_until = ${new Date(
            now.getTime() + 60_000,
          ).toISOString()},
          finality_claim_token = gen_random_uuid()
        FROM candidates
        WHERE discovered.watch_target_id = candidates.watch_target_id
          AND discovered.signature = candidates.signature
        RETURNING
          discovered.watch_target_id,
          (
            SELECT target.cluster FROM watch_targets AS target
            WHERE target.id = discovered.watch_target_id
          ) AS cluster,
          discovered.signature,
          discovered.slot,
          discovered.finality_state,
          discovered.parse_digest,
          discovered.missing_observation_count,
          discovered.first_missing_finalized_slot,
          discovered.finality_claim_token,
          EXISTS (
            SELECT 1 FROM raw_transactions AS raw
            WHERE raw.provider_id = discovered.provider_id
              AND raw.signature = discovered.signature
              AND raw.commitment = 'finalized'
          ) AS has_finalized_snapshot
      `;
      return rows.map((row) => ({
        providerId,
        watchTargetId: row.watch_target_id,
        cluster: parseCluster(row.cluster),
        signature: row.signature,
        slot: BigInt(row.slot),
        state: row.finality_state,
        confirmedDigest: row.parse_digest,
        missingObservationCount: row.missing_observation_count,
        firstMissingFinalizedSlot:
          row.first_missing_finalized_slot === null
            ? null
            : BigInt(row.first_missing_finalized_slot),
        claimToken: row.finality_claim_token,
        hasFinalizedSnapshot: row.has_finalized_snapshot,
      }));
    });
  }

  public async recordFinalityObservation(
    input: RecordFinalityObservationInput,
  ): Promise<RecordFinalityObservationResult> {
    return this.#sql.begin(async (transaction) => {
      const representationKey = `${input.candidate.providerId}:${input.candidate.signature}`;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${representationKey}, 0))
      `;
      const existingFinalized = await transaction<RawRow[]>`
        SELECT id::text, digest FROM raw_transactions
        WHERE provider_id = ${input.candidate.providerId}
          AND signature = ${input.candidate.signature}
          AND commitment = 'finalized'
        ORDER BY id
      `;
      let effectiveNextState = input.nextState;
      let effectiveCode = input.code;
      if (effectiveNextState === "reverted" && existingFinalized.length > 0) {
        effectiveNextState = input.candidate.state;
      }
      if (
        input.finalizedSnapshot !== null &&
        existingFinalized.some(
          (snapshot) => snapshot.digest !== input.finalizedSnapshot?.digest,
        )
      ) {
        effectiveNextState = "quarantined";
        effectiveCode = "finality_content_conflict";
      }
      const claimed = await transaction<{ signature: string }[]>`
        UPDATE discovered_signatures SET
          finality_state = ${effectiveNextState},
          missing_observation_count = CASE
            WHEN ${input.observedStatus === null} THEN missing_observation_count + 1
            ELSE 0
          END,
          first_missing_finalized_slot = CASE
            WHEN ${input.observedStatus === null}
              THEN COALESCE(first_missing_finalized_slot, ${input.contextSlot.toString()})
            ELSE NULL
          END,
          finality_claimed_until = NULL,
          finality_claim_token = NULL
        WHERE watch_target_id = ${input.candidate.watchTargetId}
          AND provider_id = ${input.candidate.providerId}
          AND signature = ${input.candidate.signature}
          AND finality_state = ${input.candidate.state}
          AND finality_claim_token = ${input.candidate.claimToken}::uuid
        RETURNING signature
      `;
      if (claimed.length === 0) {
        return { applied: false, state: input.candidate.state };
      }

      let finalizedRawId: string | null = null;
      if (input.finalizedSnapshot !== null) {
        await transaction`
          INSERT INTO raw_transactions (
            provider_id, signature, commitment, digest, canonical_body, body,
            byte_length, retrieved_at
          ) VALUES (
            ${input.candidate.providerId}, ${input.candidate.signature}, 'finalized',
            ${input.finalizedSnapshot.digest}, ${input.finalizedSnapshot.canonicalJson},
            ${input.finalizedSnapshot.canonicalJson}::jsonb,
            ${input.finalizedSnapshot.byteLength},
            ${input.observedAt.toISOString()}
          )
          ON CONFLICT (provider_id, signature, commitment, digest) DO NOTHING
        `;
        const rawRows = await transaction<RawRow[]>`
          SELECT id::text, digest FROM raw_transactions
          WHERE provider_id = ${input.candidate.providerId}
            AND signature = ${input.candidate.signature}
            AND commitment = 'finalized'
            AND digest = ${input.finalizedSnapshot.digest}
          LIMIT 1
        `;
        finalizedRawId = rawRows[0]?.id ?? null;
      }
      const statusJson =
        input.observedStatus === null
          ? null
          : JSON.stringify({
              signature: input.observedStatus.signature,
              slot: input.observedStatus.slot?.toString() ?? null,
              confirmationStatus: input.observedStatus.confirmationStatus,
              err: input.observedStatus.err ?? null,
            });
      await transaction`
        INSERT INTO finality_observations (
          provider_id, signature, observed_status, observed_state, context_slot,
          response_digest, finalized_raw_transaction_id, code, observed_at
        ) VALUES (
          ${input.candidate.providerId}, ${input.candidate.signature},
          ${statusJson}::jsonb,
          ${effectiveNextState}, ${input.contextSlot.toString()},
          ${input.responseDigest}, ${finalizedRawId}, ${effectiveCode ?? null},
          ${input.observedAt.toISOString()}
        )
        ON CONFLICT DO NOTHING
      `;
      await transaction`
        UPDATE chain_events SET current_state = CASE
          WHEN ${effectiveNextState} = 'quarantined' THEN 'quarantined'
          WHEN current_state IN ('finalized', 'failed', 'reverted', 'quarantined')
            AND current_state <> ${effectiveNextState}
            THEN current_state
          ELSE ${effectiveNextState}
        END
        WHERE signature = ${input.candidate.signature}
          AND cluster = ${input.candidate.cluster}
      `;
      if (effectiveNextState === "quarantined") {
        await transaction`
          INSERT INTO ingestion_quarantines (
            provider_id, watch_target_id, signature, raw_transaction_id, code,
            safe_message, created_at
          )
          SELECT
            ${input.candidate.providerId}, ${input.candidate.watchTargetId},
            ${input.candidate.signature},
            ${finalizedRawId}, ${effectiveCode ?? "finality_content_conflict"},
            'Finalized transaction evidence conflicts with confirmed evidence',
            ${input.observedAt.toISOString()}
          WHERE NOT EXISTS (
            SELECT 1 FROM ingestion_quarantines
            WHERE provider_id = ${input.candidate.providerId}
              AND watch_target_id = ${input.candidate.watchTargetId}
              AND signature = ${input.candidate.signature}
              AND code = ${effectiveCode ?? "finality_content_conflict"}
              AND review_state = 'open'
          )
        `;
      }
      if (input.blockingRetry !== true) {
        await transaction`
          UPDATE ingestion_retries SET resolved_at = ${input.observedAt.toISOString()}
          WHERE operation = 'finality'
            AND provider_id = ${input.candidate.providerId}
            AND watch_target_id = ${input.candidate.watchTargetId}
            AND signature = ${input.candidate.signature}
            AND resolved_at IS NULL
        `;
      }
      return { applied: true, state: effectiveNextState };
    });
  }

  public async inspectSignature(
    signature: string,
    options: InspectSignatureOptions = {},
  ): Promise<unknown | null> {
    return readSignatureInspection(this.#sql, signature, options);
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }
}
