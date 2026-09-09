import { Client, neon } from "@neondatabase/serverless";
import type { CapturedArtifact } from "@/lib/server/artifact-capture";
import { requireDatabaseListenerUrl, requireDatabaseUrl } from "@/lib/server/config";
import { getAgent, listAgents } from "@/lib/server/agent-store";
import type {
  AgentArtifact,
  AgentArtifactKind,
  AgentMessage,
  AgentProfile,
  ConversationMessageActivity,
  MessageDeliveryState,
} from "@/lib/types";

const MESSAGE_CHANNEL = "console_conversation_messages";

function database() {
  return neon(requireDatabaseUrl());
}

function notificationKey(ownerId: string, recipientId: string): string {
  return JSON.stringify([ownerId, recipientId]);
}

export type MessageParticipantType = "human" | "agent" | "system";
export type MessageRecipientType = "human" | "agent";
export type ConversationMessageKind = "message" | "error";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderType: MessageParticipantType;
  senderId: string;
  recipientType: MessageRecipientType;
  recipientId: string;
  kind: ConversationMessageKind;
  inReplyTo: string | null;
  content: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: MessageParticipantType;
  sender_id: string;
  recipient_type: MessageRecipientType;
  recipient_id: string;
  kind: ConversationMessageKind;
  in_reply_to: string | null;
  content: string;
  summary: string | null;
  metadata: unknown;
  created_at: string | Date;
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    kind: row.kind,
    inReplyTo: row.in_reply_to,
    content: row.content,
    summary: row.summary,
    metadata: row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {},
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const messageColumns = `
  id, conversation_id, sender_type, sender_id, recipient_type, recipient_id,
  kind, in_reply_to, content, summary, metadata, created_at
`;

const qualifiedMessageColumns = messageColumns
  .split(",")
  .map((column) => `message.${column.trim()}`)
  .join(", ");

