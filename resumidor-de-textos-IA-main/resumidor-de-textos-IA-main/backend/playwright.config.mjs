import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1366, height: 900 },
    headless: true,
  },
  webServer: {
    command: "python3 -m http.server 4173 --directory ../simplify/public",
    port: 4173,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
