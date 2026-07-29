import "server-only";

import { neon } from "@neondatabase/serverless";
import { agentCatalog } from "@/lib/agent-catalog";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentTask, Message, WorkspaceSnapshot } from "@/lib/types";

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
  messages: Message[] | null;
  artifacts: AgentTask["artifacts"] | null;
};

function database() {
  return neon(requireDatabaseUrl());
}

export async function getWorkspace(ownerId: string): Promise<WorkspaceSnapshot> {
  const sql = database();
  const rows = (await sql`
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
  `) as TaskRow[];

  const tasks = rows.map((row) => ({
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
    messages: (row.messages ?? []).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    artifacts: row.artifacts ?? [],
  }));

  return { agents: agentCatalog, tasks };
}

export async function createTask(ownerId: string, input: { title: string; summary: string; agentId: string; repositoryUrl?: string }): Promise<AgentTask> {
  if (!agentCatalog.some((agent) => agent.id === input.agentId)) throw new Error("Unknown agent");
  const sql = database();
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
  const rows = await sql`SELECT agent_id FROM tasks WHERE id = ${taskId} AND owner_id = ${ownerId} LIMIT 1`;
  if (!rows.length) throw new Error("Task not found");
  const author = agentCatalog.find((agent) => agent.id === rows[0].agent_id)?.name ?? "Agent";
  await sql.transaction([
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, content, steps, created_at)
        VALUES (${crypto.randomUUID()}, ${ownerId}, ${taskId}, 'agent', ${author}, ${result.output}, ${JSON.stringify(result.steps ?? [])}, ${now})`,
    sql`UPDATE tasks SET status = ${result.status}, interaction_id = ${result.interactionId}, updated_at = ${now}
        WHERE id = ${taskId} AND owner_id = ${ownerId}`,
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
