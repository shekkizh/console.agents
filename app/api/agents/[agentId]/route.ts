import { NextResponse } from "next/server";
import { z } from "zod";
import { optionalFxCapabilitiesSchema, optionalFxNetworkSchema } from "@/lib/agent-capabilities";
import { requireOwner } from "@/lib/server/auth";
import { deleteAgent, listAgentMessages, updateAgent } from "@/lib/server/agent-store";

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    specialty: z.string().trim().min(2).max(160).optional(),
    instructions: z.string().trim().min(8).max(20_000).optional(),
    model: z.string().trim().min(3).max(200).optional(),
    maxSteps: z.number().int().min(1).max(128).optional(),
    ...optionalFxNetworkSchema,
    ...optionalFxCapabilitiesSchema,
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field");

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { agentId } = await context.params;
    return NextResponse.json({ messages: await listAgentMessages(ownerId, agentId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load agent messages";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { agentId } = await context.params;
    const input = updateSchema.parse(await request.json());
    return NextResponse.json(
      await updateAgent(ownerId, agentId, input, { type: "human", id: ownerId }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update agent";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Agent not found" ? 404 : 400 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { agentId } = await context.params;
    return NextResponse.json(await deleteAgent(ownerId, agentId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete agent";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Agent not found" ? 404 : 400 },
    );
  }
}
