import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  retries: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Cold result pages call /api/analyze from the browser (v3 §2), so the suite's many page loads share one
    // client id: the live-analysis limit is raised for the local server only.
    // Lets the e2e suite inject a HoodScan outage via ?simulate=hoodscan-down (never set in production).
    env: { HOODTIER_ALLOW_SIMULATE: "1", RATE_LIMIT_PER_MIN: "1000" },
  },
});
