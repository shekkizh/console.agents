import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";
import { getAgent } from "@/lib/server/agent-store";
import {
  CONVERSATION_RUNTIME_VERSION,
  visibleConversationSessionId,
} from "@/lib/conversation-runtime";
import { projectAgentTranscript, type AgentEventRow } from "@/lib/agent-transcript";
import type { AgentMessage, AgentProfile, ConversationProfile, ConversationStatus } from "@/lib/types";

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
    SELECT left(regexp_replace(event.payload->>'message', '[[:space:]]+', ' ', 'g'), 64)
    FROM agent_events event
    WHERE event.owner_id = c.owner_id
      AND event.conversation_id = c.id
      AND event.event_type = 'message.user'
    ORDER BY event.created_at ASC
    LIMIT 1
  ), c.title) ELSE c.title END AS title,
  c.eve_session_id,
  c.runtime_version, c.status, c.created_at, c.updated_at
`;

function toConversation(row: ConversationRow): ConversationProfile {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    title: row.title,
    eveSessionId: visibleConversationSessionId(row.runtime_version, row.eve_session_id),
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
     WHERE c.owner_id = $1
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
     RETURNING id, agent_id, $4::text AS agent_name, title, eve_session_id,
       runtime_version, status, created_at, updated_at`,
    [id, ownerId, agentId, agent.name],
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

export async function claimConversationSession(input: {
  ownerId: string;
  conversationId: string;
  agentId: string;
  eveSessionId: string;
}): Promise<{ agent: AgentProfile; conversation: ConversationProfile }> {
  const rows = await database().query(
    `UPDATE conversations c SET
       eve_session_id = CASE
         WHEN c.runtime_version = $5 THEN COALESCE(c.eve_session_id, $4)
         ELSE $4
       END,
       runtime_version = $5,
       updated_at = CASE
         WHEN c.eve_session_id IS NULL OR c.runtime_version <> $5 THEN now()
         ELSE c.updated_at
       END
     FROM agents a
     WHERE c.owner_id = $1 AND c.id = $2 AND c.agent_id = $3
       AND a.id = c.agent_id AND a.owner_id = c.owner_id AND a.enabled = true
       AND (
         c.runtime_version <> $5 OR c.eve_session_id IS NULL OR c.eve_session_id = $4
       )
     RETURNING c.id, c.agent_id, a.name AS agent_name, c.title, c.eve_session_id,
       c.runtime_version, c.status, c.created_at, c.updated_at`,
    [
      input.ownerId,
      input.conversationId,
      input.agentId,
      input.eveSessionId,
      CONVERSATION_RUNTIME_VERSION,
    ],
  );
  if (!rows[0]) throw new Error("Conversation is unavailable or bound to another Eve session");
  const agent = await getAgent(input.ownerId, input.agentId);
  if (!agent) throw new Error("Agent not found");
  return { agent, conversation: toConversation(rows[0] as ConversationRow) };
}

export async function listConversationMessages(
  ownerId: string,
  conversationId: string,
  limit = 200,
): Promise<AgentMessage[]> {
  const rows = await database().query(
    `SELECT id, event_type, payload, created_at FROM (
       SELECT id, event_type, payload, created_at
       FROM agent_events
       WHERE owner_id = $1 AND conversation_id = $2
         AND event_type IN ('message.user', 'message.assistant', 'message.failed')
       ORDER BY created_at DESC
       LIMIT $3
     ) recent
     ORDER BY created_at ASC`,
    [ownerId, conversationId, Math.min(500, Math.max(1, limit))],
  );
  return projectAgentTranscript(rows as AgentEventRow[]);
}
