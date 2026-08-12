import { notFound } from "next/navigation";
import { CheckoutClient } from "./checkout-client";
import { fetchCheckout } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CheckoutPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  const apiOrigin = process.env.PAYOPS_API_ORIGIN;
  if (typeof apiOrigin !== "string") throw new Error("checkout_unavailable");
  let checkout;
  try {
    checkout = await fetchCheckout(token, apiOrigin);
  } catch {
    throw new Error("checkout_unavailable");
  }
  if (checkout === null) notFound();
  return <CheckoutClient initialCheckout={checkout} />;
}
