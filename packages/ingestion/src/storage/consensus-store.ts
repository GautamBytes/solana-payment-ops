import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  ClaimFinalizedConsensusInput,
  CompleteFinalizedConsensusInput,
  CompleteFinalizedConsensusResult,
  FinalizedConsensusClaim,
  FinalizedConsensusClaimed,
  FinalizedConsensusState,
  RpcProviderRoleRecord,
  SetProviderRoleInput,
  SolanaCluster,
} from "../domain/types.js";
import { IngestionError } from "../domain/types.js";

interface ProviderRoleRow {
  readonly organization_id: string;
  readonly cluster: string;
  readonly role: "primary" | "secondary";
  readonly provider_id: string;
  readonly created_at: unknown;
}

interface ConsensusCheckRow {
  readonly id: string;
  readonly organization_id: string;
  readonly cluster: string;
  readonly signature: string;
  readonly generation: number;
  readonly primary_provider_id: string;
  readonly secondary_provider_id: string;
  readonly state: FinalizedConsensusState;
  readonly claim_token: string;
  readonly claimed_until: unknown;
  readonly started_at: unknown;
  readonly completed_at: unknown;
  readonly lease_active: boolean;
}

interface DecodedConsensusCheckRow extends ConsensusCheckRow {
  readonly claimed_until: Date;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

interface DerivedConsensusStateRow {
  readonly state: FinalizedConsensusState;
}

class ConsensusLeaseExpired extends Error {}

export async function setProviderRole(
  sql: Sql,
  organizationId: string,
  input: SetProviderRoleInput,
): Promise<RpcProviderRoleRecord> {
  validateProviderRoleInput(input);
  return sql.begin(async (transaction) => {
    const lockKey = `${organizationId}:${input.cluster}:rpc-provider-roles`;
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const providers = await transaction<
      { id: string; cluster: string; active: boolean }[]
    >`
      SELECT id, cluster, active FROM rpc_providers
      WHERE id = ${input.providerId}
      FOR SHARE
    `;
    const provider = providers[0];
    if (
      provider === undefined ||
      !provider.active ||
      provider.cluster !== input.cluster
    ) {
      throw invalidConfiguration("Provider role configuration is invalid");
    }
    const existing = await transaction<ProviderRoleRow[]>`
      SELECT organization_id::text, cluster, role, provider_id, created_at
      FROM rpc_provider_roles
      WHERE organization_id = ${organizationId}::uuid
        AND cluster = ${input.cluster}
        AND (role = ${input.role} OR provider_id = ${input.providerId})
      ORDER BY role
      FOR UPDATE
    `;
    const exact = existing.find(
      (row) => row.role === input.role && row.provider_id === input.providerId,
    );
    if (exact !== undefined) return toProviderRole(exact);
    if (existing.length > 0) {
      throw invalidConfiguration("Provider roles must be unique and distinct");
    }
    const rows = await transaction<ProviderRoleRow[]>`
      INSERT INTO rpc_provider_roles (
        organization_id, cluster, role, provider_id, created_at
      ) VALUES (
        ${organizationId}::uuid, ${input.cluster}, ${input.role},
        ${input.providerId}, ${input.now.toISOString()}
      )
      RETURNING organization_id::text, cluster, role, provider_id, created_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new IngestionError(
        "database_unavailable",
        "Provider role could not be stored",
        { retryable: true },
      );
    }
    return toProviderRole(row);
  });
}

export async function claimFinalizedConsensus(
  sql: Sql,
  organizationId: string,
  input: ClaimFinalizedConsensusInput,
): Promise<FinalizedConsensusClaim> {
  validateConsensusIdentity(input);
  return sql.begin(async (transaction) => {
    const roles = await transaction<Omit<ProviderRoleRow, "created_at">[]>`
      SELECT role.organization_id::text, role.cluster, role.role,
        role.provider_id
      FROM rpc_provider_roles AS role
      JOIN rpc_providers AS provider ON provider.id = role.provider_id
        AND provider.active AND provider.cluster = role.cluster
      WHERE role.organization_id = ${organizationId}::uuid
        AND (
          (role.role = 'primary' AND role.provider_id = ${input.primaryProviderId})
          OR (role.role = 'secondary' AND role.provider_id = ${input.secondaryProviderId})
        )
      ORDER BY role.role
    `;
    if (
      roles.length !== 2 ||
      roles[0]?.cluster !== roles[1]?.cluster ||
      roles[0]?.role !== "primary" ||
      roles[1]?.role !== "secondary"
    ) {
      throw invalidConfiguration(
        "Active provider roles do not match verification input",
      );
    }
    const cluster = parseCluster(roles[0].cluster);
    const lockKey = `${organizationId}:${cluster}:${input.signature}:rpc-consensus`;
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const latestRow = (
      await transaction<ConsensusCheckRow[]>`
        SELECT id::text, organization_id::text, cluster, signature, generation,
          primary_provider_id, secondary_provider_id, state,
          claim_token::text, claimed_until, started_at, completed_at,
          claimed_until >= clock_timestamp() AS lease_active
        FROM rpc_consensus_checks
        WHERE organization_id = ${organizationId}::uuid
          AND cluster = ${cluster}
          AND signature = ${input.signature}
        ORDER BY generation DESC
        LIMIT 1
        FOR UPDATE
      `
    )[0];
    const latest =
      latestRow === undefined ? undefined : decodeConsensusCheckRow(latestRow);
    const latestMatchesPair =
      latest?.primary_provider_id === input.primaryProviderId &&
      latest.secondary_provider_id === input.secondaryProviderId;
    if (
      latest !== undefined &&
      latestMatchesPair &&
      (latest.state === "agreed" || latest.state === "disagreed")
    ) {
      return {
        kind: "settled",
        state: latest.state,
        generation: latest.generation,
      };
    }
    if (
      latest !== undefined &&
      latestMatchesPair &&
      latest.completed_at === null &&
      latest.lease_active
    ) {
      return toClaim(latest);
    }
    const generation = (latest?.generation ?? 0) + 1;
    const claimToken = randomUUID();
    const rows = await transaction<ConsensusCheckRow[]>`
      WITH db_clock AS (
        SELECT clock_timestamp() AS now
      )
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at
      ) SELECT
        ${organizationId}::uuid, ${cluster}, ${input.signature}, ${generation},
        ${input.primaryProviderId}, ${input.secondaryProviderId}, 'pending',
        ${claimToken}::uuid, db_clock.now + interval '60 seconds', db_clock.now
      FROM db_clock
      RETURNING id::text, organization_id::text, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token::text, claimed_until, started_at, completed_at,
        true AS lease_active
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new IngestionError(
        "database_unavailable",
        "Consensus check could not be claimed",
        { retryable: true },
      );
    }
    return toClaim(decodeConsensusCheckRow(row));
  });
}

