import { defineConfig, devices } from "@playwright/test";

const checkoutToken = "A".repeat(43);
const apiOrigin = "http://127.0.0.1:3401";
const webOrigin = "http://127.0.0.1:3400";

export default defineConfig({
  testDir: "./apps/web/test/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "line",
  use: {
    baseURL: webOrigin,
    channel: process.env.CI ? undefined : "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node apps/web/test/e2e/fixture-api.mjs",
      url: `${apiOrigin}/__test/health`,
      reuseExistingServer: false,
    },
    {
      command: "pnpm --filter @payops/web dev --hostname 127.0.0.1 --port 3400",
      url: `${webOrigin}/pay/${checkoutToken}`,
      reuseExistingServer: false,
      env: {
        PAYOPS_API_ORIGIN: apiOrigin,
        PAYOPS_WEB_ORIGIN: webOrigin,
        NEXT_PUBLIC_PAYOPS_API_ORIGIN: apiOrigin,
        PAYOPS_PUBLIC_WALLET_ANALYSIS_ENABLED: "true",
      },
    },
  ],
});
