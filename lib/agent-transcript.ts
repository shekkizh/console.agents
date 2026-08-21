import type { AgentMessage } from "@/lib/types";

export interface AgentEventRow {
  id: string;
  event_type: string;
  payload: unknown;
  created_at: string | Date;
}

export function projectAgentTranscript(rows: readonly AgentEventRow[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const requests = new Map<string, AgentMessage>();

  for (const row of rows) {
    const payload =
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : row.id;

    if (row.event_type === "message.failed") {
      const request = requests.get(requestId);
      if (request) request.failed = true;
      continue;
    }

    const text = typeof payload.message === "string" ? payload.message : "";
    if (!text) continue;
    const message: AgentMessage = {
      id: row.id,
      requestId,
      role: row.event_type === "message.user" ? "user" : "assistant",
      text,
      failed: false,
      createdAt: new Date(row.created_at).toISOString(),
    };
    messages.push(message);
    if (message.role === "user") requests.set(requestId, message);
  }

  return messages;
}
