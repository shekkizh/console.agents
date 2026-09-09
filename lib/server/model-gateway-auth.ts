import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";
import { verifyAgentMessageToken } from "@/lib/server/message-auth";
import { MODEL_REQUEST_LIMIT } from "@/lib/server/model-gateway";

export async function authorizeModelRequest(token: string, consumeRequest: boolean): Promise<{ model: string } | undefined> {
  const claims = verifyAgentMessageToken(token);
  if (!claims?.incomingMessageId || claims.lifecycle === true) return;
  const sql = neon(requireDatabaseUrl());
  // One atomic statement prevents concurrent native subagents bypassing the budget.
  const rows = await sql.query(
    `UPDATE message_deliveries delivery
     SET model_request_count = model_request_count + $5
     FROM conversation_messages message, agents agent
     WHERE delivery.owner_id = $1 AND delivery.message_id = $2
       AND delivery.recipient_type = 'agent' AND delivery.recipient_id = $3
       AND delivery.state IN ('claimed', 'running')
       AND delivery.model_request_count < $6
       AND message.owner_id = delivery.owner_id AND message.id = delivery.message_id
       AND message.conversation_id = $4
       AND agent.owner_id = delivery.owner_id AND agent.id = delivery.recipient_id
       AND agent.enabled = true
     RETURNING agent.fx_config->>'model' AS model`,
    [claims.ownerId, claims.incomingMessageId, claims.agentId, claims.conversationId,
      consumeRequest ? 1 : 0, MODEL_REQUEST_LIMIT],
  );
  const row = rows[0] as { model?: string } | undefined;
  return row?.model ? { model: row.model } : undefined;
}
