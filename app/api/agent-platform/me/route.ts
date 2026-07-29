import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERAL_AGENT_ID } from "@/lib/general-agent";
import { requireAgentPlatformIdentity } from "@/lib/server/agent-platform-auth";
import { getAgent, updateAgent } from "@/lib/server/store";

const updateSelfSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  specialty: z.string().trim().min(2).max(100).optional(),
  instructions: z.string().trim().min(8).max(12_000).optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

function failure(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Agent platform request failed";
  return NextResponse.json({ success: false, error: message }, { status: message.startsWith("Unauthorized") ? 401 : status });
}

export async function GET(request: Request) {
  try {
    const { ownerId, agentId } = await requireAgentPlatformIdentity(request);
    const agent = await getAgent(ownerId, agentId);
    if (!agent) return failure(new Error("Agent not found"), 404);
    return NextResponse.json({
      success: true,
      agent,
      profile_editable: agentId !== GENERAL_AGENT_ID,
      local_state: [".agents/AGENTS.md", ".agents/skills/", "memory/"],
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { ownerId, agentId } = await requireAgentPlatformIdentity(request);
    if (agentId === GENERAL_AGENT_ID) {
      return failure(new Error("General is built in; update .agents/AGENTS.md in the managed environment instead"), 409);
    }
    const input = updateSelfSchema.parse(await request.json());
    return NextResponse.json({ success: true, agent: await updateAgent(ownerId, agentId, input) });
  } catch (error) {
    return failure(error);
  }
}
