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

test("shows the exact authority gates, health freshness, and incident history", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "operations-stale" },
  });
  await page.goto("/operations");
  const rail = page.getByRole("region", { name: "Production authority" });
  await expect(rail).toContainText("Shadow");
  await expect(rail).toContainText("Consensus healthy");
  await expect(rail).toContainText("Live");
  await expect(rail).toContainText("Worker heartbeat stale");
  await expect(page.getByText("Measurements stale")).toBeVisible();
  await expect(page.getByText("Worker stale", { exact: true })).toBeVisible();
  await expect(page.getByText("Incident history")).toBeVisible();
});

for (const role of ["viewer", "developer"] as const) {
  test(`shows operational authority but no unauthorized controls to a ${role}`, async ({
    page,
    request,
  }) => {
    await request.post(`${fixtureOrigin}/__test/reset`, {
      data: { scenario: role },
    });
    await page.goto("/operations");
    await expect(
      page.getByRole("region", { name: "Production authority" }),
    ).toBeVisible();
    await expect(
      page.getByText("Exception queue is unavailable for this role."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Acknowledge incident" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Promote to live" }),
    ).toHaveCount(0);
  });
}

test("keeps authority and fresh health visible through an exception outage", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "exception-unavailable" },
  });
  await page.goto("/operations");
  await expect(page.getByText("Activation mode: Shadow")).toBeVisible();
  await expect(page.getByText("Measurements fresh")).toBeVisible();
  await expect(
    page.getByText("Exception queue is temporarily unavailable."),
  ).toBeVisible();
});

test("shows operator incident actions without owner promotion", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "operator" },
  });
  await page.goto("/operations");
  await expect(
    page.getByRole("button", { name: "Acknowledge incident" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Promote to live" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assign case" })).toBeVisible();
});

test("cannot promote without explicit confirmation and promotes after confirmation", async ({
  page,
  request,
}) => {
  await page.goto("/operations");
  await page.getByRole("button", { name: "Promote to live" }).click();
  await expect(page.getByText("Activation mode: Shadow")).toBeVisible();
  const before = await request.get(`${fixtureOrigin}/__test/state`);
  expect((await before.json()).activationMode).toBe("shadow");

  await page
    .getByLabel("I confirm this organization is ready for live processing")
    .check();
  await page.getByRole("button", { name: "Promote to live" }).click();
  await expect(page.getByText("Activation mode: Live")).toBeVisible();
});

test("returns focusable actionable feedback for a mutation conflict", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "operations-conflict" },
  });
  await page.goto("/operations");
  await page.getByRole("button", { name: "Acknowledge incident" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ops-notice[role=alert]")).toContainText(
    "The incident changed. Review the latest version and try again.",
  );
});

test("stays usable on mobile without horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile layout assertion");
  await page.goto("/operations");
  await expect(
    page.getByRole("button", { name: "Record decision" }),
  ).toBeVisible();
  const overflowing = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({
        selector: `${element.tagName.toLowerCase()}.${element.className}`,
        right: Math.round(element.getBoundingClientRect().right),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))
      .filter(({ right }) => right > viewport + 1);
  });
  expect(overflowing).toEqual([]);
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