export async function completeFinalizedConsensus(
  sql: Sql,
  input: CompleteFinalizedConsensusInput,
): Promise<CompleteFinalizedConsensusResult> {
  validateCompletion(input);
  try {
    return await sql.begin(async (transaction) => {
      const lockKey = `${input.claim.organizationId}:${input.claim.cluster}:${input.claim.signature}:rpc-consensus`;
      await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
      const latestRow = (
        await transaction<ConsensusCheckRow[]>`
        SELECT id::text, organization_id::text, cluster, signature, generation,
          primary_provider_id, secondary_provider_id, state,
          claim_token::text, claimed_until, started_at, completed_at,
          claimed_until >= clock_timestamp() AS lease_active
        FROM rpc_consensus_checks
        WHERE organization_id = ${input.claim.organizationId}::uuid
          AND cluster = ${input.claim.cluster}
          AND signature = ${input.claim.signature}
        ORDER BY generation DESC
        LIMIT 1
        FOR UPDATE
      `
      )[0];
      const latest =
        latestRow === undefined
          ? undefined
          : decodeConsensusCheckRow(latestRow);
      if (
        latest === undefined ||
        latest.generation !== input.claim.generation ||
        latest.claim_token !== input.claim.claimToken ||
        latest.completed_at !== null ||
        latest.state !== "pending" ||
        !latest.lease_active
      ) {
        return {
          applied: false,
          state: latest?.state ?? "pending",
          generation: latest?.generation ?? input.claim.generation,
        };
      }
      if (
        latest.primary_provider_id !== input.claim.primaryProviderId ||
        latest.secondary_provider_id !== input.claim.secondaryProviderId
      ) {
        throw invalidConfiguration(
          "Consensus claim providers do not match the persisted check",
        );
      }
      for (const observation of input.observations) {
        await transaction`
        INSERT INTO rpc_consensus_provider_observations (
          organization_id, consensus_check_id, generation, provider_id,
          canonical_digest, snapshot_digest, parsing_digest,
          transfer_identity_digest, status_slot, slot, execution_state,
          execution_digest, status_execution_digest,
          transaction_execution_digest,
          finality, response_time_ms, safe_error_code, safe_error_retryable,
          observed_at, created_at
        ) VALUES (
          ${input.claim.organizationId}::uuid, ${latest.id}::bigint,
          ${input.claim.generation}, ${observation.providerId},
          ${observation.canonicalDigest}, ${observation.snapshotDigest},
          ${observation.parsingDigest}, ${observation.transferIdentityDigest},
          ${observation.statusSlot?.toString() ?? null},
          ${observation.slot?.toString() ?? null}, ${observation.executionState},
          ${observation.executionDigest}, ${observation.statusExecutionDigest},
          ${observation.transactionExecutionDigest}, ${observation.finality},
          ${observation.responseTimeMs}, ${observation.safeErrorCode},
          ${observation.safeErrorRetryable},
          ${observation.observedAt.toISOString()},
          clock_timestamp()
        )
      `;
      }
      const derivedRows = await transaction<DerivedConsensusStateRow[]>`
      SELECT CASE
        WHEN count(*) FILTER (
          WHERE safe_error_code = 'rpc_signature_conflict'
        ) > 0 THEN 'disagreed'
        WHEN count(*) FILTER (
          WHERE canonical_digest IS NOT NULL
            AND snapshot_digest IS NOT NULL
            AND parsing_digest IS NOT NULL
            AND transfer_identity_digest IS NOT NULL
            AND status_slot IS NOT NULL
            AND slot IS NOT NULL
            AND execution_state IS NOT NULL
            AND execution_digest IS NOT NULL
            AND status_execution_digest IS NOT NULL
            AND transaction_execution_digest IS NOT NULL
            AND finality IS NOT NULL
            AND safe_error_code IS NULL
        ) < 2 THEN 'pending'
        WHEN min(finality) <> 'finalized/finalized'
          OR max(finality) <> 'finalized/finalized'
          OR count(*) FILTER (WHERE status_slot <> slot) > 0
          OR count(*) FILTER (
            WHERE status_execution_digest <> transaction_execution_digest
          ) > 0
        THEN 'disagreed'
        WHEN min(canonical_digest) = max(canonical_digest)
          AND min(snapshot_digest) = max(snapshot_digest)
          AND min(parsing_digest) = max(parsing_digest)
          AND min(transfer_identity_digest) = max(transfer_identity_digest)
          AND min(slot) = max(slot)
          AND min(execution_state) = max(execution_state)
          AND min(execution_digest) = max(execution_digest)
          AND min(status_execution_digest) = max(status_execution_digest)
          AND min(transaction_execution_digest)
            = max(transaction_execution_digest)
          AND min(finality) = max(finality)
        THEN 'agreed'
        ELSE 'disagreed'
      END AS state
      FROM rpc_consensus_provider_observations
      WHERE organization_id = ${input.claim.organizationId}::uuid
        AND consensus_check_id = ${latest.id}::bigint
        AND generation = ${input.claim.generation}
        AND provider_id IN (
          ${latest.primary_provider_id}, ${latest.secondary_provider_id}
        )
    `;
      const derivedState = derivedRows[0]?.state;
      if (
        derivedState === undefined ||
        !isConsensusState(derivedState) ||
        derivedState !== input.state
      ) {
        throw invalidConfiguration(
          "Consensus completion state is inconsistent",
        );
      }
      if (derivedState === "disagreed") {
        await transaction`
        UPDATE chain_events SET current_state = 'quarantined'
        WHERE cluster = ${input.claim.cluster}
          AND signature = ${input.claim.signature}
          AND current_state <> 'quarantined'
      `;
        await transaction`
        INSERT INTO ingestion_quarantines (
          provider_id, watch_target_id, signature, code, safe_message, created_at
        )
        SELECT ${latest.primary_provider_id}, discovered.watch_target_id,
          ${input.claim.signature}, 'finality_provider_disagreement',
          'Independent finalized RPC evidence disagreed',
          clock_timestamp()
        FROM discovered_signatures AS discovered
        WHERE discovered.provider_id = ${latest.primary_provider_id}
          AND discovered.signature = ${input.claim.signature}
          AND NOT EXISTS (
            SELECT 1 FROM ingestion_quarantines AS existing
            WHERE existing.provider_id = ${latest.primary_provider_id}
              AND existing.watch_target_id = discovered.watch_target_id
              AND existing.signature = ${input.claim.signature}
              AND existing.code = 'finality_provider_disagreement'
              AND existing.review_state = 'open'
          )
        ORDER BY discovered.watch_target_id
        LIMIT 1
      `;
      }
      const updates = await transaction<DerivedConsensusStateRow[]>`
      UPDATE rpc_consensus_checks
      SET state = ${derivedState}, completed_at = clock_timestamp()
      WHERE id = ${latest.id}::bigint
        AND generation = ${input.claim.generation}
        AND claim_token = ${input.claim.claimToken}::uuid
        AND state = 'pending'
        AND completed_at IS NULL
        AND claimed_until >= clock_timestamp()
      RETURNING state
    `;
      if (updates[0]?.state !== derivedState) {
        throw new ConsensusLeaseExpired();
      }
      return {
        applied: true,
        state: derivedState,
        generation: input.claim.generation,
      };
    });
  } catch (error) {
    if (error instanceof ConsensusLeaseExpired) {
      return {
        applied: false,
        state: "pending",
        generation: input.claim.generation,
      };
    }
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      "database_unavailable",
      "Consensus completion could not be persisted",
      { retryable: true, cause: error },
    );
  }
}

