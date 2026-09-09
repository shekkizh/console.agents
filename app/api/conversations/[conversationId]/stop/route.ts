import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { stopConversationWorkers } from "@/lib/server/lifecycle-actions";

export const maxDuration = 300;

export async function POST(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    const result = await stopConversationWorkers(ownerId, conversationId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to stop conversation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Conversation not found" ? 404 : 400 },
    );
  }
}
