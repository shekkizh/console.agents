import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { config, requireDatabaseUrl } from "@/lib/server/config";
import { CONVERSATION_RUNTIME_VERSION } from "@/lib/conversation-runtime";
import { projectAgentTranscript, type AgentEventRow } from "@/lib/agent-transcript";
import { fxMcpServersSchema, fxSkillsSchema } from "@/lib/agent-capabilities";
import type { AgentMessage, AgentProfile, FxAgentConfig, FxMcpServerConfig, FxSkillConfig } from "@/lib/types";

interface AgentRow {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
  fx_config: unknown;
  config_version: number;
  eve_session_id: string | null;
  created_by_agent_id: string | null;
  enabled: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AgentUpdate {
  name?: string;
  specialty?: string;
  instructions?: string;
  model?: string;
  maxSteps?: number;
  permissionMode?: "auto" | "yolo";
  skills?: FxSkillConfig[];
  mcpServers?: Record<string, FxMcpServerConfig>;
  enabled?: boolean;
}

function database() {
  return neon(requireDatabaseUrl());
}

export function defaultAgentId(ownerId: string): string {
  return `general-${createHash("sha256").update(ownerId).digest("hex").slice(0, 24)}`;
}

function normalizeFxConfig(value: unknown): FxAgentConfig {
  const configValue = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const permissionMode = configValue.permissionMode === "auto" ? "auto" : "yolo";
  const parsedSkills = fxSkillsSchema.safeParse(configValue.skills);
  const parsedMcpServers = fxMcpServersSchema.safeParse(configValue.mcpServers);
  return {
    model:
      typeof configValue.model === "string" && configValue.model.trim()
        ? configValue.model
        : config.defaultFxModel,
    maxSteps:
      typeof configValue.maxSteps === "number" && Number.isInteger(configValue.maxSteps)
        ? Math.min(128, Math.max(1, configValue.maxSteps))
        : 48,
    permissionMode,
    skills: parsedSkills.success ? parsedSkills.data : [],
    mcpServers: parsedMcpServers.success ? parsedMcpServers.data : {},
  };
}

function toAgent(row: AgentRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    instructions: row.instructions,
    fxConfig: normalizeFxConfig(row.fx_config),
    configVersion: row.config_version,
    eveSessionId: row.eve_session_id,
    createdByAgentId: row.created_by_agent_id,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const selectColumns = `
  id, name, specialty, instructions, fx_config, config_version,
  eve_session_id, created_by_agent_id, enabled, created_at, updated_at
`;

export async function ensureDefaultAgent(ownerId: string): Promise<AgentProfile> {
  const sql = database();
  const id = defaultAgentId(ownerId);
  const rows = await sql.query(
    `INSERT INTO agents (id, owner_id, name, specialty, instructions, fx_config)
     VALUES ($1, $2, 'General', 'Builds and coordinates persistent agents',
       'Take ownership of broad requests. Create specialized Console agents when durable specialization will help. Keep generated agents narrowly scoped and give them only the capabilities they need.',
       $3::jsonb)
     ON CONFLICT (owner_id, name) DO UPDATE SET owner_id = EXCLUDED.owner_id
     RETURNING ${selectColumns}`,
    [
      id,
      ownerId,
      JSON.stringify({ model: config.defaultFxModel, maxSteps: 48, permissionMode: "yolo", skills: [], mcpServers: {} }),
    ],
  );
  return toAgent(rows[0] as AgentRow);
}

export async function listAgents(ownerId: string): Promise<AgentProfile[]> {
  await ensureDefaultAgent(ownerId);
  const sql = database();
  const rows = await sql.query(
    `SELECT ${selectColumns} FROM agents WHERE owner_id = $1 ORDER BY created_at ASC`,
    [ownerId],
  );
  return (rows as AgentRow[]).map(toAgent);
}

export async function getAgent(ownerId: string, agentId: string): Promise<AgentProfile | undefined> {
  const sql = database();
  const rows = await sql.query(
    `SELECT ${selectColumns} FROM agents WHERE owner_id = $1 AND id = $2 LIMIT 1`,
    [ownerId, agentId],
  );
  return rows[0] ? toAgent(rows[0] as AgentRow) : undefined;
}

export async function findAgentByName(ownerId: string, name: string): Promise<AgentProfile | undefined> {
  const sql = database();
  const rows = await sql.query(
    `SELECT ${selectColumns} FROM agents WHERE owner_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [ownerId, name],
  );
  return rows[0] ? toAgent(rows[0] as AgentRow) : undefined;
}

export async function createAgent(
  ownerId: string,
  input: {
    name: string;
    specialty: string;
    instructions: string;
    model?: string;
    maxSteps?: number;
    permissionMode?: "auto" | "yolo";
    skills?: FxSkillConfig[];
    mcpServers?: Record<string, FxMcpServerConfig>;
    createdByAgentId?: string | null;
  },
): Promise<AgentProfile> {
  const sql = database();
  const id = `agent-${crypto.randomUUID()}`;
  const fxConfig: FxAgentConfig = {
    model: input.model ?? config.defaultFxModel,
    maxSteps: input.maxSteps ?? 48,
    permissionMode: input.permissionMode ?? "yolo",
    skills: input.skills ?? [],
    mcpServers: input.mcpServers ?? {},
  };
  const rows = await sql.query(
    `INSERT INTO agents
       (id, owner_id, name, specialty, instructions, fx_config, created_by_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${selectColumns}`,
    [
      id,
      ownerId,
      input.name,
      input.specialty,
      input.instructions,
      JSON.stringify(fxConfig),
      input.createdByAgentId ?? null,
    ],
  );
  await recordAgentEvent({
    ownerId,
    agentId: id,
    actorType: input.createdByAgentId ? "agent" : "human",
    actorId: input.createdByAgentId ?? ownerId,
    eventType: "agent.created",
    payload: { fxConfig },
  });
  return toAgent(rows[0] as AgentRow);
}

export async function deleteAgent(
  ownerId: string,
  agentId: string,
): Promise<{ reassignedConversationCount: number }> {
  if (agentId === defaultAgentId(ownerId)) {
    throw new Error("The General agent cannot be deleted");
  }
  const general = await ensureDefaultAgent(ownerId);
  const rows = await database().query(
    `WITH target AS (
       SELECT id FROM agents WHERE owner_id = $1 AND id = $2
     ), settled AS (
       INSERT INTO agent_events
         (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
       SELECT request.owner_id, $3, request.conversation_id, 'system', 'agent-deletion',
         'message.failed', jsonb_build_object(
           'requestId', request.payload->>'requestId',
           'diagnostic', 'The assigned agent was deleted. Retry this request with General.'
         )
       FROM agent_events request
       JOIN conversations conversation
         ON conversation.owner_id = request.owner_id
        AND conversation.id = request.conversation_id
       JOIN target ON target.id = conversation.agent_id
       WHERE request.owner_id = $1
         AND request.event_type = 'message.user'
         AND request.payload->>'requestId' IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_events response
           WHERE response.owner_id = request.owner_id
             AND response.conversation_id = request.conversation_id
             AND response.event_type IN ('message.assistant', 'message.failed')
             AND response.payload->>'requestId' = request.payload->>'requestId'
         )
       ON CONFLICT DO NOTHING
       RETURNING conversation_id
     ), moved AS (
       UPDATE conversations conversation SET
         agent_id = $3,
         eve_session_id = NULL,
         runtime_version = $4,
         status = CASE
           WHEN EXISTS (
             SELECT 1 FROM settled WHERE settled.conversation_id = conversation.id
           ) THEN 'failed'
           WHEN conversation.status = 'working' THEN 'ready'
           ELSE conversation.status
         END,
         updated_at = now()
       FROM target
       WHERE conversation.owner_id = $1 AND conversation.agent_id = target.id
       RETURNING conversation.id
     ), deleted_events AS (
       DELETE FROM agent_events event
       USING target
       WHERE event.owner_id = $1 AND event.agent_id = target.id
         AND event.conversation_id IS NULL
       RETURNING event.id
     ), deleted_agent AS (
       DELETE FROM agents agent
       USING target
       WHERE agent.owner_id = $1 AND agent.id = target.id
         AND (SELECT count(*) FROM settled) >= 0
         AND (SELECT count(*) FROM moved) >= 0
         AND (SELECT count(*) FROM deleted_events) >= 0
       RETURNING agent.id
     )
     SELECT id, (SELECT count(*)::int FROM moved) AS reassigned_count
     FROM deleted_agent`,
    [ownerId, agentId, general.id, CONVERSATION_RUNTIME_VERSION],
  );
  if (!rows[0]) throw new Error("Agent not found");
  return {
    reassignedConversationCount: Number(
      (rows[0] as { reassigned_count?: unknown }).reassigned_count ?? 0,
    ),
  };
}

export async function updateAgent(
  ownerId: string,
  agentId: string,
  input: AgentUpdate,
  actor: { type: "human" | "agent" | "eve"; id: string },
): Promise<AgentProfile> {
  const existing = await getAgent(ownerId, agentId);
  if (!existing) throw new Error("Agent not found");
  const fxConfig: FxAgentConfig = {
    model: input.model ?? existing.fxConfig.model,
    maxSteps: input.maxSteps ?? existing.fxConfig.maxSteps,
    permissionMode: input.permissionMode ?? existing.fxConfig.permissionMode,
    skills: input.skills ?? existing.fxConfig.skills,
    mcpServers: input.mcpServers ?? existing.fxConfig.mcpServers,
  };
  const sql = database();
  const rows = await sql.query(
    `UPDATE agents SET
       name = COALESCE($3, name),
       specialty = COALESCE($4, specialty),
       instructions = COALESCE($5, instructions),
       fx_config = $6::jsonb,
       enabled = COALESCE($7, enabled),
       config_version = config_version + 1,
       updated_at = now()
     WHERE owner_id = $1 AND id = $2
     RETURNING ${selectColumns}`,
    [
      ownerId,
      agentId,
      input.name ?? null,
      input.specialty ?? null,
      input.instructions ?? null,
      JSON.stringify(fxConfig),
      input.enabled ?? null,
    ],
  );
  await recordAgentEvent({
    ownerId,
    agentId,
    actorType: actor.type,
    actorId: actor.id,
    eventType: "agent.config.updated",
    payload: input,
  });
  return toAgent(rows[0] as AgentRow);
}

export async function claimAgentSession(
  ownerId: string,
  agentId: string,
  eveSessionId: string,
): Promise<AgentProfile> {
  const sql = database();
  const rows = await sql.query(
    `UPDATE agents SET
       eve_session_id = COALESCE(eve_session_id, $3),
       updated_at = CASE WHEN eve_session_id IS NULL THEN now() ELSE updated_at END
     WHERE owner_id = $1 AND id = $2 AND enabled = true
       AND (eve_session_id IS NULL OR eve_session_id = $3)
     RETURNING ${selectColumns}`,
    [ownerId, agentId, eveSessionId],
  );
  if (!rows[0]) {
    const existing = await getAgent(ownerId, agentId);
    if (!existing) throw new Error("Agent not found");
    if (!existing.enabled) throw new Error("Agent is disabled");
    throw new Error("This agent is bound to a different durable Eve session");
  }
  return toAgent(rows[0] as AgentRow);
}

export async function resetAgentSession(ownerId: string, agentId: string): Promise<AgentProfile> {
  const sql = database();
  const rows = await sql.query(
    `UPDATE agents SET eve_session_id = NULL, updated_at = now()
     WHERE owner_id = $1 AND id = $2
     RETURNING ${selectColumns}`,
    [ownerId, agentId],
  );
  if (!rows[0]) throw new Error("Agent not found");
  await recordAgentEvent({
    ownerId,
    agentId,
    actorType: "human",
    actorId: ownerId,
    eventType: "agent.session.reset",
  });
  return toAgent(rows[0] as AgentRow);
}

export async function listAgentMessages(
  ownerId: string,
  agentId: string,
  limit = 200,
): Promise<AgentMessage[]> {
  const sql = database();
  const rows = await sql.query(
    `SELECT id, event_type, payload, created_at FROM (
       SELECT id, event_type, payload, created_at
       FROM agent_events
       WHERE owner_id = $1 AND agent_id = $2
         AND event_type IN ('message.user', 'message.assistant', 'message.failed')
         AND created_at > COALESCE((
           SELECT MAX(created_at)
           FROM agent_events
           WHERE owner_id = $1 AND agent_id = $2
             AND event_type = 'agent.session.reset'
         ), '-infinity'::timestamptz)
       ORDER BY created_at DESC
       LIMIT $3
     ) recent
     ORDER BY created_at ASC`,
    [ownerId, agentId, Math.min(500, Math.max(1, limit))],
  );
  return projectAgentTranscript(rows as AgentEventRow[]);
}

export async function recordAgentEvent(input: {
  ownerId: string;
  agentId: string;
  conversationId?: string;
  actorType: "human" | "agent" | "eve" | "system";
  actorId: string;
  eventType: string;
  payload?: unknown;
}): Promise<void> {
  const sql = database();
  const values = [
    input.ownerId,
    input.agentId,
    input.conversationId ?? null,
    input.actorType,
    input.actorId,
    input.eventType,
    JSON.stringify(input.payload ?? {}),
  ];
  const requestId =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>).requestId
      : undefined;
  const isTerminalMessage =
    input.conversationId &&
    typeof requestId === "string" &&
    (input.eventType === "message.assistant" || input.eventType === "message.failed");
  const inserted = isTerminalMessage
    ? await sql.query(
        `INSERT INTO agent_events
           (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
         SELECT $1, $2, $3, $4, $5, $6, $7::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_events
           WHERE owner_id = $1 AND conversation_id = $3
             AND event_type IN ('message.assistant', 'message.failed')
             AND payload->>'requestId' = $8
         )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [...values, requestId],
      )
    : await sql.query(
        `INSERT INTO agent_events
           (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        values,
      );
  if (!inserted[0]) return;
  if (!input.conversationId) return;

  const payload =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : {};
  if (input.eventType === "message.user") {
    const message = typeof payload.message === "string" ? payload.message : "";
    const title = message.replace(/\s+/g, " ").trim().slice(0, 64) || "New conversation";
    await sql.query(
      `UPDATE conversations SET
         title = CASE WHEN title = 'New conversation' THEN $3 ELSE title END,
         status = 'working',
         updated_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [input.ownerId, input.conversationId, title],
    );
  } else if (input.eventType === "message.assistant") {
    await sql.query(
      `UPDATE conversations SET
         status = CASE WHEN EXISTS (
           SELECT 1
           FROM agent_events request
           WHERE request.owner_id = $1
             AND request.conversation_id = $2
             AND request.event_type = 'message.user'
             AND NOT EXISTS (
               SELECT 1
               FROM agent_events response
               WHERE response.owner_id = request.owner_id
                 AND response.conversation_id = request.conversation_id
                 AND response.event_type IN ('message.assistant', 'message.failed')
                 AND response.payload->>'requestId' = request.payload->>'requestId'
             )
         ) THEN 'working' ELSE 'completed' END,
         updated_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [input.ownerId, input.conversationId],
    );
  } else if (input.eventType === "message.failed") {
    await sql.query(
      `UPDATE conversations SET
         status = CASE WHEN EXISTS (
           SELECT 1
           FROM agent_events request
           WHERE request.owner_id = $1
             AND request.conversation_id = $2
             AND request.event_type = 'message.user'
             AND NOT EXISTS (
               SELECT 1
               FROM agent_events response
               WHERE response.owner_id = request.owner_id
                 AND response.conversation_id = request.conversation_id
                 AND response.event_type IN ('message.assistant', 'message.failed')
                 AND response.payload->>'requestId' = request.payload->>'requestId'
             )
         ) THEN 'working' ELSE 'failed' END,
         updated_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [input.ownerId, input.conversationId],
    );
  }
}

export async function recordIncomingAgentMessage(input: {
  ownerId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  message: string;
  eveSessionId?: string;
}): Promise<void> {
  const sql = database();
  const rows = await sql.query(
    `WITH target AS (
       UPDATE conversations SET
         eve_session_id = CASE
           WHEN $6::text IS NULL AND runtime_version <> $7 THEN NULL
           WHEN $6::text IS NOT NULL THEN COALESCE(eve_session_id, $6)
           ELSE eve_session_id
         END,
         runtime_version = $7
       WHERE owner_id = $1 AND id = $2 AND agent_id = $3
         AND (
           ($6::text IS NULL AND (runtime_version <> $7 OR eve_session_id IS NULL))
           OR
           ($6::text IS NOT NULL AND runtime_version = $7
             AND (eve_session_id IS NULL OR eve_session_id = $6))
         )
       RETURNING 1
     ), inserted AS (
       INSERT INTO agent_events
         (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
       SELECT $1, $3, $2, 'human', $1, 'message.user',
         jsonb_build_object('message', $5::text, 'requestId', $4::text)
       FROM target
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_events
         WHERE owner_id = $1 AND conversation_id = $2
           AND event_type = 'message.user'
           AND payload->>'requestId' = $4
       )
       ON CONFLICT DO NOTHING
       RETURNING 1
     ), updated AS (
       UPDATE conversations SET
         title = CASE
           WHEN title = 'New conversation' THEN left(regexp_replace($5, '\\s+', ' ', 'g'), 64)
           ELSE title
         END,
         status = 'working',
         updated_at = now()
       WHERE owner_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM inserted)
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM target) AS valid`,
    [
      input.ownerId,
      input.conversationId,
      input.agentId,
      input.messageId,
      input.message,
      input.eveSessionId ?? null,
      CONVERSATION_RUNTIME_VERSION,
    ],
  );
  if (!(rows[0] as { valid?: boolean } | undefined)?.valid) {
    throw new Error("Conversation not found");
  }
}

export interface PendingAgentMessage {
  message: string;
  requestId: string;
}

export async function nextPendingAgentMessage(input: {
  ownerId: string;
  agentId: string;
  conversationId: string;
}): Promise<PendingAgentMessage | undefined> {
  const rows = await database().query(
    `SELECT request.payload->>'message' AS message,
            request.payload->>'requestId' AS request_id
     FROM agent_events request
     WHERE request.owner_id = $1
       AND request.agent_id = $2
       AND request.conversation_id = $3
       AND request.event_type = 'message.user'
       AND request.payload->>'requestId' IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM agent_events response
         WHERE response.owner_id = request.owner_id
           AND response.agent_id = request.agent_id
           AND response.conversation_id = request.conversation_id
           AND response.event_type IN ('message.assistant', 'message.failed')
           AND response.payload->>'requestId' = request.payload->>'requestId'
       )
     ORDER BY request.created_at ASC, request.id ASC
     LIMIT 1`,
    [input.ownerId, input.agentId, input.conversationId],
  );
  const row = rows[0] as { message?: unknown; request_id?: unknown } | undefined;
  if (typeof row?.message !== "string" || typeof row.request_id !== "string") return undefined;
  return { message: row.message, requestId: row.request_id };
}
