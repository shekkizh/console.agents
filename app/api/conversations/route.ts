import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { createConversation, listConversations } from "@/lib/server/conversation-store";

const createSchema = z.object({ agentId: z.string().trim().min(1) });

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Conversation request failed";
  const status = message === "Unauthorized" ? 401 : message === "Agent not found" ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  try {
    return NextResponse.json({ conversations: await listConversations(await requireOwner()) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const { agentId } = createSchema.parse(await request.json());
    return NextResponse.json(await createConversation(ownerId, agentId), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
