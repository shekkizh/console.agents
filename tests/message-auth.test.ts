import assert from "node:assert/strict";
import test from "node:test";

process.env.CONSOLE_INTERNAL_SECRET = "unit-test-message-secret";

const {
  createAgentMessageToken,
  createMessageWakeToken,
  verifyAgentMessageToken,
  verifyMessageWakeToken,
} = await import("../lib/server/message-auth.ts");

const claims = {
  ownerId: "owner-1",
  targetAgentId: "agent-target",
  conversationId: "conversation-1",
  messageId: "00000000-0000-4000-8000-000000000001",
  fromAgentId: "agent-sender",
};

test("signs short-lived message wake tokens scoped to one delivery", () => {
  const now = 1_800_000_000_000;
  const token = createMessageWakeToken(claims, now);
  assert.deepEqual(verifyMessageWakeToken(token, now), {
    ...claims,
    expiresAt: now + 5 * 60_000,
  });
  assert.equal(verifyMessageWakeToken(token, now + 5 * 60_000), undefined);
});

test("rejects modified or malformed message wake tokens", () => {
  const token = createMessageWakeToken(claims, 1_800_000_000_000);
  const [payload, signature] = token.split(".");
  assert.equal(
    verifyMessageWakeToken(`${payload}x.${signature}`, 1_800_000_000_001),
    undefined,
  );
  assert.equal(
    verifyMessageWakeToken(`${token}.extra`, 1_800_000_000_001),
    undefined,
  );
  assert.equal(verifyMessageWakeToken("invalid", 1_800_000_000_001), undefined);
});

test("signs agent-scoped message API tokens separately from wake tokens", () => {
  const now = 1_800_000_000_000;
  const agentClaims = {
    ownerId: "owner-1",
    agentId: "agent-sender",
    conversationId: "conversation-1",
    incomingMessageId: "00000000-0000-4000-8000-000000000001",
    incomingFromAgentId: "agent-target",
  };
  const token = createAgentMessageToken(agentClaims, now);
  assert.deepEqual(verifyAgentMessageToken(token, now), {
    ...agentClaims,
    expiresAt: now + 2 * 60 * 60_000,
  });
  assert.equal(verifyAgentMessageToken(token, now + 2 * 60 * 60_000), undefined);
  assert.equal(verifyMessageWakeToken(token, now), undefined);
  assert.equal(
    verifyAgentMessageToken(createMessageWakeToken(claims, now), now),
    undefined,
  );
});
