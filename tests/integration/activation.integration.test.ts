import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";

const enabled = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);
// This file runs in its own node:test process. Its fixtures always use fake FX;
// neither reconciliation nor stopping may acquire an actual user's sandbox.
if (enabled) {
  process.env.E2E_TEST_MODE = "1";
  process.env.E2E_FAKE_FX = "1";
}
const { config, requireDatabaseUrl } = await import("../../lib/server/config.ts");
const { createAgent, deleteAgent, ensureDefaultAgent, updateAgent } = await import("../../lib/server/agent-store.ts");
const { createConversation, getConversation } = await import("../../lib/server/conversation-store.ts");
const { executeMessageOperation } = await import("../../lib/server/message-runtime.ts");
const { isAgentActivationActive } = await import("../../lib/server/agent-activation.ts");
const { withAgentLifecycleLock } = await import("../../lib/server/agent-lifecycle.ts");
const { stopAgentWorkers, stopConversationWorkers } = await import("../../lib/server/lifecycle-actions.ts");
const { reconcileAgentTasks } = await import("../../lib/server/reconciler.ts");
const { getConversationMessage, markMessageDelivery, nextPendingAgentMessage, publishConversationMessage } = await import("../../lib/server/message-store.ts");

async function fixture(t: { after(fn: () => Promise<void>): void }, label: string) {
  assert.equal(config.e2eFakeFx, true, "integration fixtures must never acquire real sandboxes");
  const ownerId = `integration-activation-${label}-${process.pid}-${Date.now()}`;
  const sql = neon(requireDatabaseUrl());
  t.after(async () => {
    await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
    await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
    await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
  });
  const agent = await ensureDefaultAgent(ownerId);
  const conversation = await createConversation(ownerId, agent.id);
  const send = (content = "E2E_FAKE delay=0 reply=RECOVERED") => publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "human", senderId: ownerId,
    recipientType: "agent", recipientId: agent.id, content,
  });
  return { ownerId, sql, agent, conversation, send };
}

test("activation access is scoped to its active delivery and revoked on stop or disable", { skip: !enabled }, async (t) => {
  const { ownerId, agent, conversation, send } = await fixture(t, "auth");
  const request = await send();
  const claims = { ownerId, agentId: agent.id, conversationId: conversation.id, incomingMessageId: request.id };
  assert.equal(await isAgentActivationActive(claims), false, "queued requests have no running activation");
  await nextPendingAgentMessage({ ownerId, agentId: agent.id });
  assert.equal(await isAgentActivationActive(claims), true, "launching workers can authenticate while claimed");
  for (const changed of [
    { ownerId: "another-owner" }, { agentId: "another-agent" },
    { conversationId: "another-conversation" }, { incomingMessageId: undefined },
  ]) assert.equal(await isAgentActivationActive({ ...claims, ...changed }), false);
  await markMessageDelivery(ownerId, request.id, agent.id, "running");
  assert.equal(await isAgentActivationActive(claims), true);
  await updateAgent(ownerId, agent.id, { enabled: false }, { type: "human", id: ownerId });
  assert.equal(await isAgentActivationActive(claims), false);
  await updateAgent(ownerId, agent.id, { enabled: true }, { type: "human", id: ownerId });
  await stopConversationWorkers(ownerId, conversation.id);
  assert.equal(await isAgentActivationActive(claims), false, "a stopped token stays revoked");
  await assert.rejects(executeMessageOperation(claims, "send", { to: "user", content: "stale publication" }), /no longer active/);
  await assert.rejects(executeMessageOperation(claims, "progress", { content: "stale progress" }), /no longer active/);
  await assert.rejects(executeMessageOperation(claims, "wait", { timeout_s: 0 }), /no longer active/);
  const nextRequest = await send();
  await nextPendingAgentMessage({ ownerId, agentId: agent.id });
  const nextClaims = { ...claims, incomingMessageId: nextRequest.id };
  assert.equal(await isAgentActivationActive(nextClaims), true);
  assert.equal(await isAgentActivationActive(claims), false, "a later activation does not renew the old token");
  await markMessageDelivery(ownerId, nextRequest.id, agent.id, "completed");
  assert.equal(await isAgentActivationActive(nextClaims), false);
});

test("disabling an agent settles active and queued delivery state", { skip: !enabled }, async (t) => {
  const { ownerId, sql, agent, send } = await fixture(t, "disable");
  await send();
  await nextPendingAgentMessage({ ownerId, agentId: agent.id });
  await send();
  await withAgentLifecycleLock({ ownerId, agentId: agent.id }, async () => {
    await stopAgentWorkers(ownerId, agent.id);
    await updateAgent(ownerId, agent.id, { enabled: false }, { type: "human", id: ownerId });
  });
  const rows = await sql.query("SELECT state, settled_at FROM message_deliveries WHERE owner_id = $1 AND recipient_id = $2", [ownerId, agent.id]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.state === "failed" && row.settled_at));
  assert.deepEqual(await reconcileAgentTasks({ ownerId }), { inspected: 0, succeeded: 0, failed: 0 });
});

