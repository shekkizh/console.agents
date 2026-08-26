import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  a2aCliSource,
  A2A_CLI_PATH,
  A2A_CLI_SOURCE_PATH,
} from "../lib/a2a-cli.ts";

test("ships a direct mailbox CLI without MCP or filesystem polling", () => {
  const source = a2aCliSource();
  assert.equal(A2A_CLI_PATH, ".console/bin/a2a");
  assert.equal(A2A_CLI_SOURCE_PATH, ".console/a2a.py");
  assert.match(source, /urllib\.request/);
  assert.match(source, /call_api\("list"/);
  assert.match(source, /call_api\("send"/);
  assert.match(source, /call_api\("wait"/);
  assert.match(source, /MAX_POLL_SECONDS = 20/);
  assert.match(source, /continue_waiting_for_send/);
  assert.match(source, /commands\.add_parser\("progress"/);
  assert.match(source, /commands\.add_parser\("complete"/);
  assert.match(source, /current_fx_session_id/);
  assert.doesNotMatch(source, /\bmcp\b/i);
  assert.doesNotMatch(source, /time\.sleep|requests\.jsonl|responses\//);

  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.argv[1], 'a2a', 'exec')", source],
    { encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});
