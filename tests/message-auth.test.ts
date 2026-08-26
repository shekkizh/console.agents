import assert from "node:assert/strict";
import test from "node:test";

process.env.CONSOLE_INTERNAL_SECRET = "unit-test-message-secret";

const {
  createAgentMessageToken,
  verifyAgentMessageToken,
} = await import("../lib/server/message-auth.ts");

const claims = {
  ownerId: "owner-1",
  agentId: "agent-sender",
  conversationId: "conversation-1",
  incomingMessageId: "00000000-0000-4000-8000-000000000001",
  incomingFromAgentId: "agent-target",
};

test("signs an agent callback token scoped to its current task", () => {
  const now = 1_800_000_000_000;
  const token = createAgentMessageToken(claims, now);
  assert.deepEqual(verifyAgentMessageToken(token, now), {
    ...claims,
    expiresAt: now + 8 * 60 * 60_000,
  });
  assert.equal(verifyAgentMessageToken(token, now + 8 * 60 * 60_000), undefined);
});

test("rejects modified and malformed callback tokens", () => {
  const now = 1_800_000_000_000;
  const token = createAgentMessageToken(claims, now);
  const [payload, signature] = token.split(".");
  assert.equal(verifyAgentMessageToken(`${payload}x.${signature}`, now + 1), undefined);
  assert.equal(verifyAgentMessageToken(`${token}.extra`, now + 1), undefined);
  assert.equal(verifyAgentMessageToken("invalid", now + 1), undefined);
});
