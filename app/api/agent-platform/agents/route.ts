import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgentPlatformIdentity } from "@/lib/server/agent-platform-auth";
import { createManagedAgentDefinition } from "@/lib/server/gemini";
import { createAgent, findAgentByName, listAgents } from "@/lib/server/store";

const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(60),
  specialty: z.string().trim().min(2).max(100),
  instructions: z.string().trim().min(8).max(12_000),
});

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Agent platform request failed";
  return NextResponse.json({ success: false, error: message }, { status: message.startsWith("Unauthorized") ? 401 : 400 });
}

export async function GET(request: Request) {
  try {
    const { ownerId, agentId } = await requireAgentPlatformIdentity(request);
    return NextResponse.json({ success: true, actor_agent_id: agentId, agents: await listAgents(ownerId) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { ownerId, agentId: actorAgentId } = await requireAgentPlatformIdentity(request);
    const input = createAgentSchema.parse(await request.json());
    const existing = await findAgentByName(ownerId, input.name);
    if (existing) return NextResponse.json({ success: true, created: false, actor_agent_id: actorAgentId, agent: existing });

    const id = `console-${crypto.randomUUID()}`;
    await createManagedAgentDefinition(ownerId, id, input);
    const agent = await createAgent(ownerId, id, input);
    return NextResponse.json({ success: true, created: true, actor_agent_id: actorAgentId, agent }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
