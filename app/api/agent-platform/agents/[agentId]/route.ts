import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERAL_AGENT_ID } from "@/lib/general-agent";
import { requireAgentPlatformIdentity } from "@/lib/server/agent-platform-auth";
import { getAgent, updateAgent } from "@/lib/server/store";

const updateAgentSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  specialty: z.string().trim().min(2).max(100).optional(),
  instructions: z.string().trim().min(8).max(12_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

function failure(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Agent platform request failed";
  return NextResponse.json({ success: false, error: message }, { status: message.startsWith("Unauthorized") ? 401 : status });
}

export async function GET(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { ownerId, agentId: actorAgentId } = await requireAgentPlatformIdentity(request);
    const { agentId } = await context.params;
    const agent = await getAgent(ownerId, agentId);
    if (!agent) return failure(new Error("Agent not found"), 404);
    return NextResponse.json({ success: true, actor_agent_id: actorAgentId, agent });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const { ownerId, agentId: actorAgentId } = await requireAgentPlatformIdentity(request);
    const { agentId } = await context.params;
    if (actorAgentId !== GENERAL_AGENT_ID && actorAgentId !== agentId) {
      return failure(new Error("Only General or the agent itself can update this profile"), 403);
    }
    const input = updateAgentSchema.parse(await request.json());
    const agent = await updateAgent(ownerId, agentId, input);
    return NextResponse.json({ success: true, actor_agent_id: actorAgentId, agent });
  } catch (error) {
    return failure(error);
  }
}
