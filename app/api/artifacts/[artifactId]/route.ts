import { NextResponse } from "next/server";
import { readAgentArtifactFile } from "@/lib/server/agent-sandbox";
import { requireOwner } from "@/lib/server/auth";
import { getArtifactForOwner } from "@/lib/server/channel-store";

export const maxDuration = 60;

/**
 * Streams the bytes of a file an agent shared with `share_artifact` straight out of its
 * persistent sandbox. Scoped to the authenticated owner and the artifact row they own; the
 * sandbox path is validated server-side (see `readAgentArtifactFile`) so a tampered id can't
 * read outside the agent's workspace.
 */
export async function GET(request: Request, context: { params: Promise<{ artifactId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { artifactId } = await context.params;
    const artifact = await getArtifactForOwner(ownerId, artifactId);
    if (!artifact) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });

    const bytes = await readAgentArtifactFile(ownerId, artifact.agentId, artifact.sandboxPath);
    if (!bytes) {
      return NextResponse.json({ error: "This file is no longer available in the agent's workspace" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": artifact.mimeType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(artifact.name)}"`,
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load artifact";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
