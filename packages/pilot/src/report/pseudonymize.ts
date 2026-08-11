import { createHmac } from "node:crypto";

export function pseudonymize(
  kind: "watch" | "invoice" | "customer" | "event",
  originalId: string,
  secret: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(originalId, "utf8")
    .digest("hex");
  return `${kind}_${digest.slice(0, 12)}`;
}
