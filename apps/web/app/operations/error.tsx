"use client";
export default function OperationsError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <main className="ops-failure">
      <p className="ops-kicker">Operations unavailable</p>
      <h1>The reconciliation desk could not load.</h1>
      <p>Check your session and the PayOps API, then try again.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