function validateProviderRoleInput(input: SetProviderRoleInput): void {
  if (
    input.providerId.length < 1 ||
    input.providerId.length > 64 ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw invalidConfiguration("Provider role input is invalid");
  }
}

function validateConsensusIdentity(input: ClaimFinalizedConsensusInput): void {
  if (
    input.primaryProviderId === input.secondaryProviderId ||
    input.primaryProviderId.length < 1 ||
    input.primaryProviderId.length > 64 ||
    input.secondaryProviderId.length < 1 ||
    input.secondaryProviderId.length > 64 ||
    input.signature.length < 32 ||
    input.signature.length > 128 ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw invalidConfiguration("Consensus claim input is invalid");
  }
}

function validateCompletion(input: CompleteFinalizedConsensusInput): void {
  if (
    !Array.isArray(input.observations) ||
    input.observations.length !== 2 ||
    !isConsensusState(input.state) ||
    !validUuid(input.claim.organizationId) ||
    !validUuid(input.claim.claimToken) ||
    input.claim.generation < 1 ||
    !Number.isSafeInteger(input.claim.generation) ||
    input.claim.signature.length < 32 ||
    input.claim.signature.length > 128 ||
    input.claim.primaryProviderId.length < 1 ||
    input.claim.primaryProviderId.length > 64 ||
    input.claim.secondaryProviderId.length < 1 ||
    input.claim.secondaryProviderId.length > 64 ||
    !input.observations.every(validObservation)
  ) {
    throw invalidConfiguration("Consensus completion evidence is invalid");
  }
  const providerIds = input.observations
    .map(({ providerId }) => providerId)
    .sort();
  const expected = [
    input.claim.primaryProviderId,
    input.claim.secondaryProviderId,
  ].sort();
  if (providerIds[0] !== expected[0] || providerIds[1] !== expected[1]) {
    throw invalidConfiguration("Consensus completion evidence is invalid");
  }
}

