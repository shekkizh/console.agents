import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";
import { getAgent } from "@/lib/server/agent-store";
import {
  listConversationActivity as listMessageActivity,
  listConversationTranscript,
} from "@/lib/server/message-store";
import type {
  AgentMessage,
  AgentProfile,
  ConversationMessageActivity,
  ConversationProfile,
  ConversationStatus,
} from "@/lib/types";

interface ConversationRow {
  id: string;
  agent_id: string;
  agent_name: string;
  title: string;
  eve_session_id: string | null;
  runtime_version: number;
  status: ConversationStatus;
  created_at: string | Date;
  updated_at: string | Date;
}

function database() {
  return neon(requireDatabaseUrl());
}

const selectColumns = `
  c.id, c.agent_id, a.name AS agent_name,
  CASE WHEN c.title = 'New conversation' THEN COALESCE((
    SELECT left(regexp_replace(message.content, '[[:space:]]+', ' ', 'g'), 64)
    FROM conversation_messages message
    WHERE message.owner_id = c.owner_id
      AND message.conversation_id = c.id
      AND message.sender_type = 'human'
    ORDER BY message.created_at ASC
    LIMIT 1
  ), c.title) ELSE c.title END AS title,
  a.eve_session_id,
  c.runtime_version, c.status, c.created_at, c.updated_at
`;

function toConversation(row: ConversationRow): ConversationProfile {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    title: row.title,
    eveSessionId: row.eve_session_id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listConversations(ownerId: string): Promise<ConversationProfile[]> {
  const rows = await database().query(
    `SELECT ${selectColumns}
     FROM conversations c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.owner_id = $1 AND c.visibility = 'user'
     ORDER BY c.updated_at DESC, c.created_at DESC`,
    [ownerId],
  );
  return (rows as ConversationRow[]).map(toConversation);
}

export async function createConversation(
  ownerId: string,
  agentId: string,
): Promise<ConversationProfile> {
  const agent = await getAgent(ownerId, agentId);
  if (!agent) throw new Error("Agent not found");
  if (!agent.enabled) throw new Error("Agent is disabled");
  const id = `conversation-${crypto.randomUUID()}`;
  const rows = await database().query(
    `INSERT INTO conversations (id, owner_id, agent_id)
     VALUES ($1, $2, $3)
     RETURNING id, agent_id, $4::text AS agent_name, title, $5::text AS eve_session_id,
       runtime_version, status, created_at, updated_at`,
    [id, ownerId, agentId, agent.name, agent.eveSessionId],
  );
  return toConversation(rows[0] as ConversationRow);
}

export async function deleteConversation(ownerId: string, conversationId: string): Promise<void> {
  const rows = await database().query(
    `WITH target AS (
       DELETE FROM conversations
       WHERE owner_id = $1 AND id = $2
       RETURNING id
     ), deleted_events AS (
       DELETE FROM agent_events event
       USING target
       WHERE event.owner_id = $1 AND event.conversation_id = target.id
     )
     SELECT id FROM target`,
    [ownerId, conversationId],
  );
  if (!rows[0]) throw new Error("Conversation not found");
}

export interface ConversationStopTarget {
  agentId: string;
  eveSessionId: string;
}

export async function stopConversation(
  ownerId: string,
  conversationId: string,
): Promise<{
  conversation: ConversationProfile;
  stoppedDeliveryCount: number;
  targets: ConversationStopTarget[];
}> {
  const sql = database();
  const targetRows = await sql.query(
    `SELECT DISTINCT agent.id AS agent_id, agent.eve_session_id
     FROM conversation_messages message
     JOIN message_deliveries delivery
       ON delivery.owner_id = message.owner_id AND delivery.message_id = message.id
     JOIN agents agent
       ON agent.owner_id = message.owner_id AND agent.id = delivery.recipient_id
     WHERE message.owner_id = $1 AND message.conversation_id = $2
       AND delivery.recipient_type = 'agent'
       AND delivery.state = 'claimed'
       AND agent.eve_session_id IS NOT NULL`,
    [ownerId, conversationId],
  );
  const rows = await sql.query(
    `WITH target AS (
       SELECT id FROM conversations WHERE owner_id = $1 AND id = $2
     ), stopped AS (
       UPDATE message_deliveries delivery
       SET state = 'failed', error = 'Stopped by user', completed_at = now()
       FROM conversation_messages message, target
       WHERE delivery.owner_id = $1
         AND message.owner_id = delivery.owner_id
         AND message.id = delivery.message_id
         AND message.conversation_id = target.id
         AND delivery.recipient_type = 'agent'
         AND delivery.state IN ('queued', 'dispatched', 'claimed')
       RETURNING delivery.id
     ), updated AS (
       UPDATE conversations conversation
       SET status = CASE
           WHEN EXISTS (SELECT 1 FROM stopped) THEN 'failed'
           ELSE conversation.status
         END,
         updated_at = CASE
           WHEN EXISTS (SELECT 1 FROM stopped) THEN now()
           ELSE conversation.updated_at
         END
       FROM target
       WHERE conversation.owner_id = $1 AND conversation.id = target.id
       RETURNING conversation.id
     )
     SELECT id, (SELECT count(*)::int FROM stopped) AS stopped_count
     FROM updated`,
    [ownerId, conversationId],
  );
  if (!rows[0]) throw new Error("Conversation not found");
  const conversation = await getConversation(ownerId, conversationId);
  if (!conversation) throw new Error("Conversation not found");
  return {
    conversation,
    stoppedDeliveryCount: Number(
      (rows[0] as { stopped_count?: unknown }).stopped_count ?? 0,
    ),
    targets: targetRows.map((row) => ({
      agentId: String(row.agent_id),
      eveSessionId: String(row.eve_session_id),
    })),
  };
}

export async function ensureConversation(
  ownerId: string,
  agent: AgentProfile,
): Promise<ConversationProfile> {
  const existing = await listConversations(ownerId);
  return existing[0] ?? createConversation(ownerId, agent.id);
}

export async function getConversation(
  ownerId: string,
  conversationId: string,
): Promise<ConversationProfile | undefined> {
  const rows = await database().query(
    `SELECT ${selectColumns}
     FROM conversations c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.owner_id = $1 AND c.id = $2
     LIMIT 1`,
    [ownerId, conversationId],
  );
  return rows[0] ? toConversation(rows[0] as ConversationRow) : undefined;
}

export async function listConversationMessages(
  ownerId: string,
  conversationId: string,
  limit = 200,
): Promise<AgentMessage[]> {
  return listConversationTranscript(ownerId, conversationId, limit);
}

export async function listConversationActivity(
  ownerId: string,
  conversationId: string,
  limit = 300,
): Promise<ConversationMessageActivity[]> {
  return listMessageActivity(ownerId, conversationId, limit);
}
