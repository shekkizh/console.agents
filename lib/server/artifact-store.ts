import { neon } from "@neondatabase/serverless";
import type { CapturedArtifact } from "@/lib/server/artifact-capture";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentArtifact, AgentArtifactKind } from "@/lib/types";

interface ArtifactContentRow {
  filename: string;
  media_type: string;
  kind: AgentArtifactKind;
  size_bytes: number;
  content: unknown;
}

function database() {
  return neon(requireDatabaseUrl());
}

function bytea(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  }
  throw new Error("Artifact content is unavailable");
}

export async function storeAgentArtifacts(input: {
  ownerId: string;
  agentId: string;
  conversationId: string;
  requestId: string;
  artifacts: readonly CapturedArtifact[];
}): Promise<AgentArtifact[]> {
  const stored: AgentArtifact[] = [];
  const sql = database();
  for (const artifact of input.artifacts) {
    const rows = await sql.query(
      `INSERT INTO agent_artifacts
         (owner_id, agent_id, conversation_id, request_id, sandbox_path,
          filename, title, media_type, kind, size_bytes, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, decode($11, 'base64'))
       ON CONFLICT (owner_id, conversation_id, request_id, sandbox_path)
       DO UPDATE SET filename = EXCLUDED.filename, title = EXCLUDED.title,
         media_type = EXCLUDED.media_type, kind = EXCLUDED.kind,
         size_bytes = EXCLUDED.size_bytes, content = EXCLUDED.content
       RETURNING id, filename, title, media_type, kind, size_bytes`,
      [
        input.ownerId,
        input.agentId,
        input.conversationId,
        input.requestId,
        artifact.path,
        artifact.name,
        artifact.title,
        artifact.mediaType,
        artifact.kind,
        artifact.content.byteLength,
        Buffer.from(artifact.content).toString("base64"),
      ],
    );
    const row = rows[0] as {
      id: string;
      filename: string;
      title: string;
      media_type: string;
      kind: AgentArtifactKind;
      size_bytes: number;
    };
    stored.push({
      id: row.id,
      name: row.filename,
      title: row.title,
      mediaType: row.media_type,
      kind: row.kind,
      size: Number(row.size_bytes),
    });
  }
  return stored;
}

export async function getAgentArtifactContent(
  ownerId: string,
  artifactId: string,
): Promise<{
  name: string;
  mediaType: string;
  kind: AgentArtifactKind;
  size: number;
  content: Uint8Array;
} | undefined> {
  const rows = await database().query(
    `SELECT filename, media_type, kind, size_bytes, content
     FROM agent_artifacts
     WHERE owner_id = $1 AND id = $2
     LIMIT 1`,
    [ownerId, artifactId],
  );
  const row = rows[0] as ArtifactContentRow | undefined;
  if (!row) return;
  return {
    name: row.filename,
    mediaType: row.media_type,
    kind: row.kind,
    size: Number(row.size_bytes),
    content: bytea(row.content),
  };
}
