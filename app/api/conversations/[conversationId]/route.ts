import { after, NextResponse } from "next/server";
import { stopConversationWorkers } from "@/lib/server/lifecycle-actions";
import { requireOwner } from "@/lib/server/auth";
import {
  deleteConversation,
  getConversation,
  listConversationActivity,
  listConversationMessages,
} from "@/lib/server/conversation-store";
import { reconcileAgentTasks } from "@/lib/server/reconciler";

export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    const conversation = await getConversation(ownerId, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    // Ordinary status reads never acquire a sandbox or dispatch work.
    if (conversation.status === "working" && new URL(request.url).searchParams.get("recover") === "1") {
      after(() => reconcileAgentTasks({ ownerId, conversationId })
        .catch((error) => console.error("agent-task.recovery.failed", { conversationId, error })));
    }
    return NextResponse.json({
      conversation,
      messages: await listConversationMessages(ownerId, conversationId),
      activity: await listConversationActivity(ownerId, conversationId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load conversation";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    await stopConversationWorkers(ownerId, conversationId, () => deleteConversation(ownerId, conversationId));
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete conversation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Conversation not found" ? 404 : 400 },
    );
  }
}
