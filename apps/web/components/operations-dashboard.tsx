import { randomUUID } from "node:crypto";
import type { PaymentException } from "../lib/operations-api";

export interface OperationsActions {
  readonly assign: (formData: FormData) => Promise<void>;
  readonly resolve: (formData: FormData) => Promise<void>;
  readonly evidence: (formData: FormData) => Promise<void>;
  readonly export: (formData: FormData) => Promise<void>;
}

export function OperationsDashboard({
  exceptions,
  now,
  actions,
}: {
  readonly exceptions: readonly PaymentException[];
  readonly now: Date;
  readonly actions?: OperationsActions;
}) {
  const active = exceptions.filter(
    ({ reviewState }) =>
      reviewState !== "resolved" && reviewState !== "ignored",
  );
  const assigned = active.filter(
    ({ assignedTo }) => assignedTo !== null,
  ).length;
  const fromTime = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const throughTime = now.toISOString();

  return (
    <main className="ops-shell">
      <aside className="ops-sidebar" aria-label="Merchant operations">
        <a
          className="ops-brand"
          href="/operations"
          aria-label="PayOps operations home"
        >
          <span className="ops-brand-mark" aria-hidden="true">
            P
          </span>
          <span>PayOps</span>
        </a>
        <nav className="ops-nav" aria-label="Operations sections">
          <a className="is-current" href="#exceptions">
            Exceptions
          </a>
          <a href="#evidence">Evidence</a>
          <a href="#exports">Exports</a>
        </nav>
        <div className="ops-network">
          <span className="network-pulse" aria-hidden="true" />
          Solana mainnet · finality on
        </div>
      </aside>

      <section className="ops-workspace">
        <header className="ops-header">
          <div>
            <p className="ops-kicker">Reconciliation desk</p>
            <h1>Payment operations</h1>
            <p className="ops-intro">
              Review ambiguous transfers, preserve every decision, and hand
              finance a proof trail.
            </p>
          </div>
          <div className="ops-date">
            <span>As of</span>
            <strong>{formatDate(now)}</strong>
          </div>
        </header>

        <section className="ops-summary" aria-label="Queue summary">
          <div>
            <strong>{active.length}</strong>
            <span>{active.length === 1 ? "needs review" : "need review"}</span>
          </div>
          <div>
            <strong>{assigned}</strong>
            <span>in progress</span>
          </div>
          <div>
            <strong>{exceptions.length - active.length}</strong>
            <span>closed in view</span>
          </div>
          <p>
            <span className="proof-dot" /> Every action appends to the audit
            trail
          </p>
        </section>

        <section className="ops-panel" id="exceptions">
          <div className="ops-section-heading">
            <div>
              <p className="ops-kicker">Exception queue</p>
              <h2>Transfers that need a human decision</h2>
            </div>
            <span className="count-chip">{active.length} active</span>
          </div>
          {active.length === 0 ? (
            <div className="ops-empty">
              <strong>Queue clear.</strong>
              <p>
                New payment exceptions will appear here with their chain
                evidence.
              </p>
            </div>
          ) : (
            <div className="exception-list">
              {active.map((item) => (
                <article className="exception-row" key={item.id}>
                  <div className="proof-rail" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="exception-main">
                    <div className="exception-title">
                      <div>
                        <span className={`state state-${item.reviewState}`}>
                          {label(item.reviewState)}
                        </span>
                        <h3>{label(item.ruleCode)}</h3>
                      </div>
                      <time dateTime={item.createdAt}>
                        {relativeAge(now, item.createdAt)}
                      </time>
                    </div>
                    <dl className="exception-facts">
                      <div>
                        <dt>On-chain amount</dt>
                        <dd>
                          {formatBaseUnits(item.amountBaseUnits, item.decimals)}{" "}
                          {item.assetSymbol ?? "Unrecognized token"}
                        </dd>
                      </div>
                      <div>
                        <dt>Token mint</dt>
                        <dd className="operation-identifier">{item.mint}</dd>
                      </div>
                      <div>
                        <dt>Token decimals</dt>
                        <dd>{item.decimals}</dd>
                      </div>
                      <div>
                        <dt>Signature</dt>
                        <dd title={item.signature}>
                          {compact(item.signature)}
                        </dd>
                      </div>
                      <div>
                        <dt>Invoice</dt>
                        <dd>
                          {item.invoiceId === null
                            ? "No match"
                            : compact(item.invoiceId)}
                        </dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd>{item.assignedTo ?? "Unassigned"}</dd>
                      </div>
                    </dl>
                    <div className="case-actions">
                      <form action={actions?.assign}>
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={randomUUID()}
                        />
                        <input
                          type="hidden"
                          name="exceptionId"
                          value={item.id}
                        />
                        <input
                          type="hidden"
                          name="expectedVersion"
                          value={item.version}
                        />
                        <label>
                          Assign to
                          <input
                            name="assignee"
                            type="email"
                            required
                            placeholder="ops@company.com"
                            maxLength={320}
                          />
                        </label>
                        <button type="submit">Assign case</button>
                      </form>
                      <form action={actions?.resolve}>
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={randomUUID()}
                        />
                        <input
                          type="hidden"
                          name="exceptionId"
                          value={item.id}
                        />
                        <input
                          type="hidden"
                          name="expectedVersion"
                          value={item.version}
                        />
                        <label>
                          Decision
                          <select
                            name="resolutionCode"
                            defaultValue="leave_unapplied"
                          >
                            <option value="leave_unapplied">
                              Leave unapplied
                            </option>
                            <option value="reject_payment">
                              Reject payment
                            </option>
                            <option value="mark_duplicate">
                              Mark duplicate
                            </option>
                            <option value="ignore">Ignore</option>
                          </select>
                        </label>
                        <label>
                          Decision note
                          <input
                            name="note"
                            required
                            minLength={3}
                            maxLength={1_024}
                            placeholder="Why this is the right outcome"
                          />
                        </label>
                        <button className="button-secondary" type="submit">
                          Record decision
                        </button>
                      </form>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section
          className="ops-tools"
          aria-label="Evidence and accounting tools"
        >
          <article id="evidence">
            <p className="ops-kicker">Evidence</p>
            <h2>Generate signed evidence</h2>
            <p>
              Create an immutable JSON manifest and readable PDF containing
              payment, quote, allocation, ledger, and webhook facts.
            </p>
            <form action={actions?.evidence}>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <label>
                Invoice ID
                <input
                  name="invoiceId"
                  required
                  pattern="[0-9a-fA-F-]{36}"
                  placeholder="Invoice UUID"
                />
              </label>
              <button type="submit">Generate signed evidence</button>
            </form>
          </article>
          <article id="exports">
            <p className="ops-kicker">Accounting</p>
            <h2>QuickBooks-ready CSV</h2>
            <p>
              Export deterministic, formula-safe rows backed by the immutable
              token subledger.
            </p>
            <form action={actions?.export}>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <input type="hidden" name="format" value="quickbooks_csv" />
              <input type="hidden" name="fromTime" value={fromTime} />
              <input type="hidden" name="throughTime" value={throughTime} />
              <button type="submit">Download last 30 days</button>
            </form>
          </article>
        </section>
      </section>
    </main>
  );
}

function label(value: string): string {
  const text = value.replaceAll("_", " ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
function compact(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
}
function formatBaseUnits(value: string, decimals: number): string {
  if (!/^\d+$/u.test(value)) return "—";
  const units = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  return `${units / scale}.${(units % scale).toString().padStart(decimals, "0")}`;
}
function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}
function relativeAge(now: Date, value: string): string {
  const hours = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(value)) / 3_600_000),
  );
  return hours < 1
    ? "Just now"
    : hours === 1
      ? "1 hour ago"
      : `${hours} hours ago`;
}
