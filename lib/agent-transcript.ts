import type { AgentArtifact, AgentArtifactKind, AgentMessage } from "@/lib/types";

export interface AgentEventRow {
  id: string;
  event_type: string;
  payload: unknown;
  created_at: string | Date;
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
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0
    ) {
      return [];
    }
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
    const artifacts = projectArtifacts(payload.artifacts);
    if (!text && artifacts.length === 0) continue;
    const message: AgentMessage = {
      id: row.id,
      requestId,
      role: row.event_type === "message.user" ? "user" : "assistant",
      text,
      artifacts,
      failed: false,
      createdAt: new Date(row.created_at).toISOString(),
    };
    messages.push(message);
    if (message.role === "user") requests.set(requestId, message);
  }

  return messages;
}
