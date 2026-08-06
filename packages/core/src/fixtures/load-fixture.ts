import { readFile } from "node:fs/promises";
import { PaymentFixtureSchema, type PaymentFixture } from "./schema.js";

export async function loadPaymentFixture(
  path: string,
): Promise<PaymentFixture> {
  const json = await readFile(path, "utf8");
  return PaymentFixtureSchema.parse(JSON.parse(json));
}
