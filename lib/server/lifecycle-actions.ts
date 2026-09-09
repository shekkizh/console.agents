import { messagePurposeSql } from "@/lib/message-protocol";
import { neon } from "@neondatabase/serverless";
import { getAgent, listAgents } from "@/lib/server/agent-store";
import { withAgentLifecycleLock } from "@/lib/server/agent-lifecycle";
import { acquireAgentSandbox, cancelSandboxTask } from "@/lib/server/agent-sandbox";
import { config, requireDatabaseUrl } from "@/lib/server/config";
import { stopConversation } from "@/lib/server/conversation-store";
import { finalizeDetachedFxTurn } from "@/lib/server/fx-runtime";
import { settleCompletedAgentTask } from "@/lib/server/task-dispatcher";

export async function stopConversationWorkers(ownerId: string, conversationId: string, beforeUnlock?: () => Promise<void>) {
  // A stable lock order prevents stop requests from deadlocking on shared peers.
  const ids = (await listAgents(ownerId)).map((agent) => agent.id).sort();
  async function stop(index: number): Promise<Awaited<ReturnType<typeof stopConversation>>> {
    if (index < ids.length) return withAgentLifecycleLock({ ownerId, agentId: ids[index]! }, () => stop(index + 1));
    const rows = await neon(requireDatabaseUrl()).query(
      `SELECT d.recipient_id, d.message_id FROM message_deliveries d
       JOIN conversation_messages m ON m.owner_id = d.owner_id AND m.id = d.message_id
       WHERE d.owner_id = $1 AND m.conversation_id = $2 AND d.recipient_type = 'agent'
         AND (d.state IN ('claimed', 'running') OR (d.activation_started_at IS NOT NULL AND d.settled_at IS NULL))`, [ownerId, conversationId],
    );
    for (const row of rows) {
      const agent = await getAgent(ownerId, String(row.recipient_id));
      if (agent && !config.e2eFakeFx) await cancelSandboxTask({ ownerId, agent, messageId: String(row.message_id) });
    }
    const result = await stopConversation(ownerId, conversationId);
    for (const agentId of new Set(rows.map((row) => String(row.recipient_id)))) {
      await settleCompletedAgentTask({ ownerId, agentId });
    }
    await beforeUnlock?.();
    return result;
  }
  return stop(0);
}

// Caller holds this agent's lifecycle lock until disabling/deleting its registry row.
export async function stopAgentWorkers(ownerId: string, agentId: string) {
  const agent = await getAgent(ownerId, agentId);
  if (!agent) throw new Error("Agent not found");
  const sql = neon(requireDatabaseUrl());
  const active = await sql.query(
    `SELECT message_id FROM message_deliveries WHERE owner_id = $1
     AND recipient_id = $2 AND recipient_type = 'agent' AND (state IN ('claimed', 'running') OR (activation_started_at IS NOT NULL AND settled_at IS NULL))`, [ownerId, agentId],
  );
  for (const row of active) {
    if (!config.e2eFakeFx) await cancelSandboxTask({ ownerId, agent, messageId: String(row.message_id) });
  }
  if (active.length && !config.e2eFakeFx) {
    const sandbox = await acquireAgentSandbox({ ownerId, agent });
    await finalizeDetachedFxTurn({ ownerId, agent, sandbox });
    await sandbox.stop();
  }
  await sql.query(
    `UPDATE message_deliveries SET state = 'failed', error = 'Agent disabled or deleted',
       completed_at = now(), settled_at = now()
     WHERE owner_id = $1 AND recipient_id = $2 AND recipient_type = 'agent'
       AND state IN ('queued', 'claimed', 'running')`, [ownerId, agentId],
  );
  await sql.query(
    `UPDATE message_deliveries SET settled_at = now()
     WHERE owner_id = $1 AND recipient_id = $2 AND recipient_type = 'agent'
       AND activation_started_at IS NOT NULL AND state IN ('completed', 'failed')`, [ownerId, agentId],
  );
  await sql.query(
    `UPDATE conversations c SET status = 'failed', updated_at = now()
     WHERE c.owner_id = $1 AND c.status = 'working'
       AND EXISTS (SELECT 1 FROM conversation_messages m JOIN message_deliveries d
         ON d.owner_id = m.owner_id AND d.message_id = m.id
         WHERE m.owner_id = c.owner_id AND m.conversation_id = c.id AND d.recipient_id = $2)
       AND NOT EXISTS (SELECT 1 FROM conversation_messages m JOIN message_deliveries d
         ON d.owner_id = m.owner_id AND d.message_id = m.id
         WHERE m.owner_id = c.owner_id AND m.conversation_id = c.id
           AND d.state IN ('queued', 'claimed', 'running')
           AND ${messagePurposeSql("m")} IN ('request', 'reply'))`, [ownerId, agentId],
  );
}