const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumSolanaSlot = 18_446_744_073_709_551_615n;
const persistedProviderErrorCodes = new Set([
  "rpc_transport_error",
  "rpc_rate_limited",
  "rpc_invalid_json",
  "rpc_error",
  "rpc_transaction_missing",
  "rpc_signature_conflict",
  "rpc_unsupported_version",
  "rpc_transaction_schema_invalid",
  "finality_status_missing",
]);

function validObservation(
  observation: CompleteFinalizedConsensusInput["observations"][number],
): boolean {
  if (
    observation.providerId.length < 1 ||
    observation.providerId.length > 64 ||
    !Number.isInteger(observation.responseTimeMs) ||
    observation.responseTimeMs < 0 ||
    observation.responseTimeMs > 300_000 ||
    !validDate(observation.observedAt)
  ) {
    return false;
  }
  const evidence = [
    observation.canonicalDigest,
    observation.snapshotDigest,
    observation.parsingDigest,
    observation.transferIdentityDigest,
    observation.statusSlot,
    observation.slot,
    observation.executionState,
    observation.executionDigest,
    observation.statusExecutionDigest,
    observation.transactionExecutionDigest,
    observation.finality,
  ];
  const complete = evidence.every((value) => value !== null);
  if (complete) {
    return (
      digestPattern.test(observation.canonicalDigest ?? "") &&
      digestPattern.test(observation.snapshotDigest ?? "") &&
      digestPattern.test(observation.parsingDigest ?? "") &&
      digestPattern.test(observation.transferIdentityDigest ?? "") &&
      typeof observation.statusSlot === "bigint" &&
      observation.statusSlot >= 0n &&
      observation.statusSlot <= maximumSolanaSlot &&
      typeof observation.slot === "bigint" &&
      observation.slot >= 0n &&
      observation.slot <= maximumSolanaSlot &&
      (observation.executionState === "succeeded" ||
        observation.executionState === "failed") &&
      digestPattern.test(observation.executionDigest ?? "") &&
      digestPattern.test(observation.statusExecutionDigest ?? "") &&
      digestPattern.test(observation.transactionExecutionDigest ?? "") &&
      typeof observation.finality === "string" &&
      observation.finality.length >= 1 &&
      observation.finality.length <= 32 &&
      observation.safeErrorCode === null &&
      observation.safeErrorRetryable === null
    );
  }
  return (
    evidence.every((value) => value === null) &&
    typeof observation.safeErrorCode === "string" &&
    persistedProviderErrorCodes.has(observation.safeErrorCode) &&
    typeof observation.safeErrorRetryable === "boolean" &&
    (observation.safeErrorCode !== "rpc_signature_conflict" ||
      observation.safeErrorRetryable === false)
  );
}

