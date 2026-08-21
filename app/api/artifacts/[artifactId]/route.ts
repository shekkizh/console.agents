import { getAgentArtifactContent } from "@/lib/server/artifact-store";
import { requireOwner } from "@/lib/server/auth";

function inlineFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { artifactId } = await context.params;
    const artifact = await getAgentArtifactContent(ownerId, artifactId);
    if (!artifact) return new Response("Preview not found", { status: 404 });
    const body = new Uint8Array(artifact.content).buffer;
    return new Response(body, {
      headers: {
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${inlineFilename(artifact.name)}"`,
        "Content-Length": String(artifact.size),
        "Content-Security-Policy": "frame-ancestors 'self'",
        "Content-Type": artifact.mediaType,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load preview";
    return new Response(message, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
