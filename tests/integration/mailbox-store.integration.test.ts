import assert from "node:assert/strict";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import {
  createAgent,
  deleteAgent,
  ensureDefaultAgent,
  nextPendingAgentMessage,
  recordAgentEvent,
  recordIncomingAgentMessage,
} from "../../lib/server/agent-store.ts";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationMessages,
} from "../../lib/server/conversation-store.ts";

const databaseEnabled =
  process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test(
  "persists an idempotent FIFO mailbox and enforces one terminal result per request",
  { skip: !databaseEnabled },
  async (t) => {
    const ownerId = `integration-mailbox-${process.pid}-${Date.now()}`;
    const sql = neon(process.env.DATABASE_URL!);

    t.after(async () => {
      await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM conversations WHERE owner_id = $1", [ownerId]);
      await sql.query("DELETE FROM agents WHERE owner_id = $1", [ownerId]);
    });

    const agent = await ensureDefaultAgent(ownerId);
    const conversation = await createConversation(ownerId, agent.id);

    await sql.query(
      `UPDATE conversations
       SET runtime_version = 1, eve_session_id = 'legacy-session'
       WHERE owner_id = $1 AND id = $2`,
      [ownerId, conversation.id],
    );

    const first = {
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
      messageId: "request-alpha",
      message: "alpha",
    };
    await Promise.all([
      recordIncomingAgentMessage(first),
      recordIncomingAgentMessage(first),
    ]);

    const rotatedRows = await sql.query(
      `SELECT runtime_version, eve_session_id,
         (SELECT count(*)::int FROM agent_events
          WHERE owner_id = $1 AND conversation_id = $2
            AND event_type = 'message.user'
            AND payload->>'requestId' = 'request-alpha') AS request_count
       FROM conversations WHERE owner_id = $1 AND id = $2`,
      [ownerId, conversation.id],
    );
    assert.deepEqual(rotatedRows[0], {
      runtime_version: 2,
      eve_session_id: null,
      request_count: 1,
    });

    await recordIncomingAgentMessage({
      ...first,
      messageId: "request-beta",
      message: "beta",
      eveSessionId: "current-session",
    });
    await assert.rejects(
      recordIncomingAgentMessage({
        ...first,
        messageId: "request-wrong-session",
        message: "must not be accepted",
        eveSessionId: "other-session",
      }),
      /Conversation not found/,
    );

    const pendingAlpha = await nextPendingAgentMessage({
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
    });
    assert.deepEqual(pendingAlpha, { message: "alpha", requestId: "request-alpha" });

    await recordAgentEvent({
      ownerId,
      agentId: agent.id,
      conversationId: conversation.id,
      actorType: "agent",
      actorId: agent.id,
      eventType: "message.assistant",
      payload: { message: "answer-alpha", requestId: "request-alpha" },
    });
    assert.deepEqual(
      await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
        conversationId: conversation.id,
      }),
      { message: "beta", requestId: "request-beta" },
    );

    await Promise.all([
      recordAgentEvent({
        ownerId,
        agentId: agent.id,
        conversationId: conversation.id,
        actorType: "agent",
        actorId: agent.id,
        eventType: "message.assistant",
        payload: { message: "answer-beta", requestId: "request-beta" },
      }),
      recordAgentEvent({
        ownerId,
        agentId: agent.id,
        conversationId: conversation.id,
        actorType: "eve",
        actorId: "current-session",
        eventType: "message.failed",
        payload: { diagnostic: "racing terminal", requestId: "request-beta" },
      }),
    ]);

    const terminalRows = await sql.query(
      `SELECT count(*)::int AS terminal_count
       FROM agent_events
       WHERE owner_id = $1 AND conversation_id = $2
         AND event_type IN ('message.assistant', 'message.failed')
         AND payload->>'requestId' = 'request-beta'`,
      [ownerId, conversation.id],
    );
    assert.equal(terminalRows[0]?.terminal_count, 1);
    assert.equal(
      await nextPendingAgentMessage({
        ownerId,
        agentId: agent.id,
        conversationId: conversation.id,
      }),
      undefined,
    );

    const transcript = await listConversationMessages(ownerId, conversation.id);
    assert.deepEqual(
      transcript.filter((message) => message.role === "user").map((message) => message.text),
      ["alpha", "beta"],
    );
    const persisted = await getConversation(ownerId, conversation.id);
    assert.equal(persisted?.eveSessionId, "current-session");
    assert.notEqual(persisted?.status, "working");
  },
);