function validDate(value: Date): boolean {
  try {
    return Number.isFinite(Date.prototype.getTime.call(value));
  } catch {
    return false;
  }
}

function validUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function isConsensusState(value: string): value is FinalizedConsensusState {
  return value === "pending" || value === "agreed" || value === "disagreed";
}

function toProviderRole(row: ProviderRoleRow): RpcProviderRoleRecord {
  return {
    organizationId: row.organization_id,
    cluster: parseCluster(row.cluster),
    role: row.role,
    providerId: row.provider_id,
    createdAt: decodeStoredTimestamp(row.created_at),
  };
}

function toClaim(row: DecodedConsensusCheckRow): FinalizedConsensusClaimed {
  return {
    kind: "claimed",
    organizationId: row.organization_id,
    cluster: parseCluster(row.cluster),
    signature: row.signature,
    generation: row.generation,
    primaryProviderId: row.primary_provider_id,
    secondaryProviderId: row.secondary_provider_id,
    claimToken: row.claim_token,
  };
}

function decodeConsensusCheckRow(
  row: ConsensusCheckRow,
): DecodedConsensusCheckRow {
  return {
    ...row,
    claimed_until: decodeStoredTimestamp(row.claimed_until),
    started_at: decodeStoredTimestamp(row.started_at),
    completed_at:
      row.completed_at === null
        ? null
        : decodeStoredTimestamp(row.completed_at),
  };
}

const canonicalStoredTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function decodeStoredTimestamp(value: unknown): Date {
  let milliseconds: number;
  if (typeof value === "string") {
    const normalized = normalizeStoredTimestamp(value);
    milliseconds = Date.parse(normalized);
    if (!Number.isFinite(milliseconds)) throw invalidStoredTimestamp();
  } else {
    try {
      milliseconds = Date.prototype.getTime.call(value);
    } catch {
      throw invalidStoredTimestamp();
    }
  }
  if (!Number.isFinite(milliseconds)) throw invalidStoredTimestamp();
  return new Date(milliseconds);
}

const postgresStoredTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/;

function normalizeStoredTimestamp(value: string): string {
  if (canonicalStoredTimestampPattern.test(value)) {
    if (new Date(Date.parse(value)).toISOString() !== value) {
      throw invalidStoredTimestamp();
    }
    return value;
  }
  const match = postgresStoredTimestampPattern.exec(value);
  if (match === null) throw invalidStoredTimestamp();
  const [, date, time, fraction = "", sign, offsetHours, offsetMinutes = "00"] =
    match;
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const normalized = `${date}T${time}.${milliseconds}${sign}${offsetHours}:${offsetMinutes}`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw invalidStoredTimestamp();
  return normalized;
}

function invalidStoredTimestamp(): IngestionError {
  return new IngestionError(
    "database_unavailable",
    "Stored consensus timestamp is invalid",
    { retryable: false },
  );
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

function invalidConfiguration(message: string): IngestionError {
  return new IngestionError("invalid_configuration", message, {
    retryable: false,
  });
}
