import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalFxCapabilitiesSchema, optionalFxNetworkSchema } from "@/lib/agent-capabilities";
import { requireOwner } from "@/lib/server/auth";
import { createAgent, findAgentByName, listAgents } from "@/lib/server/agent-store";

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  specialty: z.string().trim().min(2).max(160),
  instructions: z.string().trim().min(8).max(20_000),
  model: z.string().trim().min(3).max(200).optional(),
  maxSteps: z.number().int().min(1).max(128).optional(),
  ...optionalFxNetworkSchema,
  ...optionalFxCapabilitiesSchema,
});

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Agent request failed";
  const status = message === "Unauthorized" ? 401 : message.includes("already") ? 409 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  try {
    return NextResponse.json({ agents: await listAgents(await requireOwner()) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const input = createSchema.parse(await request.json());
    if (await findAgentByName(ownerId, input.name)) {
      throw new Error("An agent with that name already exists");
    }
    return NextResponse.json(await createAgent(ownerId, input), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
