import { expect, it } from "vitest";
import { resolveFixturePath } from "../src/resolve-fixture-path.js";

it("resolves a filtered pnpm script argument from the invoking directory", () => {
  expect(
    resolveFixturePath("fixtures/payment.json", "/repo", "/repo/packages/core"),
  ).toBe("/repo/fixtures/payment.json");
});
