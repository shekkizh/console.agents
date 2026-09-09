import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";

const enabled = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);
if (enabled) {
  process.env.E2E_TEST_MODE = "1";
  process.env.E2E_FAKE_FX = "1";
}
const { config, requireDatabaseUrl } = await import("../../lib/server/config.ts");
const { createAgent, ensureDefaultAgent } = await import("../../lib/server/agent-store.ts");
const { createConversation, getConversation } = await import("../../lib/server/conversation-store.ts");
const { executeMessageOperation, formatMessageEnvelope } = await import("../../lib/server/message-runtime.ts");
const { claimConversationMessages, getConversationMessage, listMessageArtifacts, latestFxCompletionSessionId, markMessageDelivery, nextPendingAgentMessage, publishConversationMessage } = await import("../../lib/server/message-store.ts");
const { dispatchNextAgentTask } = await import("../../lib/server/task-dispatcher.ts");
const { reconcileAgentTasks } = await import("../../lib/server/reconciler.ts");
const { messagePurpose, messagePurposeSql } = await import("../../lib/message-protocol.ts");

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  assert.equal(config.e2eFakeFx, true);
  const ownerId = `integration-reply-loop-${crypto.randomUUID()}`;
  const sql = neon(requireDatabaseUrl());
  t.after(async () => {
    await sql.query("DELETE FROM agent_events WHERE owner_id=$1", [ownerId]);
    await sql.query("DELETE FROM conversations WHERE owner_id=$1", [ownerId]);
    await sql.query("DELETE FROM agents WHERE owner_id=$1", [ownerId]);
  });
  const a = await ensureDefaultAgent(ownerId);
  const b = await createAgent(ownerId, { name: "Peer B", specialty: "Review", instructions: "Review requested work" });
  const conversation = await createConversation(ownerId, a.id);
  const context = (agentId: string, incomingMessageId?: string) => ({ ownerId, agentId, conversationId: conversation.id, incomingMessageId });
  const request = await publishConversationMessage({
    ownerId, conversationId: conversation.id, senderType: "agent", senderId: a.id,
    recipientType: "agent", recipientId: b.id, content: "Review this implementation",
  });
  return { ownerId, sql, a, b, conversation, context, request };
}

test("a late plain-text result is processed once and cannot generate a reply-to-reply loop", { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  const { ownerId, a, b, context, request, conversation, sql } = f;
  await nextPendingAgentMessage({ ownerId, agentId: b.id });
  const completion = await executeMessageOperation(context(b.id, request.id), "complete", {
    content: "The review is complete.", session_id: "peer-session",
  }) as { messageId: string };
  const reply = await getConversationMessage(ownerId, completion.messageId);
  assert.equal(reply?.recipientId, a.id);
  assert.equal(messagePurpose(reply!), "reply");
  assert.match(await formatMessageEnvelope({ ownerId, message: reply! }), /replyExpected: false/);
  assert.equal((await nextPendingAgentMessage({ ownerId, agentId: a.id }))?.id, reply!.id);
  assert.deepEqual(await claimConversationMessages({ ownerId, agentId: a.id, conversationId: conversation.id }), [], "wait must not steal a claimed activation");
  const artifact = { path: ".console/outbox/result.md", name: "result.md", title: "Review conclusion", kind: "text" as const, mediaType: "text/markdown", content: Buffer.from("Reviewed") };
  const receipt = await executeMessageOperation(context(a.id, reply!.id), "complete", {
    content: "Noted. The review is complete.", session_id: "requester-session",
  }, [artifact]) as { messageId: string };
  const recorded = await getConversationMessage(ownerId, receipt.messageId);
  assert.equal(recorded?.recipientId, a.id);
  assert.equal(messagePurpose(recorded!), "receipt");
  assert.equal((await listMessageArtifacts(ownerId, receipt.messageId)).length, 1);
  assert.equal(await latestFxCompletionSessionId({ ownerId, agentId: a.id, conversationId: conversation.id }), "requester-session");
  assert.equal((await executeMessageOperation(context(a.id, reply!.id), "complete", { content: "Repeated callback" }) as { status: string }).status, "already_completed");
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: a.id }), undefined);
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: b.id }), undefined);
  assert.equal((await getConversation(ownerId, conversation.id))?.status, "completed");
  const backToPeer = await sql.query("SELECT id FROM conversation_messages WHERE owner_id=$1 AND recipient_id=$2", [ownerId, b.id]);
  assert.equal(backToPeer.length, 1, "only the original request goes to B");
  await reconcileAgentTasks({ ownerId }); // Settle both activations without resending anything.
  assert.deepEqual(await reconcileAgentTasks({ ownerId }), { inspected: 0, succeeded: 0, failed: 0 });
});

