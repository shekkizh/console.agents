import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { stopConversation } from "@/lib/server/conversation-store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    return NextResponse.json(await stopConversation(ownerId, conversationId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to stop conversation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Conversation not found" ? 404 : 400 },
    );
  }
}
