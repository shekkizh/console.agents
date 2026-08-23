import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import {
  createAgent,
  deleteAgent,
  ensureDefaultAgent,
  resetAgentSession,
} from "../../lib/server/agent-store.ts";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationMessages,
} from "../../lib/server/conversation-store.ts";
import {
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "../../lib/server/message-store.ts";
import { requireDatabaseUrl } from "../../lib/server/config.ts";

const databaseEnabled =
  process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test(
  "persists an idempotent FIFO mailbox on the canonical message bus",
  { skip: !databaseEnabled },
  async (t) => {
    const ownerId = `integration-mailbox-${process.pid}-${Date.now()}`;
    const sql = neon(requireDatabaseUrl());

    t.after(async () => {
      await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
    });

    const agent = await ensureDefaultAgent(ownerId);
    const conversation = await createConversation(ownerId, agent.id);

    await sql.query(
      "UPDATE agents SET eve_session_id = $3 WHERE owner_id = $1 AND id = $2",
      [ownerId, agent.id, "stale-session"],
    );
    assert.equal(
      (await resetAgentSession(ownerId, agent.id, "different-session")).eveSessionId,
      "stale-session",
    );
    assert.equal(
      (await resetAgentSession(ownerId, agent.id, "stale-session")).eveSessionId,
      null,
    );

    await sql.query(
      `UPDATE conversations
       SET runtime_version = 1, eve_session_id = 'legacy-session'
       WHERE owner_id = $1 AND id = $2`,
      [ownerId, conversation.id],
    );

    const first = {
      ownerId,
      id: "request-alpha",
      conversationId: conversation.id,
      senderType: "human" as const,
      senderId: ownerId,
      recipientType: "agent" as const,
      recipientId: agent.id,
      content: "alpha",
    };
    await Promise.all([
      publishConversationMessage(first),
      publishConversationMessage(first),
    ]);

    const rotatedRows = await sql.query(
      `SELECT runtime_version, eve_session_id,
         (SELECT count(*)::int FROM conversation_messages
          WHERE owner_id = $1 AND conversation_id = $2
            AND id = 'request-alpha') AS request_count
       FROM conversations WHERE owner_id = $1 AND id = $2`,
      [ownerId, conversation.id],
    );
    assert.deepEqual(rotatedRows[0], {
      runtime_version: 2,
      eve_session_id: null,
      request_count: 1,
    });

    await publishConversationMessage({
      ...first,
      id: "request-beta",
      content: "beta",
    });
    const pendingAlpha = await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
    });
    assert.equal(pendingAlpha?.id, "request-alpha");
    assert.equal(pendingAlpha?.content, "alpha");
    assert.equal(pendingAlpha?.deliveryState, "claimed");

    await markMessageDelivery(ownerId, "request-alpha", agent.id, "completed");
    await publishConversationMessage({
      ownerId,
      id: "reply-alpha",
      conversationId: conversation.id,
      senderType: "agent",
      senderId: agent.id,
      recipientType: "human",
      recipientId: ownerId,
      inReplyTo: "request-alpha",
      content: "answer-alpha",
    });

    const pendingBeta = await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
    });
    assert.equal(pendingBeta?.id, "request-beta");
    assert.equal(pendingBeta?.content, "beta");

    await markMessageDelivery(ownerId, "request-beta", agent.id, "completed");
    await Promise.all([
      publishConversationMessage({
        ownerId,
        id: "reply-beta",
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        recipientType: "human",
        recipientId: ownerId,
        inReplyTo: "request-beta",
        content: "answer-beta",
      }),
      publishConversationMessage({
        ownerId,
        id: "reply-beta",
        conversationId: conversation.id,
        senderType: "agent",
        senderId: agent.id,
        recipientType: "human",
        recipientId: ownerId,
        inReplyTo: "request-beta",
        content: "answer-beta",
      }),
    ]);

    assert.equal(
      await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
        conversationId: conversation.id,
      }),
      undefined,
    );
    assert.deepEqual(
      (await listConversationMessages(ownerId, conversation.id)).map(
        ({ role, text }) => ({ role, text }),
      ),
      [
        { role: "user", text: "alpha" },
        { role: "user", text: "beta" },
        { role: "assistant", text: "answer-alpha" },
        { role: "assistant", text: "answer-beta" },
      ],
    );
    const eventRows = await sql.query(
      `SELECT count(*)::int AS count FROM agent_events
       WHERE owner_id = $1 AND conversation_id = $2
         AND event_type LIKE 'message.%'`,
      [ownerId, conversation.id],
    );
    assert.equal(eventRows[0]?.count, 0);

    const persisted = await getConversation(ownerId, conversation.id);
    assert.equal(persisted?.title, "alpha");
    assert.equal(persisted?.eveSessionId, null);
    assert.equal(persisted?.status, "completed");
  },
);

