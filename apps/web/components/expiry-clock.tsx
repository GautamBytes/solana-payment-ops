export function ExpiryClock({
  expiresAt,
  now,
}: {
  readonly expiresAt: string;
  readonly now: number;
}) {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return (
    <div className="expiry-clock" data-expired={remaining === 0}>
      <span>Quote lock</span>
      <strong
        aria-label={
          remaining === 0
            ? "Quote expired"
            : `${minutes} minutes ${seconds} seconds remaining`
        }
      >
        {remaining === 0
          ? "Expired"
          : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`}
      </strong>
    </div>
  );
}
