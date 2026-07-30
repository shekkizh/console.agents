import "server-only";

import { neon } from "@neondatabase/serverless";
import { orderChannelMessages, resolveDeliveryRecipients } from "@/lib/channel-model";
import { GENERAL_AGENT_ID, generalAgent } from "@/lib/general-agent";
import { requireDatabaseUrl } from "@/lib/server/config";
import type {
  AgentProfile,
  Artifact,
  Channel,
  ChannelMessage,
  ChannelParticipant,
  CreateChatInput,
  MessageDelivery,
  ParticipantType,
  RunStep,
} from "@/lib/types";

const agentColors = ["#c8f169", "#8bb8ff", "#f0ae88", "#d7a8ff", "#77d7c2", "#ffd166"];
let schemaPromise: Promise<void> | undefined;

function database() { return neon(requireDatabaseUrl()); }

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0]}` : words[0]?.slice(0, 2) ?? "AI").toUpperCase();
}

function color(id: string) {
  const hash = Array.from(id).reduce((total, character) => total + character.charCodeAt(0), 0);
  return agentColors[hash % agentColors.length];
}

export function humanParticipant(ownerId: string): ChannelParticipant {
  return { id: `human:${ownerId}`, type: "human", name: "Operator", initials: "OP", color: "#eef0eb", status: "ready" };
}

/** Idempotent runtime migration so local development does not need a manual schema command. */
export function ensurePeerSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const sql = database();
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_id text`;
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_type text`;
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_ids text[] NOT NULL DEFAULT '{}'`;
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'broadcast'`;
    await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL`;
    await sql`
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id text NOT NULL,
        participant_id text NOT NULL,
        participant_type text NOT NULL CHECK (participant_type IN ('human', 'agent')),
        display_name text NOT NULL,
        agent_id text,
        status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'working', 'offline')),
        interaction_id text,
        environment_id text,
        environment_version integer NOT NULL DEFAULT 0,
        joined_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (channel_id, participant_id)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS channel_members_owner_idx ON channel_members(owner_id, channel_id, joined_at)`;
    await sql`
      CREATE TABLE IF NOT EXISTS message_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id text NOT NULL,
        channel_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        participant_id text NOT NULL,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'delivered', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        claimed_at timestamptz,
        delivered_at timestamptz,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (message_id, participant_id)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS message_deliveries_inbox_idx ON message_deliveries(owner_id, channel_id, participant_id, status, available_at, created_at)`;
  })().catch((error) => { schemaPromise = undefined; throw error; });
  return schemaPromise;
}

type AgentRow = { id: string; name: string; specialty: string; instructions: string };
type DatabaseTimestamp = string | Date;
type ChannelRow = { id: string; title: string; summary: string; status: Channel["status"]; repository_url: string | null; created_at: DatabaseTimestamp; updated_at: DatabaseTimestamp };
type MemberRow = { channel_id: string; participant_id: string; participant_type: ParticipantType; display_name: string; agent_id: string | null; status: ChannelParticipant["status"]; specialty: string | null };
type MessageRow = { task_id: string; id: string; role: ChannelMessage["role"]; author: string; content: string; steps: RunStep[] | null; created_at: DatabaseTimestamp; author_id: string | null; author_type: ChannelMessage["authorType"] | null; recipient_ids: string[] | null; delivery: MessageDelivery | null; reply_to_id: string | null };
type ArtifactRow = Artifact & { task_id: string };

function participantFromRow(row: MemberRow): ChannelParticipant {
  return {
    id: row.participant_id,
    type: row.participant_type,
    name: row.display_name,
    initials: initials(row.display_name),
    specialty: row.specialty ?? undefined,
    color: row.participant_type === "human" ? "#eef0eb" : color(row.agent_id ?? row.participant_id),
    status: row.status,
    agentId: row.agent_id ?? undefined,
  };
}

function messageFromRow(row: MessageRow): ChannelMessage {
  const authorType = row.author_type ?? (row.role === "user" ? "human" : row.role === "agent" ? "agent" : "system");
  return {
    id: row.id,
    role: row.role,
    author: row.author,
    authorId: row.author_id ?? (authorType === "human" ? "legacy:human" : `legacy:${row.author}`),
    authorName: row.author,
    authorType,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    steps: row.steps ?? [],
    recipientIds: row.recipient_ids ?? [],
    delivery: row.delivery ?? "broadcast",
    replyToId: row.reply_to_id ?? undefined,
  };
}

