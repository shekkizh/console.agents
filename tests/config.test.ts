import assert from "node:assert/strict";
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
