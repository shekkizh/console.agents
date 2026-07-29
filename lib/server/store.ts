import "server-only";

import { neon } from "@neondatabase/serverless";
import { GENERAL_AGENT_ID, generalAgent } from "@/lib/general-agent";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentProfile, AgentTask, Message, WorkspaceSnapshot } from "@/lib/types";

const agentColors = ["#c8f169", "#8bb8ff", "#f0ae88", "#d7a8ff", "#77d7c2", "#ffd166"];

type AgentRow = {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
};

type TaskRow = {
  id: string;
  title: string;
  summary: string;
  status: AgentTask["status"];
  priority: AgentTask["priority"];
  agent_id: string;
  created_at: string;
  updated_at: string;
  interaction_id: string | null;
  environment_id: string | null;
  repository_url: string | null;
  parent_task_id: string | null;
  messages: Message[] | null;
  artifacts: AgentTask["artifacts"] | null;
};

function database() {
  return neon(requireDatabaseUrl());
}

function agentInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0]}` : words[0]?.slice(0, 2) ?? "AI").toUpperCase();
}

function agentColor(id: string) {
  const hash = Array.from(id).reduce((total, character) => total + character.charCodeAt(0), 0);
  return agentColors[hash % agentColors.length];
}

function toAgentProfile(row: AgentRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    initials: agentInitials(row.name),
    specialty: row.specialty,
    description: row.instructions || row.specialty,
    instructions: row.instructions,
    status: "ready",
    color: agentColor(row.id),
  };
}

export async function getWorkspace(ownerId: string): Promise<WorkspaceSnapshot> {
  const sql = database();
  const [agentRows, taskRows] = await Promise.all([
    sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId} ORDER BY created_at ASC`,
    sql`
    SELECT t.*,
      COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', m.id, 'role', m.role, 'author', m.author, 'content', m.content,
        'createdAt', m.created_at, 'steps', m.steps
      )) FILTER (WHERE m.id IS NOT NULL), '[]') AS messages,
      COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', a.id, 'name', a.name, 'kind', a.kind, 'size', a.size, 'url', a.url
      )) FILTER (WHERE a.id IS NOT NULL), '[]') AS artifacts
    FROM tasks t
    LEFT JOIN messages m ON m.task_id = t.id AND m.owner_id = t.owner_id
    LEFT JOIN artifacts a ON a.task_id = t.id AND a.owner_id = t.owner_id
    WHERE t.owner_id = ${ownerId}
    GROUP BY t.id
    ORDER BY t.updated_at DESC
  `,
  ]);

  const tasks = (taskRows as TaskRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    priority: row.priority,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    interactionId: row.interaction_id ?? undefined,
    environmentId: row.environment_id ?? undefined,
    repositoryUrl: row.repository_url ?? undefined,
    parentTaskId: row.parent_task_id ?? undefined,
    messages: (row.messages ?? []).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    artifacts: row.artifacts ?? [],
  }));

  return { agents: [generalAgent, ...(agentRows as AgentRow[]).map(toAgentProfile)], tasks };
}

export async function agentNameExists(ownerId: string, name: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`SELECT id FROM agents WHERE owner_id = ${ownerId} AND lower(name) = lower(${name}) LIMIT 1`;
  return rows.length > 0;
}

export async function createAgent(ownerId: string, id: string, input: { name: string; specialty: string; instructions: string }): Promise<AgentProfile> {
  const sql = database();
  const rows = await sql`
    INSERT INTO agents (id, owner_id, name, specialty, instructions)
    VALUES (${id}, ${ownerId}, ${input.name}, ${input.specialty}, ${input.instructions})
    RETURNING id, name, specialty, instructions
  `;
  return toAgentProfile(rows[0] as AgentRow);
}