test(
  "deletes owner-scoped conversations and reassigns a deleted agent's history to General",
  { skip: !databaseEnabled },
  async (t) => {
    const suffix = `${process.pid}-${Date.now()}`;
    const ownerId = `integration-delete-${suffix}`;
    const otherOwnerId = `integration-delete-other-${suffix}`;
    const sql = neon(process.env.DATABASE_URL!);

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
    await recordAgentEvent({
      ownerId,
      agentId: specialist.id,
      conversationId: firstConversation.id,
      actorType: "human",
      actorId: ownerId,
      eventType: "message.user",
      payload: { message: "delete this conversation", requestId: "delete-first" },
    });
    await recordAgentEvent({
      ownerId,
      agentId: specialist.id,
      conversationId: secondConversation.id,
      actorType: "human",
      actorId: ownerId,
      eventType: "message.user",
      payload: { message: "delete with agent", requestId: "delete-second" },
    });

    const otherGeneral = await ensureDefaultAgent(otherOwnerId);
    const otherConversation = await createConversation(otherOwnerId, otherGeneral.id);
    await recordAgentEvent({
      ownerId: otherOwnerId,
      agentId: otherGeneral.id,
      conversationId: otherConversation.id,
      actorType: "human",
      actorId: otherOwnerId,
      eventType: "message.user",
      payload: { message: "must survive", requestId: "other-request" },
    });

    await assert.rejects(
      deleteConversation(otherOwnerId, firstConversation.id),
      /Conversation not found/,
    );
    await deleteConversation(ownerId, firstConversation.id);
    const firstCounts = await sql.query(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE owner_id = $1 AND id = $2) AS conversations,
         (SELECT count(*)::int FROM agent_events WHERE owner_id = $1 AND conversation_id = $2) AS events`,
      [ownerId, firstConversation.id],
    );
    assert.deepEqual(firstCounts[0], { conversations: 0, events: 0 });
    assert.ok(await getConversation(ownerId, secondConversation.id));

    await assert.rejects(deleteAgent(ownerId, general.id), /General agent cannot be deleted/);
    await assert.rejects(deleteAgent(otherOwnerId, specialist.id), /Agent not found/);
    await deleteAgent(ownerId, specialist.id);

    const specialistCounts = await sql.query(
      `SELECT
         (SELECT count(*)::int FROM agents WHERE owner_id = $1 AND id = $2) AS agents,
         (SELECT count(*)::int FROM conversations WHERE owner_id = $1 AND agent_id = $2) AS conversations,
         (SELECT count(*)::int FROM agent_events WHERE owner_id = $1 AND agent_id = $2) AS events`,
      [ownerId, specialist.id],
    );
    assert.deepEqual(specialistCounts[0], { agents: 0, conversations: 0, events: 1 });
    const reassigned = await getConversation(ownerId, secondConversation.id);
    assert.equal(reassigned?.agentId, general.id);
    assert.equal(reassigned?.agentName, general.name);
    assert.equal(reassigned?.eveSessionId, null);
    assert.equal(reassigned?.status, "failed");
    assert.deepEqual(
      (await listConversationMessages(ownerId, secondConversation.id)).map(
        ({ role, text, failed }) => ({ role, text, failed }),
      ),
      [{ role: "user", text: "delete with agent", failed: true }],
    );
    assert.ok(await getConversation(otherOwnerId, otherConversation.id));

    const otherEventRows = await sql.query(
      `SELECT count(*)::int AS count FROM agent_events
       WHERE owner_id = $1 AND conversation_id = $2`,
      [otherOwnerId, otherConversation.id],
    );
    assert.equal(otherEventRows[0]?.count, 1);
  },
);
