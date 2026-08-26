import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import {
  createAgent,
  ensureDefaultAgent,
} from "../../lib/server/agent-store.ts";
import {
  createConversation,
  listConversations,
  stopConversation,
} from "../../lib/server/conversation-store.ts";
import {
  claimConversationMessages,
  isMessageDeliveryPending,
  listConversationActivity,
  listConversationTranscript,
  listMessageArtifacts,
  listReachableAgents,
  markMessageDelivery,
  nextPendingAgentMessage,
  openMessageListener,
  publishConversationMessage,
} from "../../lib/server/message-store.ts";
import { requireDatabaseUrl } from "../../lib/server/config.ts";

const databaseEnabled =
  process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test(
  "uses one conversation-scoped bus for humans and autonomous peer agents",
  { skip: !databaseEnabled },
  async (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownerId = `integration-message-${suffix}`;
    const otherOwnerId = `integration-message-other-${suffix}`;
    const sql = neon(requireDatabaseUrl());

    t.after(async () => {
      for (const testOwnerId of [ownerId, otherOwnerId]) {
        await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [testOwnerId]);
        await sql.query("DELETE FROM conversations WHERE owner_id = $1", [testOwnerId]);
        await sql.query("DELETE FROM agents WHERE owner_id = $1", [testOwnerId]);
      }
    });

    const sender = await ensureDefaultAgent(ownerId);
    const recipient = await createAgent(ownerId, {
      name: "Reviewer",
      specialty: "Reviews technical work",
      instructions: "Independently review technical work and send concise findings to peers.",
    });
    const otherAgent = await ensureDefaultAgent(otherOwnerId);
    const conversation = await createConversation(ownerId, sender.id);

    assert.deepEqual(
      (await listReachableAgents(ownerId, sender.id)).map(({ id, name }) => ({ id, name })),
      [{ id: recipient.id, name: recipient.name }],
    );
    assert.deepEqual(await listReachableAgents(otherOwnerId, otherAgent.id), []);

    const humanMessage = await publishConversationMessage({
      ownerId,
      id: "message-00-human",
      conversationId: conversation.id,
      senderType: "human",
      senderId: ownerId,
      recipientType: "agent",
      recipientId: sender.id,
      content: "Coordinate a review.",
    });
    assert.equal(humanMessage.conversationId, conversation.id);
    assert.equal(
      (await nextPendingAgentMessage({
        ownerId,
        agentId: sender.id,
      }))?.id,
      humanMessage.id,
    );
    await markMessageDelivery(ownerId, humanMessage.id, sender.id, "completed");

    const listener = await openMessageListener(ownerId, recipient.id);
    t.after(() => listener.close());
    const notified = listener.wait(10_000);

    const first = await publishConversationMessage({
      ownerId,
      id: "message-01-review",
      conversationId: conversation.id,
      senderType: "agent",
      senderId: sender.id,
      recipientType: "agent",
      recipientId: recipient.id,
      content: "Review the implementation.",
    });
    await publishConversationMessage({
      ownerId,
      id: "message-02-artifact",
      conversationId: conversation.id,
      senderType: "agent",
      senderId: sender.id,
      recipientType: "agent",
      recipientId: recipient.id,
      content: "Use the attached notes.",
      artifacts: [{
        path: ".console/outbox/notes.md",
        name: "notes.md",
        title: "Review notes",
        mediaType: "text/plain; charset=utf-8",
        kind: "text",
        content: new TextEncoder().encode("# Notes\nCheck the race."),
      }],
    });
    assert.equal(await notified, true);

    const inbox = await claimConversationMessages({
      ownerId,
      agentId: recipient.id,
      conversationId: conversation.id,
      fromAgentId: sender.id,
    });
    assert.deepEqual(inbox.map(({ id }) => id), [
      "message-01-review",
      "message-02-artifact",
    ]);
    assert.ok(inbox.every((message) => message.conversationId === conversation.id));

    const reply = await publishConversationMessage({
      ownerId,
      id: "message-03-reply",
      conversationId: conversation.id,
      senderType: "agent",
      senderId: recipient.id,
      recipientType: "agent",
      recipientId: sender.id,
      inReplyTo: first.id,
      content: "The implementation is sound; keep the FIFO regression test.",
    });
    const correlated = await claimConversationMessages({
      ownerId,
      agentId: sender.id,
      conversationId: conversation.id,
      fromAgentId: recipient.id,
      inReplyTo: first.id,
    });
    assert.deepEqual(correlated.map(({ id, inReplyTo }) => ({ id, inReplyTo })), [{
      id: reply.id,
      inReplyTo: first.id,
    }]);

    const artifacts = await listMessageArtifacts(ownerId, "message-02-artifact");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.name, "notes.md");
    assert.equal(new TextDecoder().decode(artifacts[0]?.content), "# Notes\nCheck the race.");
    assert.deepEqual(await listMessageArtifacts(otherOwnerId, "message-02-artifact"), []);

    const activity = await listConversationActivity(ownerId, conversation.id);
    assert.deepEqual(
      activity.map(({ id, senderType, recipientType, state }) => ({
        id,
        senderType,
        recipientType,
        state,
      })),
      [
        { id: humanMessage.id, senderType: "human", recipientType: "agent", state: "completed" },
        { id: first.id, senderType: "agent", recipientType: "agent", state: "completed" },
        { id: "message-02-artifact", senderType: "agent", recipientType: "agent", state: "completed" },
        { id: reply.id, senderType: "agent", recipientType: "agent", state: "completed" },
      ],
    );
    assert.equal(activity.find(({ id }) => id === "message-02-artifact")?.artifactCount, 1);
    assert.deepEqual(await listConversationActivity(otherOwnerId, conversation.id), []);

    assert.deepEqual(
      (await listConversations(ownerId)).map(({ id }) => id),
      [conversation.id],
    );
    const rows = await sql.query(
      `SELECT count(*)::int AS conversation_count,
         (SELECT count(*)::int
          FROM conversation_messages
          WHERE owner_id = $1 AND conversation_id = $2) AS message_count
       FROM conversations
       WHERE owner_id = $1`,
      [ownerId, conversation.id],
    );
    assert.deepEqual(rows[0], { conversation_count: 1, message_count: 4 });
  },
);