export async function getTaskAgent(ownerId: string, taskId: string): Promise<AgentProfile | undefined> {
  const sql = database();
  const rows = await sql`
    SELECT t.agent_id, a.id, a.name, a.specialty, a.instructions
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id AND a.owner_id = t.owner_id
    WHERE t.id = ${taskId} AND t.owner_id = ${ownerId}
    LIMIT 1
  `;
  if (rows[0]?.agent_id === GENERAL_AGENT_ID) return generalAgent;
  return rows[0] ? toAgentProfile(rows[0] as AgentRow) : undefined;
}

export async function createTask(ownerId: string, input: { title: string; summary: string; agentId: string; repositoryUrl?: string }): Promise<AgentTask> {
  const sql = database();
  if (input.agentId !== GENERAL_AGENT_ID) {
    const agentRows = await sql`SELECT id FROM agents WHERE id = ${input.agentId} AND owner_id = ${ownerId} LIMIT 1`;
    if (!agentRows.length) throw new Error("Choose one of your agents");
  }
  const now = new Date().toISOString();
  const task: AgentTask = {
    id: crypto.randomUUID(), title: input.title, summary: input.summary, status: "queued", priority: "normal",
    agentId: input.agentId, createdAt: now, updatedAt: now, artifacts: [], repositoryUrl: input.repositoryUrl,
    messages: [{ id: crypto.randomUUID(), role: "user", author: "You", content: input.summary, createdAt: now }],
  };

  await sql.transaction([
    sql`INSERT INTO tasks (id, owner_id, title, summary, status, priority, agent_id, repository_url, created_at, updated_at)
        VALUES (${task.id}, ${ownerId}, ${task.title}, ${task.summary}, ${task.status}, ${task.priority}, ${task.agentId}, ${task.repositoryUrl ?? null}, ${now}, ${now})`,
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, created_at)
        VALUES (${task.messages[0].id}, ${ownerId}, ${task.id}, 'user', 'You', ${input.summary}, ${now})`,
  ]);
  return task;
}

const delegationMarkerPrefix = "delegation-call:";

async function stableUuid(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function findDelegatedTask(ownerId: string, parentTaskId: string, parentInteractionId: string, callId: string): Promise<AgentTask | undefined> {
  const sql = database();
  const marker = `${delegationMarkerPrefix}${parentInteractionId}:${callId}`;
  const rows = await sql`
    SELECT t.id
    FROM tasks t
    JOIN messages m ON m.task_id = t.id AND m.owner_id = t.owner_id
    WHERE t.owner_id = ${ownerId} AND t.parent_task_id = ${parentTaskId}
      AND m.role = 'system' AND m.content = ${marker}
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === rows[0].id);
}

export async function createDelegatedTask(ownerId: string, input: {
  parentTaskId: string;
  parentInteractionId: string;
  callId: string;
  title: string;
  brief: string;
  repositoryUrl?: string;
}): Promise<AgentTask> {
  const existing = await findDelegatedTask(ownerId, input.parentTaskId, input.parentInteractionId, input.callId);
  if (existing) return existing;

  const sql = database();
  const now = new Date().toISOString();
  const marker = `${delegationMarkerPrefix}${input.parentInteractionId}:${input.callId}`;
  const taskId = await stableUuid(`${ownerId}:${input.parentTaskId}:${marker}`);
  const userMessageId = await stableUuid(`${taskId}:user`);
  const markerMessageId = await stableUuid(`${taskId}:marker`);
  await sql.transaction([
    sql`INSERT INTO tasks (id, owner_id, title, summary, status, priority, agent_id, repository_url, parent_task_id, created_at, updated_at)
        VALUES (${taskId}, ${ownerId}, ${input.title}, ${input.brief}, 'queued', 'normal', ${GENERAL_AGENT_ID}, ${input.repositoryUrl ?? null}, ${input.parentTaskId}, ${now}, ${now})
        ON CONFLICT (id) DO NOTHING`,
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, created_at)
        VALUES (${markerMessageId}, ${ownerId}, ${taskId}, 'system', 'Console', ${marker}, ${now})
        ON CONFLICT (id) DO NOTHING`,
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, created_at)
        VALUES (${userMessageId}, ${ownerId}, ${taskId}, 'user', 'General', ${input.brief}, ${now})
        ON CONFLICT (id) DO NOTHING`,
  ]);
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === taskId)!;
}

