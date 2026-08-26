import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";
import type { AgentArtifactKind } from "@/lib/types";

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
     FROM message_artifacts
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
