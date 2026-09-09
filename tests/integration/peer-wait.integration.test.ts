import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { createAgent, ensureDefaultAgent } from "../../lib/server/agent-store.ts";
import { createConversation } from "../../lib/server/conversation-store.ts";
import { requireDatabaseUrl } from "../../lib/server/config.ts";
import { executeMessageOperation } from "../../lib/server/message-runtime.ts";
import {
  getConversationMessage,
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "../../lib/server/message-store.ts";

const enabled = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("ancestor dependency cycles queue without blocking and expired waits retain requests", { skip: !enabled }, async (t) => {
  const ownerId = `integration-peer-wait-${process.pid}-${Date.now()}`;
  const sql = neon(requireDatabaseUrl());
  t.after(async () => {
    await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
    await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
    await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
  });
  const a = await ensureDefaultAgent(ownerId);
  const b = await createAgent(ownerId, { name: "Peer B", specialty: "Research", instructions: "Help peers" });
  const c = await createAgent(ownerId, { name: "Peer C", specialty: "Research", instructions: "Help peers" });
  const conversation = await createConversation(ownerId, a.id);
  const parent = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "human", senderId: ownerId,
    recipientType: "agent", recipientId: a.id, content: "Begin",
  });
  await nextPendingAgentMessage({ ownerId, agentId: a.id });
  await markMessageDelivery(ownerId, parent.id, a.id, "running");
  const ab = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "agent", senderId: a.id,
    recipientType: "agent", recipientId: b.id, content: "Ask B", metadata: { parentRequestId: parent.id },
  });
  const bc = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "agent", senderId: b.id,
    recipientType: "agent", recipientId: c.id, content: "Ask C", metadata: { parentRequestId: ab.id },
  });
  await nextPendingAgentMessage({ ownerId, agentId: c.id });
  const context = { ownerId, agentId: c.id, conversationId: conversation.id, incomingMessageId: bc.id };
  const response = await executeMessageOperation(context, "send", {
    to: a.id, content: "Ask ancestor A", wait_for_reply: true,
  }) as { status: string; messageId: string; waitSkipped: string };
  assert.equal(response.status, "queued");
  assert.equal(response.waitSkipped, "dependency_cycle");
  const request = await getConversationMessage(ownerId, response.messageId);
  assert.equal(request?.metadata.parentRequestId, bc.id);
  await sql.query("UPDATE conversation_messages SET created_at = now() - interval '2 minutes' WHERE id = $1", [response.messageId]);
  const timedOut = await executeMessageOperation(context, "wait", { reply_to: response.messageId, timeout_s: 60 }) as {
    status: string; waitExhausted: boolean;
  };
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.waitExhausted, true);
  assert.ok(await getConversationMessage(ownerId, response.messageId), "the queued request must survive timeout");
  await assert.rejects(executeMessageOperation(context, "wait", { reply_to: ab.id, timeout_s: 0 }), /sent by this agent/);
});
