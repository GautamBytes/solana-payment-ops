import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:3401";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "static" },
  });
});

test("reviews and assigns a Solana payment exception", async ({ page }) => {
  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "Payment operations" }),
  ).toBeVisible();
  await expect(page.getByText("Wrong amount")).toBeVisible();
  await page.getByLabel("Assign to").fill("maya@acme.example");
  await page.getByRole("button", { name: "Assign case" }).click();
  await expect(
    page.getByText("Maya@acme.example", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".state-assigned")).toHaveText("Assigned");
});

test("stays usable on mobile without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile layout assertion");
  await page.goto("/operations");
  await expect(
    page.getByRole("button", { name: "Record decision" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("has no serious or critical accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "one browser profile is sufficient",
  );
  await page.goto("/operations");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
});
