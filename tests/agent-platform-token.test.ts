import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import { signAgentPlatformToken, verifySignedAgentPlatformToken } from "../lib/server/agent-platform-token.ts";

const secret = "test-only-agent-platform-secret";
const identity = { ownerId: "user_123", agentId: "console-agent_456" };

test("agent platform token preserves its scoped identity", async () => {
  const token = await signAgentPlatformToken(identity, secret, 2_000);
  assert.deepEqual(await verifySignedAgentPlatformToken(token, secret, 1_000), identity);
});

test("agent platform token rejects tampering and the wrong signing secret", async () => {
  const token = await signAgentPlatformToken(identity, secret, 2_000);
  const [payload, signature] = token.split(".");
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("a") ? "b" : "a"}`;

  assert.equal(await verifySignedAgentPlatformToken(`${tamperedPayload}.${signature}`, secret, 1_000), undefined);
  assert.equal(await verifySignedAgentPlatformToken(token, "different-secret", 1_000), undefined);
});

test("agent platform token expires and malformed tokens are rejected", async () => {
  const token = await signAgentPlatformToken(identity, secret, 2_000);

  assert.equal(await verifySignedAgentPlatformToken(token, secret, 2_000), undefined);
  assert.equal(await verifySignedAgentPlatformToken("not-a-token", secret, 1_000), undefined);
  assert.equal(await verifySignedAgentPlatformToken(`${token}.extra`, secret, 1_000), undefined);
});
