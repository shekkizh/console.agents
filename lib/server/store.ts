import "server-only";

import { neon } from "@neondatabase/serverless";
import { GENERAL_AGENT_ID, generalAgent } from "@/lib/general-agent";
import { humanParticipant, listChannels } from "@/lib/server/channel-store";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentProfile, WorkspaceSnapshot } from "@/lib/types";

const agentColors = ["#c8f169", "#8bb8ff", "#f0ae88", "#d7a8ff", "#77d7c2", "#ffd166"];

type AgentRow = {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
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
  const [agentRows, channels] = await Promise.all([
    sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId} ORDER BY created_at ASC`,
    listChannels(ownerId),
  ]);
  return { agents: [generalAgent, ...(agentRows as AgentRow[]).map(toAgentProfile)], channels, currentUser: humanParticipant(ownerId) };
}

export async function listAgents(ownerId: string): Promise<AgentProfile[]> {
  const sql = database();
  const rows = await sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId} ORDER BY created_at ASC`;
  return [generalAgent, ...(rows as AgentRow[]).map(toAgentProfile)];
}

export async function findAgentByName(ownerId: string, name: string): Promise<AgentProfile | undefined> {
  const sql = database();
  const rows = await sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId} AND lower(name) = lower(${name}) LIMIT 1`;
  return rows[0] ? toAgentProfile(rows[0] as AgentRow) : undefined;
}

export async function getAgent(ownerId: string, agentId: string): Promise<AgentProfile | undefined> {
  if (agentId === GENERAL_AGENT_ID) return generalAgent;
  const sql = database();
  const rows = await sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId} AND id = ${agentId} LIMIT 1`;
  return rows[0] ? toAgentProfile(rows[0] as AgentRow) : undefined;
}

export async function agentNameExists(ownerId: string, name: string): Promise<boolean> {
  return Boolean(await findAgentByName(ownerId, name));
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

export async function updateAgent(ownerId: string, agentId: string, input: { name?: string; specialty?: string; instructions?: string }): Promise<AgentProfile> {
  if (agentId === GENERAL_AGENT_ID) throw new Error("General's profile is built in; update its durable .agents/AGENTS.md file instead.");
  const sql = database();
  const rows = await sql`
    UPDATE agents SET
      name = COALESCE(${input.name ?? null}, name),
      specialty = COALESCE(${input.specialty ?? null}, specialty),
      instructions = COALESCE(${input.instructions ?? null}, instructions)
    WHERE owner_id = ${ownerId} AND id = ${agentId}
    RETURNING id, name, specialty, instructions
  `;
  if (!rows.length) throw new Error("Agent not found");
  return toAgentProfile(rows[0] as AgentRow);
}
