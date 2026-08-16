import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("opens a useful sample workspace from the homepage without contact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try PayOps" }).first().click();
  await expect(page).toHaveURL(/\/try$/);
  await expect(page.getByRole("heading", { name: "Try PayOps" })).toBeVisible();
  await expect(page.getByText("Sample data")).toBeVisible();
  await page.getByRole("button", { name: /INV-0422/ }).click();
  const detail = page.getByRole("region", { name: "INV-0422" });
  await expect(
    detail.getByText("Wrong destination", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("Invoice left unpaid")).toBeVisible();
});

test("keeps the sample disclosure after dismissing the guide", async ({
  page,
}) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Dismiss guide" }).click();
  await expect(page.getByRole("note")).toContainText(
    "Realistic synthetic data",
  );
  await expect(page.getByText("Three things to explore")).toHaveCount(0);
});

test("has no serious accessibility violations or horizontal overflow", async ({
  page,
}) => {
  await page.goto("/try");
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
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
});

test("uses the PayOps marketing visual system", async ({ page }) => {
  await page.goto("/try");

  await expect(page.locator(".marketing-header")).toBeVisible();
  await expect(page.locator(".try-experience")).toHaveCSS(
    "background-color",
    "rgb(5, 7, 6)",
  );
  await expect(page.getByRole("heading", { name: "Try PayOps" })).toHaveCSS(
    "font-family",
    /Georgia/,
  );
  await expect(page.locator(".try-summary")).toHaveCSS(
    "background-color",
    "rgb(10, 14, 12)",
  );
  await expect(page.locator(".header-cta")).toHaveCSS(
    "background-color",
    "rgb(22, 229, 162)",
  );
});