test(
  "deletes conversation messages and preserves reassigned history without crossing owners",
  { skip: !databaseEnabled },
  async (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownerId = `integration-delete-${suffix}`;
    const otherOwnerId = `integration-delete-other-${suffix}`;
    const sql = neon(requireDatabaseUrl());

    t.after(async () => {
      for (const testOwnerId of [ownerId, otherOwnerId]) {
        await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [testOwnerId]);
        await sql.query("DELETE FROM conversations WHERE owner_id = $1", [testOwnerId]);
        await sql.query("DELETE FROM agents WHERE owner_id = $1", [testOwnerId]);
      }
    });

    const general = await ensureDefaultAgent(ownerId);
    const specialist = await createAgent(ownerId, {
      name: "Disposable",
      specialty: "Deletion integration tests",
      instructions: "Create data that can be deleted safely during integration tests.",
    });
    const firstConversation = await createConversation(ownerId, specialist.id);
    const secondConversation = await createConversation(ownerId, specialist.id);
    for (const [conversation, requestId, content] of [
      [firstConversation, "delete-first", "delete this conversation"],
      [secondConversation, "delete-second", "preserve with agent"],
    ] as const) {
      await publishConversationMessage({
        ownerId,
        id: requestId,
        conversationId: conversation.id,
        senderType: "human",
        senderId: ownerId,
        recipientType: "agent",
        recipientId: specialist.id,
        content,
      });
      await markMessageDelivery(ownerId, requestId, specialist.id, "completed");
      await publishConversationMessage({
        ownerId,
        id: `reply-${requestId}`,
        conversationId: conversation.id,
        senderType: "agent",
        senderId: specialist.id,
        recipientType: "human",
        recipientId: ownerId,
        inReplyTo: requestId,
        content: `answered: ${content}`,
      });
    }

    const otherGeneral = await ensureDefaultAgent(otherOwnerId);
    const otherConversation = await createConversation(otherOwnerId, otherGeneral.id);
    await publishConversationMessage({
      ownerId: otherOwnerId,
      id: "other-request",
      conversationId: otherConversation.id,
      senderType: "human",
      senderId: otherOwnerId,
      recipientType: "agent",
      recipientId: otherGeneral.id,
      content: "must survive",
    });

    await assert.rejects(
      deleteConversation(otherOwnerId, firstConversation.id),
      /Conversation not found/,
    );
    await deleteConversation(ownerId, firstConversation.id);
    const firstCounts = await sql.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE owner_id = $1 AND id = $2) AS conversations,
         (SELECT count(*)::int FROM conversation_messages
          WHERE owner_id = $1 AND conversation_id = $2) AS messages`,
      [ownerId, firstConversation.id],
    );
    assert.deepEqual(firstCounts[0], { conversations: 0, messages: 0 });

    await assert.rejects(deleteAgent(ownerId, general.id), /General agent cannot be deleted/);
    await assert.rejects(deleteAgent(otherOwnerId, specialist.id), /Agent not found/);
    await deleteAgent(ownerId, specialist.id);

    const reassigned = await getConversation(ownerId, secondConversation.id);
    assert.equal(reassigned?.agentId, general.id);
    assert.equal(reassigned?.agentName, general.name);
    assert.equal(reassigned?.eveSessionId, null);
    assert.deepEqual(
      (await listConversationMessages(ownerId, secondConversation.id)).map(
        ({ role, text }) => ({ role, text }),
      ),
      [
        { role: "user", text: "preserve with agent" },
        { role: "assistant", text: "answered: preserve with agent" },
      ],
    );
    assert.ok(await getConversation(otherOwnerId, otherConversation.id));
    const otherRows = await sql.query(
      `SELECT count(*)::int AS count FROM conversation_messages
       WHERE owner_id = $1 AND conversation_id = $2`,
      [otherOwnerId, otherConversation.id],
    );
    assert.equal(otherRows[0]?.count, 1);
  },
);