export async function listChannels(ownerId: string): Promise<Channel[]> {
  await ensurePeerSchema();
  const sql = database();
  const [channelRows, memberRows, messageRows, artifactRows] = await Promise.all([
    sql`SELECT t.id, t.title, t.summary, t.status, t.repository_url, t.created_at, t.updated_at
        FROM tasks t WHERE t.owner_id = ${ownerId}
          AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = t.id AND cm.owner_id = t.owner_id)
        ORDER BY t.updated_at DESC`,
    sql`SELECT cm.channel_id, cm.participant_id, cm.participant_type, cm.display_name, cm.agent_id, cm.status,
          CASE WHEN cm.agent_id = ${GENERAL_AGENT_ID} THEN ${generalAgent.specialty} ELSE a.specialty END AS specialty
        FROM channel_members cm LEFT JOIN agents a ON a.id = cm.agent_id AND a.owner_id = cm.owner_id
        WHERE cm.owner_id = ${ownerId} ORDER BY cm.joined_at, cm.participant_id`,
    sql`SELECT m.task_id, m.id, m.role, m.author, m.content, m.steps, m.created_at, m.author_id, m.author_type,
          m.recipient_ids, m.delivery, m.reply_to_id
        FROM messages m JOIN channel_members cm ON cm.channel_id = m.task_id AND cm.owner_id = m.owner_id
        WHERE m.owner_id = ${ownerId} GROUP BY m.id ORDER BY m.created_at, m.id`,
    sql`SELECT a.task_id, a.id, a.name, a.kind, a.size, a.url
        FROM artifacts a JOIN channel_members cm ON cm.channel_id = a.task_id AND cm.owner_id = a.owner_id
        WHERE a.owner_id = ${ownerId} GROUP BY a.id ORDER BY a.created_at, a.id`,
  ]);

  return (channelRows as ChannelRow[]).map((row) => {
    const participants = (memberRows as MemberRow[]).filter((member) => member.channel_id === row.id).map(participantFromRow);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      participantIds: participants.map((participant) => participant.id),
      participants,
      messages: orderChannelMessages((messageRows as MessageRow[]).filter((message) => message.task_id === row.id).map(messageFromRow)),
      artifacts: (artifactRows as ArtifactRow[]).filter((artifact) => artifact.task_id === row.id).map((artifact) => ({
        id: artifact.id, name: artifact.name, kind: artifact.kind, size: artifact.size, url: artifact.url,
      })),
      repositoryUrl: row.repository_url ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

export async function getChannel(ownerId: string, channelId: string): Promise<Channel | undefined> {
  return (await listChannels(ownerId)).find((channel) => channel.id === channelId);
}

function toParticipant(agent: AgentProfile): ChannelParticipant {
  return { id: agent.id, type: "agent", name: agent.name, initials: agent.initials, specialty: agent.specialty, color: agent.color, status: "ready", agentId: agent.id };
}

async function channelAgents(ownerId: string, agentIds: string[]): Promise<AgentProfile[]> {
  const sql = database();
  const customIds = agentIds.filter((id) => id !== GENERAL_AGENT_ID);
  const rows = customIds.length
    ? await sql`SELECT id, name, specialty, instructions FROM agents WHERE owner_id = ${ownerId}`
    : [];
  const byId = new Map<string, AgentProfile>([
    [GENERAL_AGENT_ID, generalAgent],
    ...(rows as AgentRow[]).map((row) => [row.id, {
      id: row.id, name: row.name, initials: initials(row.name), specialty: row.specialty,
      description: row.instructions || row.specialty, instructions: row.instructions, status: "ready" as const, color: color(row.id),
    }] as const),
  ]);
  const agents = agentIds.map((id) => byId.get(id));
  if (agents.some((agent) => !agent)) throw new Error("Choose agents from your roster");
  return agents as AgentProfile[];
}

export async function createChannel(ownerId: string, input: CreateChatInput): Promise<Channel> {
  await ensurePeerSchema();
  const agentIds = [...new Set(input.agentIds)];
  if (!agentIds.length) throw new Error("Choose at least one agent");
  const agents = await channelAgents(ownerId, agentIds);
  const human = humanParticipant(ownerId);
  const participants = [human, ...agents.map(toParticipant)];
  const recipients = resolveDeliveryRecipients(participants, human.id);
  const sql = database();
  const channelId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  await sql.transaction([
    sql`INSERT INTO tasks (id, owner_id, title, summary, status, priority, agent_id, repository_url, created_at, updated_at)
        VALUES (${channelId}, ${ownerId}, ${input.title}, ${input.summary}, 'queued', 'normal', ${agentIds[0]}, ${input.repositoryUrl ?? null}, ${now}, ${now})`,
    ...participants.map((participant) => sql`
      INSERT INTO channel_members (channel_id, owner_id, participant_id, participant_type, display_name, agent_id, status, joined_at, updated_at)
      VALUES (${channelId}, ${ownerId}, ${participant.id}, ${participant.type}, ${participant.name}, ${participant.agentId ?? null}, ${participant.status}, ${now}, ${now})`),
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, author_id, author_type, content, recipient_ids, delivery, created_at)
        VALUES (${messageId}, ${ownerId}, ${channelId}, 'user', ${human.name}, ${human.id}, 'human', ${input.summary}, ${[]}, 'broadcast', ${now})`,
    ...recipients.map((recipient) => sql`
      INSERT INTO message_deliveries (id, owner_id, channel_id, message_id, participant_id, created_at, available_at)
      VALUES (${crypto.randomUUID()}, ${ownerId}, ${channelId}, ${messageId}, ${recipient.id}, ${now}, ${now})`),
  ]);
  return (await getChannel(ownerId, channelId))!;
}

export interface PostChannelMessageInput {
  senderId: string;
  senderType: ParticipantType;
  senderName: string;
  content: string;
  recipientIds?: string[];
  replyToId?: string;
  steps?: RunStep[];
  enqueue?: boolean;
}

export async function postChannelMessage(ownerId: string, channelId: string, input: PostChannelMessageInput): Promise<ChannelMessage> {
  const channel = await getChannel(ownerId, channelId);
  if (!channel) throw new Error("Channel not found");
  const sender = channel.participants.find((participant) => participant.id === input.senderId);
  if (!sender || sender.type !== input.senderType || sender.name !== input.senderName) throw new Error("Sender is not a member of this channel");
  const recipients = resolveDeliveryRecipients(channel.participants, input.senderId, input.recipientIds);
  if (input.replyToId && !channel.messages.some((message) => message.id === input.replyToId)) throw new Error("Reply target is not in this channel");
  const delivery: MessageDelivery = input.recipientIds?.length ? "direct" : "broadcast";
  const storedRecipientIds = delivery === "direct" ? recipients.map((recipient) => recipient.id) : [];
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const sql = database();
  const queued = input.enqueue === false ? [] : recipients.filter((recipient) => recipient.type === "agent");
  await sql.transaction([
    sql`INSERT INTO messages (id, owner_id, task_id, role, author, author_id, author_type, content, steps, recipient_ids, delivery, reply_to_id, created_at)
        VALUES (${id}, ${ownerId}, ${channelId}, ${input.senderType === "human" ? "user" : "agent"}, ${input.senderName}, ${input.senderId}, ${input.senderType}, ${input.content}, ${JSON.stringify(input.steps ?? [])}, ${storedRecipientIds}, ${delivery}, ${input.replyToId ?? null}, ${now})`,
    sql`UPDATE tasks SET status = 'running', updated_at = ${now} WHERE id = ${channelId} AND owner_id = ${ownerId}`,
    ...queued.map((recipient) => sql`
      INSERT INTO message_deliveries (id, owner_id, channel_id, message_id, participant_id, created_at, available_at)
      VALUES (${crypto.randomUUID()}, ${ownerId}, ${channelId}, ${id}, ${recipient.id}, ${now}, ${now})`),
  ]);
  return {
    id, role: input.senderType === "human" ? "user" : "agent", author: input.senderName,
    authorId: input.senderId, authorName: input.senderName, authorType: input.senderType,
    content: input.content, createdAt: now, steps: input.steps ?? [], recipientIds: storedRecipientIds,
    delivery, replyToId: input.replyToId,
  };
}

export interface ChannelDelivery {
  id: string;
  channelId: string;
  participantId: string;
  message: ChannelMessage;
}

export async function claimChannelDeliveries(ownerId: string, channelId: string, agentId: string, limit = 1): Promise<ChannelDelivery[]> {
  await ensurePeerSchema();
  const sql = database();
  const rows = await sql`
    WITH candidates AS (
      SELECT md.id FROM message_deliveries md
      JOIN channel_members cm ON cm.channel_id = md.channel_id AND cm.participant_id = md.participant_id AND cm.owner_id = md.owner_id
      WHERE md.owner_id = ${ownerId} AND md.channel_id = ${channelId} AND md.participant_id = ${agentId}
        AND cm.participant_type = 'agent' AND md.status = 'queued' AND md.available_at <= now()
      ORDER BY md.created_at, md.id FOR UPDATE SKIP LOCKED LIMIT ${Math.max(1, Math.min(limit, 20))}
    )
    UPDATE message_deliveries md SET status = 'processing', attempts = attempts + 1, claimed_at = now()
    FROM candidates WHERE md.id = candidates.id
    RETURNING md.id, md.channel_id, md.participant_id, md.message_id`;
  if (!rows.length) return [];
  const channel = await getChannel(ownerId, channelId);
  if (!channel) return [];
  return rows.flatMap((row) => {
    const message = channel.messages.find((item) => item.id === String(row.message_id));
    return message ? [{ id: String(row.id), channelId: String(row.channel_id), participantId: String(row.participant_id), message }] : [];
  });
}

export async function completeChannelDelivery(ownerId: string, deliveryId: string, status: "delivered" | "failed", error?: string): Promise<void> {
  const sql = database();
  await sql`UPDATE message_deliveries SET status = ${status}, delivered_at = now(), error_message = ${error ?? null}
      WHERE id = ${deliveryId} AND owner_id = ${ownerId} AND status = 'processing'`;
}

export async function updateChannelMemberRun(ownerId: string, channelId: string, agentId: string, state: {
  status?: ChannelParticipant["status"];
  interactionId?: string;
  environmentId?: string;
}): Promise<void> {
  const sql = database();
  await sql`UPDATE channel_members SET status = COALESCE(${state.status ?? null}, status),
      interaction_id = COALESCE(${state.interactionId ?? null}, interaction_id),
      environment_id = COALESCE(${state.environmentId ?? null}, environment_id), updated_at = now()
      WHERE owner_id = ${ownerId} AND channel_id = ${channelId} AND participant_id = ${agentId} AND participant_type = 'agent'`;
}

export async function getChannelMemberRun(ownerId: string, channelId: string, agentId: string): Promise<{ interactionId?: string; environmentId?: string }> {
  const sql = database();
  const rows = await sql`SELECT interaction_id, environment_id FROM channel_members
      WHERE owner_id = ${ownerId} AND channel_id = ${channelId} AND participant_id = ${agentId} LIMIT 1`;
  return { interactionId: rows[0]?.interaction_id ? String(rows[0].interaction_id) : undefined, environmentId: rows[0]?.environment_id ? String(rows[0].environment_id) : undefined };
}

export async function setChannelStatus(ownerId: string, channelId: string, status: Channel["status"]): Promise<void> {
  const sql = database();
  await sql`UPDATE tasks SET status = ${status}, updated_at = now() WHERE owner_id = ${ownerId} AND id = ${channelId}`;
}

export async function channelHasQueuedDeliveries(ownerId: string, channelId: string): Promise<boolean> {
  const sql = database();
  const rows = await sql`SELECT EXISTS(SELECT 1 FROM message_deliveries
      WHERE owner_id = ${ownerId} AND channel_id = ${channelId} AND status IN ('queued', 'processing')) AS pending`;
  return Boolean(rows[0]?.pending);
}

export async function recordChannelArtifacts(ownerId: string, channelId: string, steps: RunStep[]): Promise<void> {
  const fileSteps = steps.filter((step) => step.kind === "file");
  if (!fileSteps.length) return;
  const sql = database();
  await sql.transaction(fileSteps.map((step) => {
    const detail = step.detail ?? "";
    const url = detail.match(/https?:\/\/[^\s)]+/)?.[0];
    const path = detail.match(/(?:\/[\w.\-/]+|[\w.-]+\.[a-z0-9]{1,8})/i)?.[0];
    const name = path?.split("/").filter(Boolean).at(-1) ?? step.label;
    const extension = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() : undefined;
    return sql`INSERT INTO artifacts (id, owner_id, task_id, name, kind, url)
      SELECT ${crypto.randomUUID()}, ${ownerId}, ${channelId}, ${name}, ${extension ? `${extension} file` : "File"}, ${url ?? null}
      WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE owner_id = ${ownerId} AND task_id = ${channelId} AND name = ${name})`;
  }));
}