export interface MessageListener {
  wait(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export async function openMessageListener(
  ownerId: string,
  recipientId: string,
  signal?: AbortSignal,
): Promise<MessageListener> {
  signal?.throwIfAborted();
  const client = new Client({ connectionString: requireDatabaseListenerUrl() });
  const expected = notificationKey(ownerId, recipientId);
  let pending = false;
  let failure: unknown;
  let active: { resolve: (notified: boolean) => void; reject: (error: unknown) => void } | undefined;

  client.on("notification", (message) => {
    if (message.channel !== MESSAGE_CHANNEL || message.payload !== expected) return;
    if (active) active.resolve(true);
    else pending = true;
  });
  client.on("error", (error) => {
    failure = error;
    active?.reject(error);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${MESSAGE_CHANNEL}`);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    wait(timeoutMs) {
      signal?.throwIfAborted();
      if (failure) return Promise.reject(failure);
      if (pending) {
        pending = false;
        return Promise.resolve(true);
      }
      return new Promise((resolve, reject) => {
        const finish = (notified: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          active = undefined;
          resolve(notified);
        };
        const fail = (error: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          active = undefined;
          reject(error);
        };
        const cancel = () => fail(signal?.reason ?? new Error("Message wait cancelled"));
        const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
        active = { resolve: finish, reject: fail };
        signal?.addEventListener("abort", cancel, { once: true });
      });
    },
    async close() {
      await client.end();
    },
  };
}

export async function listReachableAgents(
  ownerId: string,
  selfAgentId: string,
): Promise<AgentProfile[]> {
  return (await listAgents(ownerId)).filter((agent) => agent.enabled && agent.id !== selfAgentId);
}

export async function resolveAgentRecipient(
  ownerId: string,
  selfAgentId: string,
  recipient: string,
): Promise<AgentProfile> {
  const normalized = recipient.trim().toLowerCase();
  const peer = (await listReachableAgents(ownerId, selfAgentId)).find(
    (agent) => agent.id.toLowerCase() === normalized || agent.name.toLowerCase() === normalized,
  );
  if (!peer) throw new Error(`Unknown or unreachable agent: ${recipient}`);
  return peer;
}

export async function getConversationMessage(
  ownerId: string,
  messageId: string,
): Promise<ConversationMessage | undefined> {
  const rows = await database().query(
    `SELECT ${messageColumns}
     FROM conversation_messages
     WHERE owner_id = $1 AND id = $2
     LIMIT 1`,
    [ownerId, messageId],
  );
  return rows[0] ? toMessage(rows[0] as MessageRow) : undefined;
}

export async function latestFxCompletionSessionId(input: {
  ownerId: string;
  agentId: string;
  conversationId: string;
}): Promise<string | undefined> {
  const rows = await database().query(
    `SELECT metadata->>'sessionId' AS session_id
     FROM conversation_messages
     WHERE owner_id = $1 AND conversation_id = $2
       AND sender_type = 'agent' AND sender_id = $3
       AND metadata->>'activity' = 'completion'
       AND metadata->>'sessionId' IS NOT NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [input.ownerId, input.conversationId, input.agentId],
  );
  const sessionId = (rows[0] as { session_id?: unknown } | undefined)?.session_id;
  return typeof sessionId === "string" ? sessionId : undefined;
}

export async function publishConversationMessage(input: {
  ownerId: string;
  id?: string;
  conversationId: string;
  senderType: MessageParticipantType;
  senderId: string;
  recipientType: MessageRecipientType;
  recipientId: string;
  kind?: ConversationMessageKind;
  inReplyTo?: string;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  artifacts?: readonly CapturedArtifact[];
}): Promise<ConversationMessage> {
  const conversationId = input.conversationId.trim();
  const content = input.content.trim();
  if (!conversationId || conversationId.length > 300) throw new Error("Conversation id is invalid");
  if (!content || content.length > 100_000) throw new Error("Message content is invalid");
  if (input.senderType === "human" && input.senderId !== input.ownerId) {
    throw new Error("Human sender is invalid");
  }
  if (input.recipientType === "human" && input.recipientId !== input.ownerId) {
    throw new Error("Human recipient is invalid");
  }

  const agentIds = [
    ...(input.senderType === "agent" ? [input.senderId] : []),
    ...(input.recipientType === "agent" ? [input.recipientId] : []),
  ];
  const agents = await Promise.all(agentIds.map((agentId) => getAgent(input.ownerId, agentId)));
  if (agents.some((agent) => !agent?.enabled)) throw new Error("Message participant is unavailable");

  const sql = database();
  const id = input.id ?? crypto.randomUUID();
  const deliveryState = input.recipientType === "human" ? "completed" : "queued";
  const insertMessage = sql.query(
    `INSERT INTO conversation_messages
       (owner_id, id, conversation_id, sender_type, sender_id,
        recipient_type, recipient_id, kind, in_reply_to, content, summary, metadata)
     SELECT $1, $2, conversation.id, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
     FROM conversations conversation
     WHERE conversation.owner_id = $1 AND conversation.id = $3
     ON CONFLICT (owner_id, id) DO NOTHING`,
    [
      input.ownerId,
      id,
      conversationId,
      input.senderType,
      input.senderId,
      input.recipientType,
      input.recipientId,
      input.kind ?? "message",
      input.inReplyTo ?? null,
      content,
      input.summary?.trim() || null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const insertDelivery = sql.query(
    `INSERT INTO message_deliveries
       (owner_id, message_id, recipient_type, recipient_id, state,
        claimed_at, completed_at)
     SELECT $1, message.id, message.recipient_type, message.recipient_id, $3,
       CASE WHEN $3 = 'completed' THEN now() ELSE NULL END,
       CASE WHEN $3 = 'completed' THEN now() ELSE NULL END
     FROM conversation_messages message
     WHERE message.owner_id = $1 AND message.id = $2
     ON CONFLICT (owner_id, message_id, recipient_type, recipient_id) DO NOTHING`,
    [input.ownerId, id, deliveryState],
  );
  const artifactQueries = (input.artifacts ?? []).map((artifact) =>
    sql.query(
      `INSERT INTO message_artifacts
         (owner_id, message_id, sandbox_path, filename, title, media_type,
          kind, size_bytes, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'base64'))
       ON CONFLICT (owner_id, message_id, sandbox_path) DO NOTHING`,
      [
        input.ownerId,
        id,
        artifact.path,
        artifact.name,
        artifact.title,
        artifact.mediaType,
        artifact.kind,
        artifact.content.byteLength,
        Buffer.from(artifact.content).toString("base64"),
      ],
    )
  );
  const titleUpdate = input.senderType === "human"
    ? sql.query(
        `UPDATE conversations SET
           title = CASE
             WHEN title = 'New conversation' THEN left(regexp_replace($3, '\\s+', ' ', 'g'), 64)
             ELSE title
           END,
           status = CASE WHEN EXISTS (
             SELECT 1 FROM message_deliveries delivery
             WHERE delivery.owner_id = $1
               AND delivery.message_id = $4
               AND delivery.state IN ('queued', 'claimed', 'running')
           ) THEN 'working' ELSE status END,
           updated_at = now()
         WHERE owner_id = $1 AND id = $2`,
        [input.ownerId, conversationId, content, id],
      )
    : sql.query(
        `UPDATE conversations SET
           status = CASE WHEN $3::boolean THEN 'working' ELSE status END,
           updated_at = now()
         WHERE owner_id = $1 AND id = $2`,
        [input.ownerId, conversationId, input.recipientType === "agent"],
      );
  const notify = input.recipientType === "agent"
    ? sql.query(`SELECT pg_notify('${MESSAGE_CHANNEL}', $1)`, [
        notificationKey(input.ownerId, input.recipientId),
      ])
    : sql.query("SELECT 1");

  await sql.transaction([
    insertMessage,
    insertDelivery,
    ...artifactQueries,
    titleUpdate,
    notify,
  ]);
  const message = await getConversationMessage(input.ownerId, id);
  if (!message) throw new Error("Conversation not found");
  return message;
}

export async function markMessageDelivery(
  ownerId: string,
  messageId: string,
  recipientId: string,
  state: MessageDeliveryState,
  error?: string,
): Promise<void> {
  const timestamp = state === "claimed"
      ? "claimed_at"
      : state === "running"
        ? "running_at"
        : state === "completed" || state === "failed"
          ? "completed_at"
          : undefined;
  const setTimestamp = timestamp ? `, ${timestamp} = now()` : "";
  const stateGuard = state === "claimed"
      ? "AND state IN ('queued', 'claimed')"
      : state === "running"
        ? "AND state = 'claimed'"
        : state === "completed" || state === "failed"
          ? "AND state IN ('queued', 'claimed', 'running')"
          : "";
  await database().query(
    `UPDATE message_deliveries
     SET state = $4, error = $5${setTimestamp}
     WHERE owner_id = $1 AND message_id = $2
       AND recipient_type = 'agent' AND recipient_id = $3
       ${stateGuard}`,
    [ownerId, messageId, recipientId, state, error ?? null],
  );
  if (state !== "completed" && state !== "failed") return;
  await database().query(
    `UPDATE conversations conversation
     SET status = CASE
       WHEN EXISTS (
         SELECT 1
         FROM conversation_messages message
         JOIN message_deliveries delivery
           ON delivery.owner_id = message.owner_id
          AND delivery.message_id = message.id
         WHERE message.owner_id = $1
           AND message.conversation_id = conversation.id
           AND delivery.recipient_type = 'agent'
           AND delivery.state IN ('queued', 'claimed', 'running')
       ) THEN 'working'
       WHEN $3 = 'failed' AND EXISTS (
         SELECT 1
         FROM conversation_messages message
         WHERE message.owner_id = $1
           AND message.id = $2
           AND message.sender_type = 'human'
       ) THEN 'failed'
       ELSE 'completed'
     END,
     updated_at = now()
     WHERE conversation.owner_id = $1
       AND conversation.id = (
         SELECT message.conversation_id
         FROM conversation_messages message
         WHERE message.owner_id = $1 AND message.id = $2
       )`,
    [ownerId, messageId, state],
  );
}

export async function isMessageDeliveryPending(
  ownerId: string,
  messageId: string,
  recipientId: string,
): Promise<boolean> {
  const rows = await database().query(
    `SELECT EXISTS (
       SELECT 1
       FROM message_deliveries
       WHERE owner_id = $1 AND message_id = $2
         AND recipient_type = 'agent' AND recipient_id = $3
         AND state IN ('queued', 'claimed', 'running')
     ) AS pending`,
    [ownerId, messageId, recipientId],
  );
  return Boolean((rows[0] as { pending?: boolean } | undefined)?.pending);
}

export interface PendingAgentMessage extends ConversationMessage {
  deliveryState: MessageDeliveryState;
}

export async function nextPendingAgentMessage(input: {
  ownerId: string;
  agentId: string;
}): Promise<PendingAgentMessage | undefined> {
  const sql = database();
  const rows = await sql.query(
    `WITH guard AS (
       SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS acquired
     ), selected AS (
       SELECT delivery.id
       FROM message_deliveries delivery
       JOIN conversation_messages message
         ON message.owner_id = delivery.owner_id AND message.id = delivery.message_id
       CROSS JOIN guard
       WHERE delivery.owner_id = $1
         AND delivery.recipient_type = 'agent'
         AND delivery.recipient_id = $2
         AND delivery.state = 'queued'
         AND guard.acquired
         AND NOT EXISTS (
           SELECT 1
           FROM message_deliveries active_delivery
           WHERE active_delivery.owner_id = delivery.owner_id
             AND active_delivery.recipient_type = 'agent'
             AND active_delivery.recipient_id = delivery.recipient_id
             AND active_delivery.state IN ('claimed', 'running')
         )
       ORDER BY delivery.created_at ASC, delivery.id ASC
       LIMIT 1
       FOR UPDATE OF delivery SKIP LOCKED
     ), claimed AS (
       UPDATE message_deliveries delivery
       SET state = 'claimed', claimed_at = COALESCE(claimed_at, now()), activation_started_at = now()
       FROM selected
       WHERE delivery.id = selected.id
       RETURNING delivery.message_id, delivery.state
     )
     SELECT ${qualifiedMessageColumns},
            claimed.state AS delivery_state
     FROM claimed
     JOIN conversation_messages message
       ON message.owner_id = $1 AND message.id = claimed.message_id`,
    [input.ownerId, input.agentId],
  );
  const row = rows[0] as (MessageRow & { delivery_state: MessageDeliveryState }) | undefined;
  return row ? { ...toMessage(row), deliveryState: row.delivery_state } : undefined;
}

export async function hasActiveAgentDelivery(
  ownerId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await database().query(
    `SELECT EXISTS (
       SELECT 1
       FROM message_deliveries
       WHERE owner_id = $1
         AND recipient_type = 'agent'
         AND recipient_id = $2
         AND state IN ('claimed', 'running')
     ) AS active`,
    [ownerId, agentId],
  );
  return Boolean((rows[0] as { active?: boolean } | undefined)?.active);
}

export interface ActiveConversationDelivery {
  messageId: string;
  agentId: string;
  runningAt: string;
}

export async function getActiveConversationDelivery(
  ownerId: string,
  conversationId: string,
): Promise<ActiveConversationDelivery | undefined> {
  const rows = await database().query(
    `SELECT message.id AS message_id,
            delivery.recipient_id AS agent_id,
            COALESCE(delivery.running_at, delivery.claimed_at, delivery.created_at) AS running_at
     FROM conversation_messages message
     JOIN message_deliveries delivery
       ON delivery.owner_id = message.owner_id
      AND delivery.message_id = message.id
     WHERE message.owner_id = $1
       AND message.conversation_id = $2
       AND delivery.recipient_type = 'agent'
       AND delivery.state IN ('claimed', 'running')
     ORDER BY delivery.running_at DESC, delivery.id DESC
     LIMIT 1`,
    [ownerId, conversationId],
  );
  const row = rows[0] as {
    message_id?: unknown;
    agent_id?: unknown;
    running_at?: string | Date;
  } | undefined;
  if (
    typeof row?.message_id !== "string" ||
    typeof row.agent_id !== "string" ||
    !row.running_at
  ) return;
  return {
    messageId: row.message_id,
    agentId: row.agent_id,
    runningAt: new Date(row.running_at).toISOString(),
  };
}

export async function claimConversationMessages(input: {
  ownerId: string;
  agentId: string;
  conversationId: string;
  fromAgentId?: string;
  inReplyTo?: string;
  limit?: number;
}): Promise<ConversationMessage[]> {
  const rows = await database().query(
    `WITH selected AS (
       SELECT delivery.id
       FROM message_deliveries delivery
       JOIN conversation_messages message
         ON message.owner_id = delivery.owner_id AND message.id = delivery.message_id
       WHERE delivery.owner_id = $1
         AND delivery.recipient_type = 'agent'
         AND delivery.recipient_id = $2
         AND delivery.state IN ('queued', 'claimed')
         AND message.conversation_id = $3
         AND message.sender_type = 'agent'
         AND ($4::text IS NULL OR message.sender_id = $4)
         AND ($5::text IS NULL OR message.in_reply_to = $5)
       ORDER BY delivery.created_at ASC, delivery.id ASC
       LIMIT $6
       FOR UPDATE OF delivery SKIP LOCKED
     ), completed AS (
       UPDATE message_deliveries delivery
       SET state = 'completed',
           claimed_at = COALESCE(claimed_at, now()),
           completed_at = now()
       FROM selected
       WHERE delivery.id = selected.id
       RETURNING delivery.message_id
     )
     SELECT ${qualifiedMessageColumns}
     FROM completed
     JOIN conversation_messages message
       ON message.owner_id = $1 AND message.id = completed.message_id
     ORDER BY message.created_at ASC, message.id ASC`,
    [
      input.ownerId,
      input.agentId,
      input.conversationId,
      input.fromAgentId ?? null,
      input.inReplyTo ?? null,
      Math.min(50, Math.max(1, input.limit ?? 50)),
    ],
  );
  return (rows as MessageRow[]).map(toMessage);
}

function bytea(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  }
  throw new Error("Message artifact content is unavailable");
}

export interface MessageArtifact {
  id: string;
  messageId: string;
  name: string;
  title: string;
  mediaType: string;
  kind: AgentArtifactKind;
  size: number;
  content: Uint8Array;
}

export async function listMessageArtifacts(
  ownerId: string,
  messageId: string,
): Promise<MessageArtifact[]> {
  const rows = await database().query(
    `SELECT id, message_id, filename, title, media_type, kind, size_bytes, content
     FROM message_artifacts
     WHERE owner_id = $1 AND message_id = $2
     ORDER BY created_at ASC, id ASC`,
    [ownerId, messageId],
  );
  return rows.map((value) => {
    const row = value as {
      id: string;
      message_id: string;
      filename: string;
      title: string;
      media_type: string;
      kind: AgentArtifactKind;
      size_bytes: number;
      content: unknown;
    };
    return {
      id: row.id,
      messageId: row.message_id,
      name: row.filename,
      title: row.title,
      mediaType: row.media_type,
      kind: row.kind,
      size: Number(row.size_bytes),
      content: bytea(row.content),
    };
  });
}

function projectArtifacts(value: unknown): AgentArtifact[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<AgentArtifactKind>(["image", "pdf", "text"]);
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const artifact = item as Record<string, unknown>;
    if (
      typeof artifact.id !== "string" ||
      typeof artifact.name !== "string" ||
      typeof artifact.title !== "string" ||
      typeof artifact.mediaType !== "string" ||
      typeof artifact.kind !== "string" ||
      !kinds.has(artifact.kind as AgentArtifactKind) ||
      typeof artifact.size !== "number"
    ) return [];
    return [{
      id: artifact.id,
      name: artifact.name,
      title: artifact.title,
      mediaType: artifact.mediaType,
      kind: artifact.kind as AgentArtifactKind,
      size: artifact.size,
    }];
  });
}

export async function listConversationTranscript(
  ownerId: string,
  conversationId: string,
  limit = 200,
): Promise<AgentMessage[]> {
  const rows = await database().query(
    `SELECT ${qualifiedMessageColumns},
            delivery.state AS delivery_state,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', artifact.id::text,
                'name', artifact.filename,
                'title', artifact.title,
                'mediaType', artifact.media_type,
                'kind', artifact.kind,
                'size', artifact.size_bytes
              ) ORDER BY artifact.created_at, artifact.id)
              FROM message_artifacts artifact
              WHERE artifact.owner_id = message.owner_id
                AND artifact.message_id = message.id
            ), '[]'::jsonb) AS stored_artifacts
     FROM conversation_messages message
     JOIN message_deliveries delivery
       ON delivery.owner_id = message.owner_id AND delivery.message_id = message.id
     WHERE message.owner_id = $1 AND message.conversation_id = $2
       AND (
         (message.sender_type = 'human' AND message.recipient_type = 'agent')
         OR (message.sender_type = 'agent' AND message.recipient_type = 'human')
       )
     ORDER BY message.created_at DESC, message.id DESC
     LIMIT $3`,
    [ownerId, conversationId, Math.min(500, Math.max(1, limit))],
  );
  return rows.reverse().flatMap((value) => {
    const row = value as MessageRow & {
      delivery_state: MessageDeliveryState;
      stored_artifacts: unknown;
    };
    const message = toMessage(row);
    if (message.kind === "error") return [];
    return [{
      id: message.id,
      requestId: message.senderType === "human" ? message.id : message.inReplyTo ?? message.id,
      role: message.senderType === "human" ? "user" as const : "assistant" as const,
      text: message.content,
      artifacts: [
        ...projectArtifacts(message.metadata.artifacts),
        ...projectArtifacts(row.stored_artifacts),
      ],
      failed: message.senderType === "human" && row.delivery_state === "failed",
      createdAt: message.createdAt,
    }];
  });
}

export async function listConversationActivity(
  ownerId: string,
  conversationId: string,
  limit = 300,
): Promise<ConversationMessageActivity[]> {
  const rows = await database().query(
    `SELECT message.id, message.sender_type, message.sender_id,
       CASE
         WHEN message.sender_type = 'human' THEN 'You'
         WHEN message.sender_type = 'system' THEN 'System'
         ELSE COALESCE(sender.name, message.sender_id)
       END AS sender_name,
       message.recipient_type, message.recipient_id,
       CASE
         WHEN message.recipient_type = 'human' THEN 'You'
         ELSE COALESCE(recipient.name, message.recipient_id)
       END AS recipient_name,
       message.kind, message.in_reply_to, message.content, message.summary,
       message.created_at, delivery.state,
       (SELECT count(*)::int FROM message_artifacts artifact
        WHERE artifact.owner_id = message.owner_id
          AND artifact.message_id = message.id) AS artifact_count
     FROM conversation_messages message
     JOIN message_deliveries delivery
       ON delivery.owner_id = message.owner_id AND delivery.message_id = message.id
     LEFT JOIN agents sender
       ON sender.owner_id = message.owner_id AND sender.id = message.sender_id
     LEFT JOIN agents recipient
       ON recipient.owner_id = message.owner_id AND recipient.id = message.recipient_id
     WHERE message.owner_id = $1 AND message.conversation_id = $2
     ORDER BY message.created_at ASC, message.id ASC
     LIMIT $3`,
    [ownerId, conversationId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map((value) => {
    const row = value as Record<string, unknown>;
    return {
      id: String(row.id),
      senderType: row.sender_type as MessageParticipantType,
      senderId: String(row.sender_id),
      senderName: String(row.sender_name),
      recipientType: row.recipient_type as MessageRecipientType,
      recipientId: String(row.recipient_id),
      recipientName: String(row.recipient_name),
      kind: row.kind as ConversationMessageKind,
      inReplyTo: typeof row.in_reply_to === "string" ? row.in_reply_to : null,
      content: String(row.content),
      summary: typeof row.summary === "string" ? row.summary : null,
      state: row.state as MessageDeliveryState,
      artifactCount: Number(row.artifact_count),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    };
  });
}

export interface AgentDelivery {
  messageId: string;
  agentId: string;
  conversationId: string;
  runningAt: string;
}

async function findAgentDelivery(ownerId: string, agentId: string, terminal: boolean): Promise<AgentDelivery | undefined> {
  const rows = await database().query(
    `SELECT message.id AS message_id, message.conversation_id, delivery.recipient_id AS agent_id,
            COALESCE(delivery.running_at, delivery.claimed_at, delivery.created_at) AS running_at
     FROM message_deliveries delivery
     JOIN conversation_messages message ON message.owner_id = delivery.owner_id AND message.id = delivery.message_id
     WHERE delivery.owner_id = $1 AND delivery.recipient_type = 'agent' AND delivery.recipient_id = $2
       AND (($3::boolean AND delivery.state IN ('completed', 'failed') AND delivery.activation_started_at IS NOT NULL AND delivery.settled_at IS NULL)
         OR (NOT $3::boolean AND delivery.state IN ('claimed', 'running')))
     ORDER BY delivery.created_at ASC LIMIT 1`, [ownerId, agentId, terminal],
  );
  const row = rows[0] as { message_id: string; conversation_id: string; agent_id: string; running_at: string | Date } | undefined;
  return row ? { messageId: row.message_id, agentId: row.agent_id, conversationId: row.conversation_id, runningAt: new Date(row.running_at).toISOString() } : undefined;
}

export function getActiveAgentDelivery(ownerId: string, agentId: string) {
  return findAgentDelivery(ownerId, agentId, false);
}

export function getUnsettledAgentDelivery(ownerId: string, agentId: string) {
  return findAgentDelivery(ownerId, agentId, true);
}

export async function markAgentDeliverySettled(ownerId: string, agentId: string, messageId: string) {
  await database().query(
    `UPDATE message_deliveries SET settled_at = now()
     WHERE owner_id = $1 AND recipient_type = 'agent' AND recipient_id = $2 AND message_id = $3
       AND state IN ('completed', 'failed')`, [ownerId, agentId, messageId],
  );
}
