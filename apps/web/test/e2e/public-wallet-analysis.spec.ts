import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:3401";
const walletAddress = "7dHbWXmci3dT8UFYWYZweBLj7D6kvsUNsAjpUXy5x8Ci";
const recipient = "11111111111111111111111111111111";
const reference = "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM";

async function openWalletMode(page: Page) {
  await page.goto("/try");
  await page.getByRole("tab", { name: "Use a public wallet" }).click();
  await expect(
    page.getByRole("heading", { name: "Inspect a public wallet" }),
  ).toBeVisible();
}

test("analyzes public payment expectations without an account or wallet connection", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-success" },
  });
  await openWalletMode(page);

  await page.getByLabel("Public wallet address").fill(walletAddress);
  await page.getByLabel("Expected asset").selectOption("USDC");
  await page.getByLabel("Expected amount").fill("12.50");
  await page.getByLabel("Expected recipient wallet").fill(recipient);
  await page.getByLabel("Expected reference").fill(reference);
  await page.getByRole("button", { name: "Analyze wallet" }).click();

  const results = page.getByRole("heading", {
    name: "Finalized transfer evidence",
  });
  await expect(results).toBeFocused();
  await expect(
    page.getByText(
      "All supplied payment expectations match this finalized transfer.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/seed phrase or private key/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /connect|sign/i })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: /sign in|create account/i }),
  ).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
  expect(await horizontalOverflow(page)).toEqual([]);
});

test("explains an empty complete range", async ({ page, request }) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-empty" },
  });
  await openWalletMode(page);
  await page.getByLabel("Public wallet address").fill(walletAddress);
  await page.getByRole("button", { name: "Analyze wallet" }).click();

  await expect(
    page.getByText(
      "No finalized canonical USDC or USDT transfers were found in this range.",
    ),
  ).toBeVisible();
});

test("warns that partial coverage is not zero activity", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-partial" },
  });
  await openWalletMode(page);
  await page.getByLabel("Public wallet address").fill(walletAddress);
  await page.getByRole("button", { name: "Analyze wallet" }).click();

  await expect(
    page.getByText(
      "Coverage is incomplete. Do not treat missing activity as zero activity.",
    ),
  ).toBeVisible();
});

test("reports rate limits and keeps the sample workspace usable", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-rate-limit" },
  });
  await openWalletMode(page);
  await page.getByLabel("Public wallet address").fill(walletAddress);
  await page.getByRole("button", { name: "Analyze wallet" }).click();

  await expect(page.locator(".try-error")).toHaveText(
    "Too many analyses. Try again in 42 seconds.",
  );
  await page.getByRole("tab", { name: "Explore sample workspace" }).click();
  await expect(page.getByText("Three things to explore")).toBeVisible();
});

test("fails safely when live analysis is unavailable", async ({
  page,
  request,
}) => {
  await request.post(`${fixtureOrigin}/__test/reset`, {
    data: { scenario: "wallet-unavailable" },
  });
  await openWalletMode(page);
  await page.getByLabel("Public wallet address").fill(walletAddress);
  await page.getByRole("button", { name: "Analyze wallet" }).click();

  await expect(page.locator(".try-error")).toHaveText(
    "Live analysis is temporarily unavailable. The sample workspace still works.",
  );
  await page.getByRole("tab", { name: "Explore sample workspace" }).click();
  await expect(page.getByRole("button", { name: /INV-0421/ })).toBeVisible();
});

test("fixture rejects secret-shaped public analysis fields", async ({
  request,
}) => {
  for (const forbiddenField of ["seedPhrase", "privateKey", "signature"]) {
    const response = await request.post(
      `${fixtureOrigin}/v1/public/wallet-analysis`,
      {
        headers: { origin: "http://127.0.0.1:3400" },
        data: {
          walletAddress,
          rangeDays: 7,
          [forbiddenField]: "must-not-be-accepted",
        },
      },
    );
    expect(response.status()).toBe(400);
    expect(response.headers()["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:3400",
    );
  }
});

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
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
}
