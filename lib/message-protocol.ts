export type MessagePurpose = "request" | "reply" | "progress" | "receipt";

interface MessageEnvelope {
  senderType: string;
  senderId: string;
  kind?: string;
  inReplyTo?: string | null;
  metadata?: Record<string, unknown>;
}

// Infer old envelopes too: deployment must stop loops already in the inbox.
export function messagePurpose(message: MessageEnvelope): MessagePurpose {
  if (message.senderType === "human") return "request";
  const metadata = message.metadata ?? {};
  if (metadata.messagePurpose === "receipt") return "receipt";
  if (metadata.activity === "progress" || metadata.messagePurpose === "progress") return "progress";
  if (message.inReplyTo != null || message.kind === "error" || metadata.activity === "completion" || metadata.messagePurpose === "reply") return "reply";
  return "request";
}

// Keep database selection consistent with the runtime, including legacy rows.
export function messagePurposeSql(alias: string): string {
  if (!/^[a-z][a-z_]*$/.test(alias)) throw new Error("Invalid SQL alias");
  return `(CASE
    WHEN ${alias}.sender_type = 'human' THEN 'request'
    WHEN ${alias}.metadata->>'messagePurpose' = 'receipt' THEN 'receipt'
    WHEN ${alias}.metadata->>'activity' = 'progress' OR ${alias}.metadata->>'messagePurpose' = 'progress' THEN 'progress'
    WHEN ${alias}.in_reply_to IS NOT NULL OR ${alias}.kind = 'error'
      OR ${alias}.metadata->>'activity' = 'completion' OR ${alias}.metadata->>'messagePurpose' = 'reply' THEN 'reply'
    ELSE 'request' END)`;
}

export function completionDestination(message: MessageEnvelope, ownerId: string, agentId: string) {
  if (messagePurpose(message) !== "request") {
    // A receipt records output, artifacts and session continuity without sending
    // another peer message. It is created already consumed and cannot wake FX.
    return { recipientType: "agent" as const, recipientId: agentId, messagePurpose: "receipt" as const };
  }
  return {
    recipientType: message.senderType === "agent" ? "agent" as const : "human" as const,
    recipientId: message.senderType === "agent" ? message.senderId : ownerId,
    messagePurpose: "reply" as const,
  };
}
