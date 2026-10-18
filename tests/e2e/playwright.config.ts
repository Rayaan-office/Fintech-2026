import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const WEB = 5180;
const API = 8100;

// Runs a second copy of the real app on its own ports and its own database (copilot_e2e, filled by
// seed.py), so the journeys never touch development data. The AI and the mailbox are the real ones.
export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  outputDir: path.join(here, "test-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: path.join(here, "playwright-report"), open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `.venv/bin/python ../tests/e2e/seed.py && .venv/bin/uvicorn app.main:app --port ${API}`,
      cwd: path.join(root, "backend"),
      url: `http://localhost:${API}/api/health`,
      env: {
        POSTGRES_DB: "copilot_e2e",
        SCHEDULER_ENABLED: "false",
        APP_BASE_URL: `http://localhost:${WEB}`,
        API_BASE_URL: `http://localhost:${API}`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      cwd: path.join(root, "frontend"),
      url: `http://localhost:${WEB}`,
      env: { WEB_PORT: String(WEB), API_TARGET: `http://localhost:${API}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