test("reconciliation dispatches persisted work after the original request handler is lost", { skip: !enabled }, async (t) => {
  const { ownerId, sql, send } = await fixture(t, "reconcile");
  const request = await send();
  const unrelated = await createAgent(ownerId, { name: "Idle peer", specialty: "Helper", instructions: "Help with requests" });
  const result = await reconcileAgentTasks({ ownerId });
  assert.deepEqual(result, { inspected: 1, succeeded: 1, failed: 0 });
  const delivery = await sql.query("SELECT state, settled_at FROM message_deliveries WHERE owner_id = $1 AND message_id = $2", [ownerId, request.id]);
  assert.equal(delivery[0]?.state, "completed");
  assert.ok(delivery[0]?.settled_at);
  const replies = await sql.query("SELECT id FROM conversation_messages WHERE owner_id = $1 AND in_reply_to = $2", [ownerId, request.id]);
  assert.equal(replies.length, 1);
  assert.equal((await getConversationMessage(ownerId, String(replies[0]?.id)))?.content, "RECOVERED");
  assert.deepEqual(await reconcileAgentTasks({ ownerId }), { inspected: 0, succeeded: 0, failed: 0 });
  const untouched = await sql.query("SELECT 1 FROM agent_reconciliation_state WHERE owner_id = $1 AND agent_id = $2", [ownerId, unrelated.id]);
  assert.equal(untouched.length, 0);
});

test("disabling settles an interrupted completion cleanup without rewriting its result", { skip: !enabled }, async (t) => {
  const { ownerId, sql, agent, send } = await fixture(t, "cleanup");
  const request = await send();
  await nextPendingAgentMessage({ ownerId, agentId: agent.id });
  await markMessageDelivery(ownerId, request.id, agent.id, "completed");
  await withAgentLifecycleLock({ ownerId, agentId: agent.id }, () => stopAgentWorkers(ownerId, agent.id));
  const rows = await sql.query("SELECT state, settled_at FROM message_deliveries WHERE owner_id = $1 AND message_id = $2", [ownerId, request.id]);
  assert.equal(rows[0]?.state, "completed");
  assert.ok(rows[0]?.settled_at);
});

test("deleting an agent preserves conversation history and other peers' active work", { skip: !enabled }, async (t) => {
  const { ownerId, agent: general } = await fixture(t, "delete");
  const removed = await createAgent(ownerId, { name: "Removable peer", specialty: "Helper", instructions: "Help with requests" });
  const conversation = await createConversation(ownerId, removed.id);
  const request = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "human", senderId: ownerId,
    recipientType: "agent", recipientId: removed.id, content: "Keep this history",
  });
  const peerRequest = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "agent", senderId: removed.id,
    recipientType: "agent", recipientId: general.id, content: "Other peer is still working",
  });
  await nextPendingAgentMessage({ ownerId, agentId: general.id });
  await withAgentLifecycleLock({ ownerId, agentId: removed.id }, async () => {
    await stopAgentWorkers(ownerId, removed.id);
    assert.deepEqual(await deleteAgent(ownerId, removed.id), { reassignedConversationCount: 1 });
  });
  const kept = await getConversation(ownerId, conversation.id);
  assert.equal(kept?.agentId, general.id);
  assert.equal(kept?.status, "working");
  assert.equal((await getConversationMessage(ownerId, request.id))?.content, "Keep this history");
  assert.equal((await getConversationMessage(ownerId, peerRequest.id))?.senderId, removed.id);
  assert.equal(await isAgentActivationActive({ ownerId, agentId: general.id, conversationId: conversation.id, incomingMessageId: peerRequest.id }), true);
});

test("an active task retains messaging and model access beyond the browser monitoring window", { skip: !enabled }, async (t) => {
  const { ownerId, sql, agent, conversation, send } = await fixture(t, "deadline");
  const { createAgentMessageToken } = await import("../../lib/server/message-auth.ts");
  const { authorizeModelRequest } = await import("../../lib/server/model-gateway-auth.ts");
  const request = await send();
  await nextPendingAgentMessage({ ownerId, agentId: agent.id });
  const claims = { ownerId, agentId: agent.id, conversationId: conversation.id, incomingMessageId: request.id };
  const token = createAgentMessageToken(claims);
  assert.equal(await isAgentActivationActive(claims), true);
  assert.ok(await authorizeModelRequest(token, false));
  await sql.query("UPDATE message_deliveries SET activation_started_at = now() - interval '16 minutes' WHERE owner_id=$1 AND message_id=$2", [ownerId, request.id]);
  assert.equal(await isAgentActivationActive(claims), true);
  assert.ok(await authorizeModelRequest(token, true));
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: agent.id }), undefined, "active work must not be restarted");
});
