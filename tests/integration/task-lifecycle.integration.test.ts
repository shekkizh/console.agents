import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { ensureDefaultAgent } from "../../lib/server/agent-store.ts";
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
    assert.equal((await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
    }))?.id, request.id);
    await markMessageDelivery(ownerId, request.id, agent.id, "running");

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
