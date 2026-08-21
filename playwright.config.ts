import { defineConfig } from "@playwright/test";
import {
  E2E_BASE_URL,
  E2E_OWNER_ID,
  E2E_PORT,
  E2E_TOKEN,
} from "./tests/e2e/constants";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 120_000 },
  outputDir: "output/playwright/results",
  reporter: [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { authorization: `Bearer ${E2E_TOKEN}` },
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_TEST_MODE: "1",
      E2E_FAKE_FX: "1",
      E2E_TEST_OWNER_ID: E2E_OWNER_ID,
      E2E_TEST_TOKEN: E2E_TOKEN,
      NEXT_PUBLIC_E2E_TEST_TOKEN: E2E_TOKEN,
    },
  },
});
