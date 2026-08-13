import { randomUUID } from "node:crypto";
import type {
  OperationalHealthSnapshot,
  OperationalIncident,
  OperationalIncidentEvent,
  OperationalMeasurementKind,
  PromotionBlocker,
  ProductionControlView,
} from "../lib/operations-api";

interface OperationalActions {
  readonly acknowledge: (formData: FormData) => Promise<void>;
  readonly resolve: (formData: FormData) => Promise<void>;
  readonly promote: (formData: FormData) => Promise<void>;
}

export function OperationalAuthority({
  production,
  authorityState,
  health,
  incidents,
  history,
  healthState = "available",
  incidentState = "available",
  historyState = "available",
  now,
  notice,
  actions,
}: {
  readonly production?: ProductionControlView;
  readonly authorityState?: "unauthorized" | "unavailable";
  readonly health?: OperationalHealthSnapshot;
  readonly incidents?: readonly OperationalIncident[];
  readonly history?: readonly OperationalIncidentEvent[];
  readonly healthState?: "available" | "unauthorized" | "unavailable";
  readonly incidentState?: "available" | "unauthorized" | "unavailable";
  readonly historyState?: "available" | "unauthorized" | "unavailable";
  readonly now: Date;
  readonly notice?: {
    readonly tone: "status" | "conflict";
    readonly message: string;
  };
  readonly actions?: OperationalActions;
}) {
  const live = production?.status.activationMode === "live";
  const measurementState =
    health === undefined ? "degraded" : healthFreshness(health, now);
  const activeIncidents = (incidents ?? []).filter(
    ({ state }) => state !== "resolved",
  );

  return (
    <>
      {notice === undefined ? null : (
        <div
          className={`ops-notice ops-notice-${notice.tone}`}
          role={notice.tone === "conflict" ? "alert" : "status"}
          aria-live="polite"
          tabIndex={-1}
        >
          {notice.message}
        </div>
      )}

      {production === undefined ? (
        <section
          className="authority-panel"
          id="authority"
          aria-label="Production authority"
        >
          <p className="ops-kicker">Production authority</p>
          <h2>
            {authorityState === "unauthorized"
              ? "Authority is unavailable for this session"
              : "Authority is temporarily unavailable"}
          </h2>
          <p>Health and incidents remain available below.</p>
        </section>
      ) : (
        <section
          className="authority-panel"
          id="authority"
          aria-label="Production authority"
        >
          <div className="ops-section-heading authority-heading">
            <div>
              <p className="ops-kicker">Production authority</p>
              <h2>Activation mode: {live ? "Live" : "Shadow"}</h2>
            </div>
            <span
              className={`authority-mode authority-mode-${live ? "live" : "shadow"}`}
            >
              Version {production.status.version}
            </span>
          </div>

          <ol className="authority-rail">
            <li className={live ? "is-complete" : "is-current"}>
              <span className="authority-node" aria-hidden="true" />
              <div>
                <strong>Shadow</strong>
                <span>{live ? "Completed" : "Current processing mode"}</span>
              </div>
            </li>
            <li
              className={
                production.evaluation.eligible ? "is-complete" : "is-blocked"
              }
            >
              <span className="authority-node" aria-hidden="true" />
              <div>
                <strong>Consensus healthy</strong>
                <span>
                  {production.evaluation.eligible
                    ? "All production gates are current"
                    : `${production.evaluation.blockers.length} blocking ${production.evaluation.blockers.length === 1 ? "condition" : "conditions"}`}
                </span>
              </div>
            </li>
            <li className={live ? "is-current" : "is-waiting"}>
              <span className="authority-node" aria-hidden="true" />
              <div>
                <strong>Live</strong>
                <span>
                  {live
                    ? "Production processing active"
                    : "Owner confirmation required"}
                </span>
              </div>
            </li>
          </ol>

          <div className="authority-detail">
            <ul className="gate-list" aria-label="Promotion prerequisites">
              <Gate
                label="Watch coverage"
                ready={
                  production.evaluation.prerequisites.completeWatchCoverage
                }
              />
              <Gate
                label="Worker heartbeat"
                ready={production.evaluation.prerequisites.freshWorkerHeartbeat}
                blockedLabel="Worker heartbeat stale"
              />
              <Gate
                label="Production RPC roles"
                ready={
                  production.evaluation.prerequisites
                    .twoActiveProductionRpcRoles
                }
              />
              <Gate
                label="No open critical incidents"
                ready={
                  production.evaluation.prerequisites.noOpenCriticalIncident
                }
              />
            </ul>
            <div className="authority-next-action">
              <p className="ops-kicker">Next action</p>
              <strong>
                {live
                  ? "No action required"
                  : nextAction(production.evaluation.blockers[0])}
              </strong>
              {!live && production.capabilities.canPromoteProduction ? (
                <form action={actions?.promote}>
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={randomUUID()}
                  />
                  <input
                    type="hidden"
                    name="expectedVersion"
                    value={production.status.version}
                  />
                  <label className="promotion-confirmation">
                    <input
                      type="checkbox"
                      name="confirmed"
                      required
                      value="true"
                    />
                    <span>
                      I confirm this organization is ready for live processing
                    </span>
                  </label>
                  <button
                    type="submit"
                    disabled={!production.evaluation.eligible}
                  >
                    Promote to live
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </section>
      )}

      <section className="health-strip" aria-labelledby="health-heading">
        <div>
          <p className="ops-kicker">Operational health</p>
          <h2 id="health-heading">Fixed five-minute measurements</h2>
        </div>
        <span className={`freshness freshness-${measurementState}`}>
          Measurements {measurementState}
        </span>
        {health === undefined ? (
          <p className="health-degraded">
            {healthState === "unauthorized"
              ? "Operational health is unavailable for this session."
              : "Operational health is temporarily unavailable. Try again shortly."}
          </p>
        ) : health.measurements.length === 0 ? (
          <p className="health-degraded">
            No current measurements. Check the worker before taking action.
          </p>
        ) : (
          <dl className="health-measurements">
            {health.measurements.map((measurement) => (
              <div key={measurement.kind}>
                <dt>{label(measurement.kind)}</dt>
                <dd>
                  {formatMeasurement(measurement.value, measurement.unit)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {health === undefined ? null : (
          <p className="health-counts">
            <strong>{health.openCriticalCount}</strong> critical ·{" "}
            <strong>{health.openWarningCount}</strong> warning incidents active
          </p>
        )}
      </section>

      <section className="incident-panel" id="incidents">
        <div className="ops-section-heading">
          <div>
            <p className="ops-kicker">Operational incidents</p>
            <h2>Conditions requiring an operator</h2>
          </div>
          {incidents === undefined ? null : (
            <span className="count-chip">{activeIncidents.length} active</span>
          )}
        </div>
        {incidents === undefined ? (
          <div className="ops-empty">
            <strong>
              {incidentState === "unauthorized"
                ? "Incident data is unavailable for this session."
                : "Incident data is temporarily unavailable."}
            </strong>
            <p>Retry before taking an operational action.</p>
          </div>
        ) : activeIncidents.length === 0 ? (
          <div className="ops-empty">
            <strong>No active incidents.</strong>
            <p>New warning or critical conditions will appear here.</p>
          </div>
        ) : (
          <div className="incident-list">
            {activeIncidents.map((incident) => (
              <article className="incident-row" key={incident.id}>
                <header>
                  <div>
                    <span className={`severity severity-${incident.severity}`}>
                      {label(incident.severity)}
                    </span>
                    <h3>{label(incident.kind)}</h3>
                  </div>
                  <span
                    className={`incident-state incident-state-${incident.state}`}
                  >
                    {label(incident.state)}
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>Age</dt>
                    <dd>{relativeAge(now, incident.firstObservedAt)}</dd>
                  </div>
                  <div>
                    <dt>Observed</dt>
                    <dd>{incident.occurrenceCount} occurrences</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{relativeAge(now, incident.lastObservedAt)}</dd>
                  </div>
                </dl>
                {production?.capabilities.canManageIncidents ? (
                  <div className="incident-actions">
                    {incident.state === "open" ? (
                      <form action={actions?.acknowledge}>
                        <MutationFields incident={incident} />
                        <button type="submit">Acknowledge incident</button>
                      </form>
                    ) : null}
                    <form action={actions?.resolve}>
                      <MutationFields incident={incident} />
                      <button className="button-secondary" type="submit">
                        Resolve incident
                      </button>
                    </form>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}

        {incidents === undefined ? null : (
          <div className="incident-history">
            <div>
              <p className="ops-kicker">Append-only record</p>
              <h3>Incident history</h3>
            </div>
            {historyState !== "available" ? (
              <p>
                {historyState === "unauthorized"
                  ? "Incident history is unavailable for this session."
                  : "Incident history is temporarily unavailable."}
              </p>
            ) : (history ?? []).length === 0 ? (
              <p>No history is available for the newest incident.</p>
            ) : (
              <ol>
                {(history ?? []).map((event) => (
                  <li key={event.id}>
                    <strong>{label(event.action)}</strong>
                    <span>Version {event.incidentVersion}</span>
                    <time dateTime={event.occurredAt}>
                      {relativeAge(now, event.occurredAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function Gate({
  label: gateLabel,
  blockedLabel,
  ready,
}: {
  readonly label: string;
  readonly blockedLabel?: string;
  readonly ready: boolean;
}) {
  return (
    <li className={ready ? "is-ready" : "is-blocked"}>
      <span aria-hidden="true">{ready ? "✓" : "!"}</span>
      <strong>
        {ready
          ? `${gateLabel} ready`
          : (blockedLabel ?? `${gateLabel} incomplete`)}
      </strong>
    </li>
  );
}

function MutationFields({
  incident,
}: {
  readonly incident: OperationalIncident;
}) {
  return (
    <>
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <input type="hidden" name="incidentId" value={incident.id} />
      <input type="hidden" name="expectedVersion" value={incident.version} />
    </>
  );
}

const REQUIRED_MEASUREMENTS: readonly OperationalMeasurementKind[] = [
  "rpc_consensus_checks",
  "rpc_consensus_disagreements",
  "ingestion_gap_seconds",
  "worker_heartbeat_age_seconds",
  "ledger_mismatches",
  "webhook_dead_letters",
  "webhook_delivery_duration_milliseconds",
];

function healthFreshness(
  health: OperationalHealthSnapshot,
  now: Date,
): "fresh" | "stale" | "degraded" {
  const byKind = new Map(
    health.measurements.map((measurement) => [measurement.kind, measurement]),
  );
  if (
    byKind.size !== REQUIRED_MEASUREMENTS.length ||
    REQUIRED_MEASUREMENTS.some((kind) => !byKind.has(kind))
  ) {
    return "degraded";
  }
  return REQUIRED_MEASUREMENTS.every((kind) => {
    const measurement = byKind.get(kind)!;
    const age = now.getTime() - Date.parse(measurement.generatedAt);
    return age >= -30_000 && age <= measurement.windowSeconds * 1_000;
  })
    ? "fresh"
    : "stale";
}

function nextAction(blocker: PromotionBlocker | undefined): string {
  switch (blocker) {
    case "watch_coverage_incomplete":
      return "Complete watch coverage";
    case "worker_heartbeat_stale":
      return "Restore a fresh worker heartbeat";
    case "production_rpc_roles_incomplete":
      return "Configure both production RPC roles";
    case "open_critical_incident":
      return "Resolve the open critical incident";
    default:
      return "Confirm promotion with a fresh owner session";
  }
}

function formatMeasurement(
  value: number,
  unit: "count" | "seconds" | "milliseconds",
): string {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit === "count" ? formatted : `${formatted} ${unit}`;
}

function label(value: string): string {
  const text = value.replaceAll("_", " ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function relativeAge(now: Date, value: string): string {
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(value)) / 60_000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
