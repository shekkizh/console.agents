import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { config, requireDatabaseUrl } from "@/lib/server/config";
import { fxMcpServersSchema, fxNetworkAllowlistSchema, fxSkillsSchema } from "@/lib/agent-capabilities";
import type { AgentProfile, FxAgentConfig, FxMcpServerConfig, FxNetworkAccess, FxSkillConfig } from "@/lib/types";

interface AgentRow {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
  fx_config: unknown;
  config_version: number;
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
  networkAccess?: FxNetworkAccess;
  networkAllowlist?: string[];
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
  const networkAccess =
    configValue.networkAccess === "none" || configValue.networkAccess === "allowlist"
      ? configValue.networkAccess
      : "full";
  const parsedNetworkAllowlist = fxNetworkAllowlistSchema.safeParse(configValue.networkAllowlist);
  const parsedSkills = fxSkillsSchema.safeParse(configValue.skills);
  const parsedMcpServers = fxMcpServersSchema.safeParse(configValue.mcpServers);
  return {
    model:
      typeof configValue.model === "string" && configValue.model.trim()
        ? configValue.model
        : config.defaultFxModel,
    networkAccess,
    networkAllowlist: parsedNetworkAllowlist.success ? parsedNetworkAllowlist.data : [],
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
    createdByAgentId: row.created_by_agent_id,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const selectColumns = `
  id, name, specialty, instructions, fx_config, config_version,
  created_by_agent_id, enabled, created_at, updated_at
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
      JSON.stringify({ model: config.defaultFxModel, networkAccess: "full", networkAllowlist: [], skills: [], mcpServers: {} }),
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
    networkAccess?: FxNetworkAccess;
    networkAllowlist?: string[];
    skills?: FxSkillConfig[];
    mcpServers?: Record<string, FxMcpServerConfig>;
    createdByAgentId?: string | null;
  },
): Promise<AgentProfile> {
  const sql = database();
  const id = `agent-${crypto.randomUUID()}`;
  const fxConfig: FxAgentConfig = {
    model: input.model ?? config.defaultFxModel,
    networkAccess: input.networkAccess ?? "full",
    networkAllowlist: input.networkAllowlist ?? [],
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
       UPDATE message_deliveries delivery
       SET state = 'failed',
           error = 'The recipient agent was deleted.',
           completed_at = now()
       FROM conversation_messages message, target
       WHERE delivery.owner_id = $1
         AND message.owner_id = delivery.owner_id
         AND message.id = delivery.message_id
         AND delivery.recipient_type = 'agent'
         AND delivery.recipient_id = target.id
         AND delivery.state IN ('queued', 'claimed', 'running')
       RETURNING message.conversation_id
     ), moved AS (
       UPDATE conversations conversation SET
         agent_id = $3,
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
    [ownerId, agentId, general.id],
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
  actor: { type: "human" | "agent"; id: string },
): Promise<AgentProfile> {
  const existing = await getAgent(ownerId, agentId);
  if (!existing) throw new Error("Agent not found");
  const fxConfig: FxAgentConfig = {
    model: input.model ?? existing.fxConfig.model,
    networkAccess: input.networkAccess ?? existing.fxConfig.networkAccess,
    networkAllowlist: input.networkAllowlist ?? existing.fxConfig.networkAllowlist,
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

export async function recordAgentEvent(input: {
  ownerId: string;
  agentId: string;
  conversationId?: string;
  actorType: "human" | "agent" | "system";
  actorId: string;
  eventType: string;
  payload?: unknown;
}): Promise<void> {
  await database().query(
    `INSERT INTO agent_events
       (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.ownerId,
      input.agentId,
      input.conversationId ?? null,
      input.actorType,
      input.actorId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}