test("progress does not activate FX, keep a conversation working, or hide a later result", { skip: !enabled }, async (t) => {
  const { ownerId, a, b, context, request, conversation, sql } = await fixture(t);
  await markMessageDelivery(ownerId, request.id, b.id, "completed");
  const progress = await publishConversationMessage({ ownerId, conversationId: conversation.id,
    senderType: "agent", senderId: b.id, recipientType: "agent", recipientId: a.id,
    inReplyTo: request.id, content: "Still reviewing", metadata: { activity: "progress" },
  });
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: a.id }), undefined);
  await sql.query("UPDATE conversations SET status='working' WHERE owner_id=$1 AND id=$2", [ownerId, conversation.id]);
  assert.equal((await getConversation(ownerId, conversation.id))?.status, "completed", "legacy progress-only queues are not work");
  assert.deepEqual(await reconcileAgentTasks({ ownerId }), { inspected: 0, succeeded: 0, failed: 0 });
  const final = await publishConversationMessage({ ownerId, conversationId: conversation.id,
    senderType: "agent", senderId: b.id, recipientType: "agent", recipientId: a.id,
    inReplyTo: request.id, content: "Finished",
  });
  const waited = await executeMessageOperation(context(a.id), "wait", { reply_to: request.id, timeout_s: 0 }) as { messages: Array<{ messageId: string }> };
  assert.equal(waited.messages[0]?.messageId, final.id);
  assert.ok(await getConversationMessage(ownerId, progress.id), "progress remains in history");
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: a.id }), undefined);
});

test("errors while processing an old reply cannot bounce back to the peer", { skip: !enabled }, async (t) => {
  const { ownerId, a, b, request, conversation, sql } = await fixture(t);
  await markMessageDelivery(ownerId, request.id, b.id, "completed");
  await publishConversationMessage({ ownerId, conversationId: conversation.id,
    senderType: "agent", senderId: b.id, recipientType: "agent", recipientId: a.id,
    kind: "error", inReplyTo: request.id, content: "A legacy peer failure", // No new metadata required.
  });
  const outcome = await dispatchNextAgentTask({ ownerId, agentId: a.id }); // Fake FX rejects this prompt; exercise launch failure.
  assert.equal(outcome.status, "failed");
  const results = await sql.query(`SELECT ${messagePurposeSql("m")} AS purpose FROM conversation_messages m WHERE m.owner_id=$1 AND m.sender_id=$2`, [ownerId, a.id]);
  assert.deepEqual(results.map(row => row.purpose).sort(), ["receipt", "request"]);
  assert.equal(await nextPendingAgentMessage({ ownerId, agentId: b.id }), undefined);
  assert.deepEqual(await reconcileAgentTasks({ ownerId }), { inspected: 0, succeeded: 0, failed: 0 });
});

test("explicit replies require the original requester and cannot request another reply", { skip: !enabled }, async (t) => {
  const { ownerId, a, b, request, conversation, context } = await fixture(t);
  await nextPendingAgentMessage({ ownerId, agentId: b.id });
  const reply = await publishConversationMessage({ ownerId, conversationId: conversation.id,
    senderType: "agent", senderId: b.id, recipientType: "agent", recipientId: a.id,
    inReplyTo: request.id, content: "Finished",
  });
  await assert.rejects(executeMessageOperation(context(a.id), "send", { to: b.id, content: "Thanks", reply_to: reply.id }), /not a reply/);
  await assert.rejects(executeMessageOperation(context(b.id, request.id), "send", { to: a.id, content: "Done", reply_to: request.id, wait_for_reply: true }), /cannot request another reply/);
  await assert.rejects(executeMessageOperation(context(b.id, request.id), "send", { to: "user", content: "Wrong recipient", reply_to: request.id }), /request from this recipient/);
});
