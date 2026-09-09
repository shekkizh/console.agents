import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
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

test("defaults all agent creation paths to GLM while honoring FX_MODEL", () => {
  for (const override of [undefined, "custom/model"]) {
    const env = { ...process.env };
    delete env.FX_MODEL;
    if (override) env.FX_MODEL = override;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      'import { config } from "./lib/server/config.ts"; process.stdout.write(config.defaultFxModel);',
    ], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, override ?? "zai/glm-5.3-flash");
  }
});