test(
  "stops pending conversation work without deleting its history",
  { skip: !databaseEnabled },
  async (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownerId = `integration-stop-${suffix}`;
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
      id: `message-stop-${suffix}`,
      conversationId: conversation.id,
      senderType: "human",
      senderId: ownerId,
      recipientType: "agent",
      recipientId: agent.id,
      content: "Keep working until I stop you.",
    });

    assert.equal(
      (await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
      }))?.id,
      request.id,
    );
    assert.equal(await isMessageDeliveryPending(ownerId, request.id, agent.id), true);

    const stopped = await stopConversation(ownerId, conversation.id);
    assert.equal(stopped.stoppedDeliveryCount, 1);
    assert.equal(stopped.conversation.status, "failed");
    assert.deepEqual(stopped.targets, [{
      agentId: agent.id,
      messageId: request.id,
    }]);
    assert.equal(await isMessageDeliveryPending(ownerId, request.id, agent.id), false);
    assert.equal(
      (await listConversationTranscript(ownerId, conversation.id))[0]?.failed,
      true,
    );
    assert.equal(
      await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
      }),
      undefined,
    );

    const followUp = await publishConversationMessage({
      ownerId,
      id: `message-after-stop-${suffix}`,
      conversationId: conversation.id,
      senderType: "human",
      senderId: ownerId,
      recipientType: "agent",
      recipientId: agent.id,
      content: "Start a fresh attempt.",
    });
    assert.equal(
      (await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
      }))?.id,
      followUp.id,
    );
  },
);
