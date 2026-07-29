import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { createManagedAgentDefinition } from "@/lib/server/gemini";
import { agentNameExists, createAgent } from "@/lib/server/store";

const createAgentSchema = z.object({
  name: z.string().trim().min(2).max(60),
  specialty: z.string().trim().min(2).max(100),
  instructions: z.string().trim().min(8).max(12_000),
});

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const input = createAgentSchema.parse(await request.json());
    if (await agentNameExists(ownerId, input.name)) {
      return NextResponse.json({ error: "You already have an agent with that name" }, { status: 409 });
    }
    const id = `console-${crypto.randomUUID()}`;
    await createManagedAgentDefinition(ownerId, id, input);
    return NextResponse.json(await createAgent(ownerId, id, input), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create agent";
    const duplicate = message.includes("agents_owner_id_name_key");
    return NextResponse.json(
      { error: duplicate ? "You already have an agent with that name" : message },
      { status: message === "Unauthorized" ? 401 : duplicate ? 409 : 400 },
    );
  }
}
