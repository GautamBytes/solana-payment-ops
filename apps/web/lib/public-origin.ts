export const defaultPublicWebOrigin = "https://payops-seven.vercel.app";

export function resolvePublicWebOrigin(value: string | undefined): string {
  if (value === undefined) return defaultPublicWebOrigin;

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== value
    ) {
      invalidPublicOrigin();
    }
    return parsed.origin;
  } catch {
    invalidPublicOrigin();
  }
}

function invalidPublicOrigin(): never {
  throw new Error("invalid_public_web_origin");
}
