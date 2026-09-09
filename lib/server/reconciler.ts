import { neon } from "@neondatabase/serverless";
import { config, requireDatabaseUrl } from "@/lib/server/config";
import { settleCompletedAgentTask } from "@/lib/server/task-dispatcher";

export async function reconcileAgentTasks(options: { ownerId?: string; limit?: number } = {}) {
  const ownerId = options.ownerId ?? (config.e2eTestMode ? config.e2eTestOwnerId : undefined);
  if (config.e2eTestMode && !ownerId) throw new Error("Test reconciliation requires an isolated owner");
  const sql = neon(requireDatabaseUrl());
  // Rotate through agents so a long-running or broken worker cannot starve others.
  const candidates = await sql.query(
    `SELECT a.owner_id, a.id AS agent_id FROM agents a
     LEFT JOIN agent_reconciliation_state r ON r.owner_id = a.owner_id AND r.agent_id = a.id
     WHERE a.enabled AND ($1::text IS NULL OR a.owner_id = $1)
       AND EXISTS (
         SELECT 1 FROM message_deliveries d
         WHERE d.owner_id = a.owner_id AND d.recipient_id = a.id AND d.recipient_type = 'agent'
           AND (d.state IN ('queued', 'claimed', 'running')
             OR (d.activation_started_at IS NOT NULL AND d.settled_at IS NULL))
       )
     ORDER BY r.attempted_at ASC NULLS FIRST, a.id LIMIT $2`,
    [ownerId ?? null, Math.min(50, Math.max(1, options.limit ?? 20))],
  );
  let succeeded = 0;
  let failed = 0;
  const queue = [...candidates];
  // Bounded concurrency; overlapping cron invocations share lifecycle locks.
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const ownerId = String(row.owner_id);
      const agentId = String(row.agent_id);
      await sql.query(
        `INSERT INTO agent_reconciliation_state (owner_id, agent_id, attempted_at)
         VALUES ($1, $2, now()) ON CONFLICT (owner_id, agent_id)
         DO UPDATE SET attempted_at = now()`, [ownerId, agentId],
      );
      let diagnostic: string | null = null;
      try {
        const outcome = await settleCompletedAgentTask({ ownerId, agentId });
        if (outcome.status === "failed") throw new Error("DispatchFailure");
        succeeded++;
      } catch (error) {
        failed++;
        // Preserve a safe diagnostic, never credentials embedded in upstream errors.
        diagnostic = error instanceof Error ? error.name : "ReconciliationError";
        console.error("agent-task.reconcile.failed", { agentId, diagnostic });
      }
      await sql.query(
        `UPDATE agent_reconciliation_state SET last_error = $3
         WHERE owner_id = $1 AND agent_id = $2`, [ownerId, agentId, diagnostic],
      );
    }
  }));
  return { inspected: candidates.length, succeeded, failed };
}
