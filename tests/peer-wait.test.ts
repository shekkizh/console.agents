import assert from "node:assert/strict";
import test from "node:test";
import { executeMessageOperation, remainingPeerWaitSeconds } from "../lib/server/message-runtime.ts";

test("a correlated request cannot renew its server wait budget", () => {
  const created = "2026-09-09T00:00:00.000Z";
  const start = Date.parse(created);
  assert.equal(remainingPeerWaitSeconds(created, 60, start), 60);
  assert.equal(remainingPeerWaitSeconds(created, 60, start + 40_000), 20);
  assert.equal(remainingPeerWaitSeconds(created, 60, start + 61_000), 0);
  assert.equal(remainingPeerWaitSeconds(created, 0, start), 0);
});

test("the server rejects unbounded waits before accessing the database", async () => {
  const context = { ownerId: "unused", agentId: "unused", conversationId: "unused" };
  for (const timeout_s of [61, 3_600, Infinity, -1]) {
    await assert.rejects(executeMessageOperation(context, "wait", { timeout_s }));
    await assert.rejects(executeMessageOperation(context, "send", { to: "peer", content: "request", timeout_s }));
  }
});