export async function claimDelegatedTaskStart(ownerId: string, taskId: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`
    UPDATE tasks SET status = 'running', updated_at = ${new Date().toISOString()}
    WHERE id = ${taskId} AND owner_id = ${ownerId} AND status = 'queued' AND interaction_id IS NULL
    RETURNING id
  `;
  return rows.length === 1;
}

export async function appendUserMessage(ownerId: string, taskId: string, content: string): Promise<AgentTask> {
  const sql = database();
  const now = new Date().toISOString();
  const message: Message = { id: crypto.randomUUID(), role: "user", author: "You", content, createdAt: now };
  const rows = await sql`SELECT id FROM tasks WHERE id = ${taskId} AND owner_id = ${ownerId} LIMIT 1`;
  if (!rows.length) throw new Error("Task not found");
  await sql.transaction([
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, created_at)
        VALUES (${message.id}, ${ownerId}, ${taskId}, 'user', 'You', ${content}, ${now})`,
    sql`UPDATE tasks SET status = 'running', updated_at = ${now} WHERE id = ${taskId} AND owner_id = ${ownerId}`,
  ]);
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === taskId)!;
}

export async function completeRun(ownerId: string, taskId: string, result: { interactionId: string; output: string; steps: Message["steps"]; status: "completed" | "running" | "failed" }): Promise<AgentTask> {
  const sql = database();
  const now = new Date().toISOString();
  const rows = await sql`
    SELECT t.agent_id, a.name AS agent_name
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id AND a.owner_id = t.owner_id
    WHERE t.id = ${taskId} AND t.owner_id = ${ownerId}
    LIMIT 1
  `;
  if (!rows.length) throw new Error("Task not found");
  const author = rows[0].agent_id === GENERAL_AGENT_ID ? generalAgent.name : String(rows[0].agent_name ?? "Agent");
  await sql.transaction([
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, steps, created_at)
        VALUES (${crypto.randomUUID()}, ${ownerId}, ${taskId}, 'agent', ${author}, ${result.output}, ${JSON.stringify(result.steps ?? [])}, ${now})`,
    sql`UPDATE tasks SET status = ${result.status}, interaction_id = ${result.interactionId}, updated_at = ${now}
        WHERE id = ${taskId} AND owner_id = ${ownerId}`,
  ]);
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === taskId)!;
}

export async function failRun(ownerId: string, taskId: string, output: string): Promise<AgentTask> {
  const sql = database();
  const now = new Date().toISOString();
  const rows = await sql`
    SELECT t.agent_id, a.name AS agent_name
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id AND a.owner_id = t.owner_id
    WHERE t.id = ${taskId} AND t.owner_id = ${ownerId}
    LIMIT 1
  `;
  if (!rows.length) throw new Error("Task not found");
  const author = rows[0].agent_id === GENERAL_AGENT_ID ? generalAgent.name : String(rows[0].agent_name ?? "Agent");
  await sql.transaction([
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, created_at)
        VALUES (${crypto.randomUUID()}, ${ownerId}, ${taskId}, 'agent', ${author}, ${output}, ${now})`,
    sql`UPDATE tasks SET status = 'failed', updated_at = ${now} WHERE id = ${taskId} AND owner_id = ${ownerId}`,
  ]);
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === taskId)!;
}

export async function markRunStarted(ownerId: string, taskId: string, result: { interactionId: string; environmentId?: string }): Promise<AgentTask> {
  const sql = database();
  const now = new Date().toISOString();
  const rows = await sql`UPDATE tasks SET status = 'running', interaction_id = ${result.interactionId}, environment_id = COALESCE(${result.environmentId ?? null}, environment_id), updated_at = ${now}
    WHERE id = ${taskId} AND owner_id = ${ownerId} RETURNING id`;
  if (!rows.length) throw new Error("Task not found");
  return (await getWorkspace(ownerId)).tasks.find((task) => task.id === taskId)!;
}
