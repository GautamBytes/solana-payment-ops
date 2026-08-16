import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function expectNoOverflow(page: Page) {
  const overflowing = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(
        (element) => element.getBoundingClientRect().right > viewportWidth + 1,
      )
      .slice(-8)
      .map((element) => ({
        className: element.className,
        tagName: element.tagName,
        right: Math.round(element.getBoundingClientRect().right),
      }));
  });
  expect(overflowing).toEqual([]);
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
}

test("exposes the self-serve product and public trust navigation", async ({
  page,
}) => {
  await page.goto("/");

  const hero = page.locator(".hero");
  await expect(hero.getByRole("link", { name: "Try PayOps" })).toHaveAttribute(
    "href",
    "/try",
  );
  await expect(
    hero.getByRole("link", { name: "Developer quickstart" }),
  ).toHaveAttribute("href", "/docs/quickstart");

  const footer = page.locator(".marketing-footer");
  await expect(footer.getByRole("link", { name: "About" })).toHaveAttribute(
    "href",
    "/about",
  );
  await expect(footer.getByRole("link", { name: "Roadmap" })).toHaveAttribute(
    "href",
    "/roadmap",
  );
  await expect(footer.getByRole("link", { name: "Status" })).toHaveAttribute(
    "href",
    "/health/ready",
  );
  await expect(footer.getByRole("link", { name: "Support" })).toHaveAttribute(
    "href",
    /SUPPORT\.md$/,
  );
});

test("publishes an accessible factual About page", async ({ page }) => {
  await page.goto("/about");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Payment evidence that teams can reproduce.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Gautam Manchandani")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why Solana" })).toBeVisible();
  await expect(page.getByText("Token-2022 is not supported")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const footer = page.locator(".marketing-footer");
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeVisible();
  await expect(footer.getByRole("link", { name: "Security" })).toBeVisible();

  await expectNoOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("separates shipped work from active and funded milestones", async ({
  page,
}) => {
  await page.goto("/roadmap");

  await expect(page.getByRole("heading", { name: "Shipped" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "In progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Proposed grant milestones" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Hosted readiness checks, recovery runbooks, and structured logs",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Backup restore and incident drill evidence"),
  ).toBeVisible();
  await expect(page.getByText("Independent security review")).toBeVisible();
  await expect(page.getByText(/% complete/i)).toHaveCount(0);

  await expectNoOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test("keeps public trust routes reachable from the mobile menu", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile navigation behavior");
  await page.goto("/about");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("navigation", {
    name: "Mobile navigation",
  });
  await expect(navigation).toBeVisible();
  await expect(
    navigation.getByRole("link", { name: "Try PayOps" }),
  ).toHaveAttribute("href", "/try");
  await navigation.getByRole("link", { name: "Documentation" }).click();
  await expect(page).toHaveURL(/\/docs$/);
});
