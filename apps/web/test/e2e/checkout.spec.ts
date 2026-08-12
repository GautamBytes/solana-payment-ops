import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const checkoutPath = `/pay/${token}`;
const fixtureOrigin = "http://127.0.0.1:3401";

test.beforeEach(async ({ request }) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "static" },
  });
});

test("creates an exact wallet request without layout overflow", async ({
  page,
}) => {
  await page.goto(checkoutPath);
  await expect(
    page.getByRole("heading", { name: "Acme Exports" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /USDC Solana/ }).click();
  await page.getByRole("button", { name: "Lock USDC quote" }).click();
  await expect(
    page.getByRole("link", { name: "Open in wallet" }),
  ).toHaveAttribute("href", /^solana:/);
  await expect(
    page.getByLabel(/QR code for a Solana Pay request/),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("reuses the same quote key after a transient response", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "quote-retry" },
  });
  await page.goto(checkoutPath);
  await page.getByRole("button", { name: /USDC Solana/ }).click();
  await page.getByRole("button", { name: "Lock USDC quote" }).click();
  await expect(page.getByText(/safe quote is not available/)).toBeVisible();
  await page.getByRole("button", { name: "Lock USDC quote" }).click();
  await expect(
    page.getByRole("link", { name: "Open in wallet" }),
  ).toBeVisible();
  const state = await (
    await request.get(`${fixtureOrigin}/__test/state`)
  ).json();
  expect(state.keys).toHaveLength(2);
  expect(state.keys[0]).toBe(state.keys[1]);
  expect(state.keys[0]).toMatch(/^[\x21-\x7e]{16,128}$/);
});

test("removes payment actions as soon as a transfer is detected", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "transition" },
  });
  await page.goto(checkoutPath);
  await page.getByRole("button", { name: /USDC Solana/ }).click();
  await page.getByRole("button", { name: "Lock USDC quote" }).click();
  await expect(
    page.getByText("Payment submission is closed for this request."),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Copy payment link" }),
  ).toHaveCount(0);
  await expect(page.getByText("Invoice paid.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".status-chip")).toHaveText("paid");
});

test("keeps an expired request visible when replacement quoting fails", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "refresh-fail" },
  });
  await page.goto(checkoutPath);
  await page.getByRole("button", { name: "Get a new quote" }).click();
  await expect(
    page.getByRole("heading", { name: "125.50 USDC" }),
  ).toBeVisible();
  await expect(page.getByText(/No payment request was changed/)).toBeVisible();
});

test("has no serious or critical automated accessibility violations", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "one browser profile is sufficient",
  );
  await page.goto(checkoutPath);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
});
