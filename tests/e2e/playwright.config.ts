import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

// Runs against the real app: the Vite dev server on :5173 proxying /api to the backend on :8000
export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  outputDir: path.join(here, "test-results"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: path.join(here, "playwright-report"), open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    cwd: path.resolve(here, "../../frontend"),
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
