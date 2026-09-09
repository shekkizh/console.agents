import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { createAgent, ensureDefaultAgent } from "../../lib/server/agent-store.ts";
import { createConversation } from "../../lib/server/conversation-store.ts";
import { executeMessageOperation } from "../../lib/server/message-runtime.ts";
import {
  getConversationMessage,
  isMessageDeliveryPending,
  listConversationTranscript,
  listMessageArtifacts,
  latestFxCompletionSessionId,
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "../../lib/server/message-store.ts";
import { requireDatabaseUrl } from "../../lib/server/config.ts";

const databaseEnabled =
  process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test(
  "publishes idempotent progress and completion on the canonical message bus",
  { skip: !databaseEnabled },
  async (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownerId = `integration-task-lifecycle-${suffix}`;
    const sql = neon(requireDatabaseUrl());

    t.after(async () => {
      await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
    });

    const agent = await ensureDefaultAgent(ownerId);
    const conversation = await createConversation(ownerId, agent.id);
    const request = await publishConversationMessage({
      ownerId,
      id: `task-request-${suffix}`,
      conversationId: conversation.id,
      senderType: "human",
      senderId: ownerId,
      recipientType: "agent",
      recipientId: agent.id,
      content: "Build the training data pipeline.",
    });
    assert.equal((await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
    }))?.id, request.id);
    await markMessageDelivery(ownerId, request.id, agent.id, "running");
    assert.equal(await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
    }), undefined);
    await sql.query(
      `UPDATE message_deliveries
       SET running_at = now() - interval '7 hours'
       WHERE owner_id = $1 AND message_id = $2`,
      [ownerId, request.id],
    );
    assert.equal(await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
    }), undefined);

    const context = {
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
      incomingMessageId: request.id,
    };
    const artifact = {
      path: ".console/outbox/pipeline.md",
      name: "pipeline.md",
      title: "Pipeline plan",
      mediaType: "text/markdown; charset=utf-8",
      kind: "text" as const,
      content: new TextEncoder().encode("# Pipeline\n"),
    };
    const firstProgress = await executeMessageOperation(
      context,
      "progress",
      { content: "Input validation is complete.", idempotency_key: "validation" },
    ) as { messageId: string };
    const retriedProgress = await executeMessageOperation(
      context,
      "progress",
      { content: "Input validation is complete.", idempotency_key: "validation" },
    ) as { messageId: string };
    assert.equal(retriedProgress.messageId, firstProgress.messageId);

    const completed = await executeMessageOperation(
      context,
      "complete",
      { content: "Pipeline implementation is ready.", session_id: "fx-session-123" },
      [artifact],
    ) as { status: string; messageId: string };
    assert.equal(completed.status, "completed");
    const retried = await executeMessageOperation(
      context,
      "complete",
      { content: "Pipeline implementation is ready.", session_id: "fx-session-123" },
      [artifact],
    ) as { status: string; messageId: string };
    assert.equal(retried.status, "already_completed");
    assert.equal(retried.messageId, completed.messageId);
    assert.equal(await isMessageDeliveryPending(ownerId, request.id, agent.id), false);

    const response = await getConversationMessage(ownerId, completed.messageId);
    assert.equal(response?.inReplyTo, request.id);
    assert.deepEqual(response?.metadata, {
      activity: "completion",
      sessionId: "fx-session-123",
    });
    assert.equal((await listMessageArtifacts(ownerId, completed.messageId)).length, 1);
    assert.equal(await latestFxCompletionSessionId({
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
    }), "fx-session-123");
    assert.deepEqual(
      (await listConversationTranscript(ownerId, conversation.id)).map(({ role, text }) => ({
        role,
        text,
      })),
      [
        { role: "user", text: "Build the training data pipeline." },
        { role: "assistant", text: "Input validation is complete." },
        { role: "assistant", text: "Pipeline implementation is ready." },
      ],
    );
  },
);

test(
  "correlated waits consume progress but finish only on a reply or error",
  { skip: !databaseEnabled },
  async (t) => {
    const ownerId = `integration-reply-progress-${process.pid}-${Date.now()}`;
    const sql = neon(requireDatabaseUrl());
    t.after(async () => {
      await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
    });
    const sender = await ensureDefaultAgent(ownerId);
    const peer = await createAgent(ownerId, {
      name: "Peer",
      specialty: "Review code",
      instructions: "Review code and report findings.",
    });
    const conversation = await createConversation(ownerId, sender.id);
    const context = { ownerId, agentId: sender.id, conversationId: conversation.id };
    const request = await publishConversationMessage({
      ownerId,
      conversationId: conversation.id,
      senderType: "agent",
      senderId: sender.id,
      recipientType: "agent",
      recipientId: peer.id,
      content: "Review this code",
    });
    const response = {
      ownerId,
      conversationId: conversation.id,
      senderType: "agent" as const,
      senderId: peer.id,
      recipientType: "agent" as const,
      recipientId: sender.id,
      inReplyTo: request.id,
    };
    const progress = await publishConversationMessage({
      ...response, content: "Review in progress", metadata: { activity: "progress" },
    });
    const waitArguments = { reply_to: request.id, from_agent: peer.id, timeout_s: 0 };
    assert.deepEqual(await executeMessageOperation(context, "wait", waitArguments), {
      status: "timeout", messages: [],
    });
    assert.equal(await isMessageDeliveryPending(ownerId, progress.id, sender.id), false);
    assert.ok(await getConversationMessage(ownerId, progress.id));

    const completion = await publishConversationMessage({
      ...response, content: "Review complete", metadata: { activity: "completion" },
    });
    const completed = await executeMessageOperation(context, "wait", waitArguments) as {
      status: string; messages: Array<{ messageId: string; activity: string }>;
    };
    assert.equal(completed.status, "received");
    assert.equal(completed.messages[0]?.messageId, completion.id);
    assert.equal(completed.messages[0]?.activity, "completion");

    const failure = await publishConversationMessage({
      ...response, kind: "error", content: "Peer failed",
    });
    const failed = await executeMessageOperation(context, "wait", waitArguments) as {
      messages: Array<{ messageId: string; kind: string }>;
    };
    assert.equal(failed.messages[0]?.messageId, failure.id);
    assert.equal(failed.messages[0]?.kind, "error");

    const visibleProgress = await publishConversationMessage({
      ...response, content: "Additional progress", metadata: { activity: "progress" },
    });
    const uncorrelated = await executeMessageOperation(context, "wait", { timeout_s: 0 }) as {
      messages: Array<{ messageId: string; activity: string }>;
    };
    assert.equal(uncorrelated.messages[0]?.messageId, visibleProgress.id);
    assert.equal(uncorrelated.messages[0]?.activity, "progress");

    const failedContext = { ownerId, agentId: peer.id, conversationId: conversation.id, incomingMessageId: request.id };
    const firstFailure = await executeMessageOperation(failedContext, "fail", { content: "FX exited before completing" }) as { status: string; messageId: string };
    const retryFailure = await executeMessageOperation(failedContext, "fail", { content: "FX exited before completing" }) as { status: string; messageId: string };
    assert.equal(firstFailure.status, "failed");
    assert.equal(retryFailure.status, "already_failed");
    assert.equal(firstFailure.messageId, retryFailure.messageId);
    assert.equal(await isMessageDeliveryPending(ownerId, request.id, peer.id), false);
    const failureMessage = await getConversationMessage(ownerId, firstFailure.messageId);
    assert.equal(failureMessage?.recipientId, sender.id);
    assert.equal(failureMessage?.inReplyTo, request.id);
  },
);
