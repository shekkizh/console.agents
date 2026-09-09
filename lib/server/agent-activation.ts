import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentMessageClaims } from "@/lib/server/message-auth";

// A delivery is activated once; retries are new messages with new tokens.
export async function isAgentActivationActive(claims: Pick<AgentMessageClaims,
  "ownerId" | "agentId" | "conversationId" | "incomingMessageId"
>): Promise<boolean> {
  if (!claims.incomingMessageId) return false;
  const rows = await neon(requireDatabaseUrl()).query(
    `SELECT 1 FROM message_deliveries d
     JOIN conversation_messages m ON m.owner_id = d.owner_id AND m.id = d.message_id
     JOIN agents a ON a.owner_id = d.owner_id AND a.id = d.recipient_id
     WHERE d.owner_id = $1 AND d.recipient_id = $2 AND d.message_id = $3
       AND m.conversation_id = $4 AND d.recipient_type = 'agent'
       AND d.state IN ('claimed', 'running') AND a.enabled
     LIMIT 1`,
    [claims.ownerId, claims.agentId, claims.incomingMessageId, claims.conversationId],
  );
  return rows.length > 0;
}
