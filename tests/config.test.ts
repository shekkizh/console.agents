import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { databaseUrl } from "../lib/server/config.ts";

test("can isolate local work in a separate database name", () => {
  assert.equal(
    databaseUrl(
      "postgresql://owner:secret@example.test/deployed?sslmode=require",
      "console_agents_dev",
    ),
    "postgresql://owner:secret@example.test/console_agents_dev?sslmode=require",
  );
  assert.throws(
    () => databaseUrl("postgresql://owner:secret@example.test/deployed", "unsafe/name"),
    /unsupported characters/,
  );
});

test("prefers the public app URL over a protected Vercel deployment URL", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { consoleAgentApiUrl, consoleInternalUrl } from "./lib/server/config.ts"; console.log(JSON.stringify({ internal: consoleInternalUrl(), api: consoleAgentApiUrl() }));',
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        CONSOLE_INTERNAL_URL: "",
        CONSOLE_AGENT_API_URL: "",
        NEXT_PUBLIC_APP_URL: "https://console.example.test/",
        VERCEL_URL: "protected-deployment.vercel.app",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    internal: "https://console.example.test",
    api: "https://console.example.test/api/a2a",
  });
});
