import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { resetAgentSession } from "@/lib/server/agent-store";

const resetSchema = z.object({
  expectedSessionId: z.string().trim().min(1).max(200),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { agentId } = await context.params;
    const { expectedSessionId } = resetSchema.parse(await request.json());
    return NextResponse.json(await resetAgentSession(ownerId, agentId, expectedSessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to recover agent session";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Agent not found" ? 404 : 400 },
    );
  }
}
